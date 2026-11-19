import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CoreClient, CoreError, type CoreTerminal, localAddress, parseTerminal } from "./core.js";
import { terminalText } from "./terminal-text.js";

export interface Job {
  id: string;
  scope: string;
  terminal?: string;
  state: "starting" | "running" | "uncertain" | "cancelled" | "succeeded" | "failed";
  result?: string;
  resultPath?: string;
  omissions: string[];
}
const active = (j: Job) => ["starting", "running", "uncertain"].includes(j.state);
interface Run {
  job: Job;
  cancel: boolean;
  done: Promise<void>;
}
/** Direct children only. Identity is scoped to this live parent; never adopt old runs. */
export class Workers {
  private readonly runs = new Map<string, Run>();
  private closed = false;
  constructor(
    private readonly socket: string,
    private readonly parent: string,
    private readonly agentDir: string,
    private readonly owns: (scope: string) => boolean,
    private readonly completed: (job: Job) => void,
  ) {
    localAddress(parent);
  }
  list(scope: string) {
    return [...this.runs.values()].filter((r) => r.job.scope === scope).map((r) => ({ ...r.job }));
  }
  count(scope: string) {
    return this.list(scope).filter(active).length;
  }
  private get(id: string, scope: string) {
    const r = this.runs.get(id);
    if (!r || r.job.scope !== scope) throw new Error("Unknown worker in current scope");
    return r;
  }
  async wait(id: string, scope: string, timeout: number, signal?: AbortSignal) {
    const r = this.get(id, scope);
    const stop = new AbortController();
    try {
      await Promise.race([
        r.done,
        delay(timeout, undefined, { signal: signal ? AbortSignal.any([signal, stop.signal]) : stop.signal }),
      ]);
    } finally {
      stop.abort();
    }
    return { ...r.job };
  }
  async finish(id: string, scope: string) {
    const run = this.get(id, scope);
    await run.done;
    return { ...run.job };
  }
  async cancel(id: string, scope: string) {
    this.get(id, scope).cancel = true;
    return this.wait(id, scope, 16000);
  }
  revoke(scope: string) {
    for (const r of this.runs.values()) if (r.job.scope === scope) r.cancel = true;
  }
  async dispose() {
    this.closed = true;
    for (const r of this.runs.values()) r.cancel = true;
    await Promise.all([...this.runs.values()].map((r) => r.done));
  }
  async launch(
    scope: string,
    cwd: string,
    prepare: (directory: string) => Promise<{ argv: string[]; omissions: string[] }>,
    signal?: AbortSignal,
    enqueueResult = true,
  ) {
    if (this.closed || !this.owns(scope)) throw new Error("Worker scope revoked");
    if ([...this.runs.values()].filter((r) => active(r.job)).length >= 4)
      throw new Error("Four workers are already active or unconfirmed");
    const id = randomUUID();
    const directory = join(this.agentDir, "pi-herdr-core", "workers", id);
    const job: Job = { id, scope, state: "starting", omissions: [] };
    const accepted = Promise.withResolvers<Job>();
    const r: Run = { job, cancel: false, done: Promise.resolve() };
    this.runs.set(id, r);
    const cancelled = () => r.cancel || this.closed || !this.owns(scope) || signal?.aborted;
    r.done = (async () => {
      const deadline = Date.now() + 600000;
      let dispatched = false;
      let acknowledged = false;
      try {
        const { argv, omissions } = await prepare(directory);
        job.omissions = omissions;
        const parent = await new CoreClient(this.socket).call("terminal.get", { terminal: this.parent });
        const identity = parseTerminal(parent.result);
        if (identity.state !== "live" || identity.address !== this.parent) throw new Error("Core parent is not live");
        const client = new CoreClient(this.socket, parent.core.id);
        if (cancelled()) throw new Error("Worker scope revoked before launch");
        const labels = { "pi-herdr-core-job": id };
        let allocation: CoreTerminal | undefined;
        const owned = (t: CoreTerminal) =>
          t.parent === this.parent &&
          t.labels["pi-herdr-core-job"] === id &&
          JSON.stringify(t.argv) === JSON.stringify(argv) &&
          !t.keep &&
          !t.rm &&
          !t.notify &&
          (!allocation || (t.address === allocation.address && t.created_ms === allocation.created_ms));
        try {
          const response = await client.call("terminal.run", {
            argv,
            cwd,
            parent: this.parent,
            caller: this.parent,
            labels,
            no_notify: true,
            keep: false,
            rm: false,
            outlive_parent: false,
            wait: false,
            env: { PI_HERDR_WORKER_DIR: directory, PI_CODING_AGENT_DIR: this.agentDir, PATH: process.env.PATH },
          });
          dispatched = true;
          const t = parseTerminal(response.result);
          if (!owned(t)) throw new Error("Unexpected worker allocation");
          allocation = t;
        } catch (e) {
          if (!dispatched && !(e instanceof CoreError && e.dispatched)) throw e;
          dispatched = true;
        }
        job.state = allocation ? "running" : "uncertain";
        job.terminal = allocation?.address;
        accepted.resolve({ ...job });
        acknowledged = true;
        let startupReported = false;
        for (;;) {
          try {
            if (!allocation) {
              const result = (await client.call("terminal.list", { labels, all: true })).result as {
                terminals: unknown[];
              };
              const matches = result.terminals.map(parseTerminal).filter(owned);
              if (matches.length !== 1) throw new Error("Allocation not confirmed");
              allocation = matches[0];
              job.terminal = allocation.address;
            }
            let t = parseTerminal((await client.call("terminal.get", { terminal: allocation.address })).result);
            if (!owned(t)) throw new Error("Worker identity changed");
            if (t.state === "live" && (cancelled() || Date.now() >= deadline)) {
              r.cancel = true;
              t = parseTerminal((await client.call("terminal.kill", { terminal: t.address })).result);
              if (!owned(t)) throw new Error("Unconfirmed termination");
            }
            if (t.state === "finished") {
              if (cancelled()) {
                job.state = "cancelled";
                job.result = "Worker cancelled";
              } else {
                try {
                  const path = join(directory, "answer.json");
                  const answer = JSON.parse(await readFile(path, "utf8"));
                  if (typeof answer.text !== "string") throw new Error();
                  const ok = answer.ok === true && t.exit_code === 0;
                  job.resultPath = path;
                  if (Array.isArray(answer.omissions))
                    job.omissions = answer.omissions.filter((s: unknown) => typeof s === "string");
                  job.result =
                    answer.ok && !ok
                      ? "Pi exited abnormally after settlement."
                      : terminalText(answer.text.slice(0, 1500)) +
                        (answer.text.length > 1500 ? "\n[Truncated; see full result.]" : "");
                  job.state = cancelled() ? "cancelled" : ok ? "succeeded" : "failed";
                } catch {
                  job.state = "failed";
                  job.result = "Pi exited without a settled result. Inspect the retained terminal.";
                }
              }
              break;
            }
            if (!startupReported) {
              try {
                const omissions = JSON.parse(await readFile(join(directory, "omissions.json"), "utf8"));
                if (Array.isArray(omissions) && omissions.every((s) => typeof s === "string")) {
                  job.omissions = omissions;
                  startupReported = true;
                }
              } catch {
                /* The guard has not finished narrowing yet. */
              }
            }
            job.state = "running";
          } catch {
            job.state = "uncertain";
            if (this.closed || Date.now() > deadline + 16000) break;
          }
          await delay(400);
        }
      } catch (e) {
        job.state = dispatched ? "uncertain" : "failed";
        job.result = terminalText(String(e));
        if (!acknowledged) accepted.reject(e);
      }
      if (enqueueResult && acknowledged && !this.closed && this.owns(scope)) this.completed({ ...job });
    })();
    return accepted.promise;
  }
}
