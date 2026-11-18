import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { verifySourceFiles } from "./capabilities.js";
import { type ControlEndpoint, type ControlPeer, createControlEndpoint } from "./control.js";
import {
  CoreClient,
  CoreError,
  launchParameters,
  localAddress,
  parseTerminal,
  removable,
  sameAllocation,
} from "./core.js";
import { type ChildSnapshot, verifyConfiguration } from "./snapshot.js";
import { type JobResult, JobStore, type StoredJob } from "./store.js";
import { JobTree, terminalState } from "./tree.js";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
interface LiveJob {
  record: StoredJob;
  snapshot: ChildSnapshot;
  endpoint?: ControlEndpoint;
  peer?: ControlPeer;
  result?: JobResult;
  ready: boolean;
  allocationDone: boolean;
  finalizing: boolean;
  notified?: boolean;
  reportedChildren: Set<string>;
}
export interface SupervisorOptions {
  session: string;
  agentDir: string;
  parentTerminal: string;
  coreSocket: string;
  bootstrap?: string;
  /** Synchronous current owner/policy check; never ask whichever session is active later. */
  current(scope: string): boolean;
  completed?(job: StoredJob, result: JobResult): void;
}

/** One supervisor owns every descendant and every shared budget in this root session. */
export class Supervisor {
  readonly root = randomUUID();
  readonly tree = new JobTree(this.root);
  readonly store: JobStore;
  private readonly jobs = new Map<string, LiveJob>();
  private readonly cancelling = new Map<string, Promise<void>>();
  private core: CoreClient;
  private coreId?: string;
  private disposed = false;
  private readonly deadlineTimer: ReturnType<typeof setInterval>;
  constructor(private readonly options: SupervisorOptions) {
    localAddress(options.parentTerminal);
    this.core = new CoreClient(options.coreSocket);
    this.store = new JobStore(options.agentDir);
    this.deadlineTimer = setInterval(() => {
      for (const id of this.tree.expired()) void this.cancel(this.root, id).catch(() => {});
    }, 1000);
    this.deadlineTimer.unref();
  }
  private current(scope: string): void {
    if (this.disposed || !this.options.current(scope))
      throw new Error("Delegation owner or permission scope was revoked.");
  }
  private live(id: string): LiveJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Job does not belong to this live supervisor. Historical records are query-only.");
    return job;
  }
  private async save(job: LiveJob): Promise<void> {
    job.record = { ...job.record, ...this.tree.get(job.record.id) };
    await this.store.save(job.record);
  }
  private async initializeCore(): Promise<void> {
    const response = await this.core.call("terminal.get", { terminal: this.options.parentTerminal });
    const parent = parseTerminal(response.result);
    if (parent.state !== "live") throw new Error("The parent Core terminal is not live.");
    if (this.coreId && this.coreId !== response.core.id) throw new Error("Core identity changed.");
    this.coreId = response.core.id;
    this.core = new CoreClient(this.options.coreSocket, this.coreId);
  }
  async launch(
    input: {
      task: string;
      snapshot: ChildSnapshot;
      group: string;
      scope: string;
      activeTools?: string[];
      callableTools?: string[];
    },
    caller: string = this.root,
  ): Promise<StoredJob> {
    this.current(input.scope);
    if (
      [...this.jobs.values()].some((job) => job.allocationDone && !job.record.allocation && !job.record.stopConfirmed)
    )
      throw new Error(
        "An earlier allocation remains uncertain. Reconcile/cancel that attempt before another launch; do not retry the task.",
      );
    const parent = caller === this.root ? undefined : this.live(caller);
    const snapshot = structuredClone(parent ? parent.snapshot : input.snapshot);
    if (parent && input.activeTools && input.callableTools) {
      const active = new Set(input.activeTools);
      const callable = new Set(input.callableTools);
      snapshot.capabilities.tools = snapshot.capabilities.tools
        .filter((tool) => active.has(tool.name) || (tool.callable && callable.has(tool.name)))
        .map((tool) => ({
          ...tool,
          active: tool.active && active.has(tool.name),
          callable: tool.callable && callable.has(tool.name),
        }));
      const paths = new Set(snapshot.capabilities.tools.map((tool) => tool.path));
      snapshot.capabilities.files = snapshot.capabilities.files.filter((file) => paths.has(file.path));
      snapshot.capabilities.builtins = snapshot.capabilities.builtins.filter((path) => paths.has(path));
      snapshot.mcp = snapshot.mcp.filter((server) =>
        snapshot.capabilities.tools.some(
          (tool) =>
            tool.namespace === `mcp__${server.name.replaceAll("-", "_")}` ||
            tool.name.startsWith(`mcp__${server.name.replaceAll("-", "_")}__`) ||
            ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(tool.name),
        ),
      );
    }
    const scope = parent?.record.scope ?? input.scope;
    this.current(scope);
    await verifySourceFiles(snapshot.capabilities);
    await verifyConfiguration(snapshot);
    this.current(scope);
    const bootstrap = this.options.bootstrap ?? fileURLToPath(new URL("../dist/child-entry.js", import.meta.url));
    // src/supervisor.ts and dist/supervisor.js both resolve the package's dist child.
    await access(bootstrap);
    await this.initializeCore();
    this.current(scope);
    const record = this.tree.reserve({ caller, group: input.group, scope, task: input.task });
    const job: LiveJob = {
      record: {
        ...record,
        ownerSession: this.options.session,
        model: { provider: snapshot.model.provider, id: snapshot.model.id },
        thinking: snapshot.thinking,
        capabilities: structuredClone(snapshot.capabilities),
        stopConfirmed: false,
      },
      snapshot,
      reportedChildren: new Set(),
      ready: false,
      allocationDone: false,
      finalizing: false,
    };
    this.jobs.set(record.id, job);
    try {
      // Persist launch intent before creating even the private endpoint, let alone a terminal.
      await this.save(job);
      this.current(scope);
      job.endpoint = await createControlEndpoint(record.id, record.attempt);
      void job.endpoint.connected
        .then((peer) => {
          job.peer = peer;
          peer.onRequest((method, data) => this.handle(job, method, data));
          peer.onClose(() => {
            const state = this.tree.get(record.id).state;
            if (!job.result && state !== "cancelling" && !terminalState(state) && !this.disposed)
              job.record.outcome = "missing-result";
            if (!terminalState(state) && !this.disposed) void this.cancel(this.root, record.id).catch(() => {});
            else void this.confirmExit(job).catch(() => {});
          });
        })
        .catch(() => {});
      this.current(scope);
      const params = launchParameters({
        node: process.execPath,
        bootstrap,
        cwd: snapshot.cwd,
        parent: localAddress(parent?.record.terminal ?? this.options.parentTerminal),
        root: this.root,
        job: record.id,
        attempt: record.attempt,
        controlSocket: job.endpoint.socket,
      });
      params.env = { PI_HERDR_CREDENTIAL_FILE: job.endpoint.credentialFile };
      try {
        const allocated = await this.core.call("terminal.run", params);
        const terminal = parseTerminal(allocated.result);
        if (
          terminal.parent !== (parent?.record.terminal ?? this.options.parentTerminal) ||
          terminal.keep ||
          terminal.rm ||
          terminal.notify ||
          terminal.labels["pi-herdr-core-job"] !== record.id ||
          terminal.labels["pi-herdr-core-attempt"] !== record.attempt
        )
          throw new CoreError("Core allocation identity does not match intent.", true);
        this.tree.allocate(record.id, record.attempt, allocated.core.id, terminal.address);
        job.record.allocation = terminal;
        await this.save(job);
      } catch (error) {
        if (error instanceof CoreError && error.dispatched) {
          this.tree.uncertain(record.id);
          await this.save(job);
          await this.reconcile(job);
        } else throw error;
      } finally {
        job.allocationDone = true;
      }
      this.current(scope);
      const readyDeadline = Math.min(record.deadline, Date.now() + 30_000);
      while (!job.ready) {
        this.current(scope);
        if (Date.now() >= readyDeadline || terminalState(this.tree.get(record.id).state))
          throw new Error("Child initialization acknowledgement missing.");
        await delay(25);
      }
      this.current(scope);
      return structuredClone(job.record);
    } catch {
      job.record.diagnostic =
        "Launch did not complete. Any acquired or uncertain attempt is being cancelled; no duplicate dispatch was attempted.";
      job.allocationDone = true;
      await this.cancel(this.root, record.id).catch(() => {});
      await this.save(job).catch(() => {});
      throw new Error(`Subagent ${record.id} launch failed; query its retained record for cancellation certainty.`);
    }
  }
  private async reconcile(job: LiveJob): Promise<void> {
    const response = await this.core.call("terminal.list", {
      all: true,
      labels: {
        "pi-herdr-core-root": this.root,
        "pi-herdr-core-job": job.record.id,
        "pi-herdr-core-attempt": job.record.attempt,
      },
    });
    if (!object(response.result) || !Array.isArray(response.result.terminals))
      throw new Error("Invalid Core reconciliation response.");
    const candidates = response.result.terminals.map(parseTerminal);
    if (candidates.length !== 1) throw new Error("Allocation remains uncertain; no relaunch is permitted.");
    const terminal = candidates[0];
    const parent =
      job.record.parent === this.root ? this.options.parentTerminal : this.live(job.record.parent).record.terminal;
    if (
      terminal.parent !== parent ||
      terminal.labels["pi-herdr-core-root"] !== this.root ||
      terminal.labels["pi-herdr-core-job"] !== job.record.id ||
      terminal.labels["pi-herdr-core-attempt"] !== job.record.attempt
    )
      throw new Error("Uncertain allocation ownership cannot be established.");
    this.tree.allocate(job.record.id, job.record.attempt, response.core.id, terminal.address);
    job.record.allocation = terminal;
    await this.save(job);
  }
  private async handle(job: LiveJob, method: string, data: unknown): Promise<unknown> {
    const id = job.record.id;
    if (method === "assignment") {
      this.current(job.record.scope);
      return {
        snapshot: job.snapshot,
        task: job.record.task,
        directory: this.store.jobDirectory(id),
        deadline: job.record.deadline,
      };
    }
    if (method === "ready") {
      while (!job.allocationDone) {
        this.current(job.record.scope);
        await delay(25);
      }
      this.current(job.record.scope);
      if (!object(data) || data.terminal !== this.tree.get(id).terminal || typeof data.transcript !== "string")
        throw new Error("Child terminal identity mismatch.");
      await verifySourceFiles(job.snapshot.capabilities);
      await verifyConfiguration(job.snapshot);
      this.current(job.record.scope);
      this.tree.acknowledge(id, job.record.attempt);
      job.record.transcript = data.transcript;
      await this.save(job);
      this.current(job.record.scope);
      job.ready = true;
      return { dispatch: true };
    }
    if (method === "charge") {
      this.current(job.record.scope);
      if (!object(data) || !["turn", "call"].includes(String(data.kind))) throw new Error("Invalid budget charge.");
      this.tree.charge(id, data.kind as "turn" | "call");
      await this.save(job);
      this.current(job.record.scope);
      return { accepted: true };
    }
    if (method === "settled") return this.settle(job, data);
    if (!object(data)) throw new Error("Invalid descendant request.");
    this.current(job.record.scope);
    if (method === "launch" && typeof data.task === "string") {
      const names = (value: unknown): value is string[] =>
        Array.isArray(value) && value.length <= 4096 && value.every((name) => typeof name === "string");
      if (!names(data.activeTools) || !names(data.callableTools)) throw new Error("Child capability snapshot missing.");
      return this.launch(
        {
          task: data.task,
          snapshot: job.snapshot,
          group: job.record.group,
          scope: job.record.scope,
          activeTools: data.activeTools,
          callableTools: data.callableTools,
        },
        id,
      );
    }
    if (method === "query" && data.action === "list")
      return {
        jobs: this.list().filter((candidate) => {
          try {
            this.tree.authorize(id, candidate.id);
            return true;
          } catch {
            return false;
          }
        }),
      };
    if (typeof data.id !== "string") throw new Error("A descendant job ID is required.");
    this.tree.authorize(id, data.id);
    if (method === "query") {
      const result = data.action === "result" ? this.live(data.id).result : undefined;
      if (result) job.reportedChildren.add(data.id);
      return { job: this.query(data.id), ...(result ? { result } : {}) };
    }
    if (method === "wait") {
      const waited = await this.wait(id, data.id, typeof data.timeout === "number" ? data.timeout : 60_000);
      const result = this.live(data.id).result;
      if (result) job.reportedChildren.add(data.id);
      return { job: waited, result };
    }
    if (method === "cancel") {
      await this.cancel(id, data.id);
      return this.query(data.id);
    }
    if (method === "steer" && typeof data.text === "string") return this.steer(id, data.id, data.text);
    throw new Error("Unknown descendant operation.");
  }
  private async settle(job: LiveJob, data: unknown): Promise<unknown> {
    if (
      job.finalizing ||
      !object(data) ||
      data.version !== 1 ||
      data.job !== job.record.id ||
      data.attempt !== job.record.attempt ||
      !["success", "error", "aborted"].includes(String(data.outcome)) ||
      typeof data.summary !== "string" ||
      typeof data.transcript !== "string" ||
      data.transcript !== job.record.transcript
    )
      throw new Error("Invalid child settlement.");
    this.current(job.record.scope);
    job.finalizing = true;
    try {
      const result = data as unknown as JobResult;
      if (result.outcome !== "success") {
        job.record.outcome = result.outcome;
        job.result = result;
        job.record.result = await this.store.result(result);
        await this.save(job);
        // Do not synchronously ask this same child to cancel while it awaits settlement.
        void this.cancel(this.root, job.record.id).catch(() => {});
        return { continue: false };
      }
      const children = () => [...this.jobs.values()].filter((child) => child.record.parent === job.record.id);
      const unread = () => children().filter((child) => !job.reportedChildren.has(child.record.id));
      if (children().some((child) => !child.record.stopConfirmed) || unread().length) {
        this.tree.settle(job.record.id, "pending-descendants", true);
        await this.save(job);
        while (
          children().some(
            (child) => !terminalState(this.tree.get(child.record.id).state) || !child.record.stopConfirmed,
          )
        ) {
          this.current(job.record.scope);
          if (Date.now() >= job.record.deadline)
            throw new Error("Parent deadline exceeded while waiting for descendants.");
          await delay(50);
        }
        this.tree.resumeSynthesis(job.record.id);
        await this.save(job);
        const results = unread();
        for (const child of results) job.reportedChildren.add(child.record.id);
        return {
          continue: true,
          results: results.map((child) => ({
            id: child.record.id,
            state: child.record.state,
            result: child.record.result,
            summary: child.result?.summary,
          })),
        };
      }
      const path = await this.store.result(result);
      this.current(job.record.scope);
      this.tree.settle(job.record.id, path);
      job.result = result;
      job.record.outcome = "success";
      await this.save(job);
      this.notify(job);
      return { continue: false };
    } finally {
      job.finalizing = false;
    }
  }
  private notify(job: LiveJob): void {
    if (job.notified || job.record.parent !== this.root || !job.result || !this.options.current(job.record.scope))
      return;
    job.notified = true;
    try {
      this.options.completed?.(structuredClone(job.record), structuredClone(job.result));
    } catch {
      /* Durable result remains queryable; notification failure is not task failure. */
    }
  }
  query(id: string): StoredJob {
    const job = this.live(id);
    return structuredClone({ ...job.record, ...this.tree.get(id) });
  }
  list(): StoredJob[] {
    return [...this.jobs.keys()].map((id) => this.query(id));
  }
  async wait(caller: string, id: string, timeout = 60_000, signal?: AbortSignal): Promise<StoredJob> {
    this.tree.authorize(caller, id);
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 600_000) throw new Error("Invalid wait timeout.");
    const until = Date.now() + timeout;
    while (!terminalState(this.tree.get(id).state) && Date.now() < until) {
      signal?.throwIfAborted();
      this.current(this.live(id).record.scope);
      await delay(Math.min(50, Math.max(1, until - Date.now())), undefined, { signal });
    }
    return this.query(id);
  }
  async steer(caller: string, id: string, text: string): Promise<unknown> {
    if (!text.trim() || Buffer.byteLength(text) > 16_000) throw new Error("Steering must contain 1–16000 bytes.");
    this.tree.steer(caller, id);
    const job = this.live(id);
    this.current(job.record.scope);
    if (job.finalizing || !job.peer) return { status: "rejected" };
    await verifyConfiguration(job.snapshot);
    this.current(job.record.scope);
    this.tree.steer(caller, id);
    if (job.finalizing) return { status: "rejected" };
    return job.peer.request("steer", { text });
  }
  cancel(caller: string, id: string): Promise<void> {
    this.tree.authorize(caller, id);
    const existing = this.cancelling.get(id);
    if (existing) return existing;
    const ids = this.tree.cancel(caller, id);
    const operation = (async () => {
      for (const target of ids) {
        const job = this.live(target);
        job.record.outcome ??= "aborted";
        await this.save(job).catch(() => {});
        try {
          if (job.peer?.alive) await job.peer.request("cancel", {}, 2000).catch(() => {});
          if (!job.record.allocation) await this.reconcile(job);
          const allocation = job.record.allocation;
          if (!allocation) throw new Error("No confirmed allocation.");
          const current = parseTerminal(
            (await this.core.call("terminal.get", { terminal: allocation.address })).result,
          );
          if (!sameAllocation(allocation, current))
            throw new Error("Terminal identity changed; cancellation not attempted.");
          const stopped =
            current.state === "finished"
              ? current
              : parseTerminal((await this.core.call("terminal.kill", { terminal: allocation.address })).result);
          if (!sameAllocation(allocation, stopped) || stopped.state !== "finished")
            throw new Error("Termination remains unconfirmed.");
          job.record.stopConfirmed = true;
          this.tree.confirmStopped(
            target,
            job.record.outcome === "error" || job.record.outcome === "missing-result" ? "failed" : "cancelled",
          );
          job.record.diagnostic = "Agent execution stopped; terminal history and job evidence retained.";
        } catch {
          job.record.stopConfirmed = false;
          job.record.diagnostic =
            "Cancellation requested but termination is unconfirmed. This attempt retains its slot and is not eligible for cleanup.";
        }
        if (!job.result) {
          job.result = {
            version: 1,
            job: target,
            attempt: job.record.attempt,
            outcome: job.record.outcome === "missing-result" ? "missing-result" : "aborted",
            summary:
              job.record.outcome === "missing-result"
                ? "Child disconnected without an authoritative task result."
                : "Cancellation requested before a final task result was published.",
            transcript: job.record.transcript ?? "",
          };
          job.record.result = await this.store.result(job.result);
        }
        await this.save(job).catch(() => {});
        this.notify(job);
        if (job.record.stopConfirmed) await job.endpoint?.dispose();
      }
    })();
    this.cancelling.set(id, operation);
    void operation.finally(() => this.cancelling.delete(id)).catch(() => {});
    return operation;
  }
  private async confirmExit(job: LiveJob): Promise<void> {
    if (!job.record.allocation) return;
    for (let i = 0; i < 20; i++) {
      const terminal = parseTerminal(
        (await this.core.call("terminal.get", { terminal: job.record.allocation.address })).result,
      );
      if (!sameAllocation(job.record.allocation, terminal)) return;
      if (terminal.state === "finished") {
        job.record.stopConfirmed = true;
        this.tree.confirmExecutionStopped(job.record.id);
        await this.save(job);
        await job.endpoint?.dispose();
        return;
      }
      await delay(100);
    }
    // A result is not proof of process exit. Escalate without resurrecting the agent.
    const stopped = parseTerminal(
      (await this.core.call("terminal.kill", { terminal: job.record.allocation.address })).result,
    );
    if (sameAllocation(job.record.allocation, stopped) && stopped.state === "finished") {
      job.record.stopConfirmed = true;
      this.tree.confirmExecutionStopped(job.record.id);
    } else job.record.diagnostic = "Result recorded, but child process exit is not confirmed.";
    await this.save(job);
  }
  hold(scope: string, held: boolean): void {
    this.tree.hold(scope, held);
  }
  async revoke(scope: string): Promise<void> {
    // Token/policy must be revoked by the caller synchronously before invoking this cleanup.
    const ids = this.tree.revoke(scope);
    for (const id of ids) await this.cancel(this.root, id);
  }
  async cleanup(record: StoredJob): Promise<"removed" | "skipped" | "already-removed"> {
    if (!record.allocation || !record.stopConfirmed || !terminalState(record.state) || !record.core) return "skipped";
    if (this.list().some((job) => job.parent === record.id && (!terminalState(job.state) || !job.stopConfirmed)))
      return "skipped";
    const client = new CoreClient(this.options.coreSocket, record.core);
    try {
      const terminal = parseTerminal(
        (await client.call("terminal.get", { terminal: record.allocation.address })).result,
      );
      if (!removable(record.allocation, terminal)) return "skipped";
      const listed = (await client.call("terminal.list", { all: true })).result;
      if (!object(listed) || !Array.isArray(listed.terminals)) return "skipped";
      const local = listed.terminals
        .filter((value) => object(value) && typeof value.address === "string" && /^t[1-9][0-9]*$/.test(value.address))
        .map(parseTerminal);
      const descendants = new Set([terminal.address]);
      for (let changed = true; changed; ) {
        changed = false;
        for (const candidate of local)
          if (candidate.parent && descendants.has(candidate.parent) && !descendants.has(candidate.address)) {
            if (candidate.state === "live") return "skipped";
            descendants.add(candidate.address);
            changed = true;
          }
      }
      // Recheck the occupant after descendant inspection and immediately before removal.
      const current = parseTerminal((await client.call("terminal.get", { terminal: terminal.address })).result);
      if (!removable(record.allocation, current)) return "skipped";
      await client.call("terminal.rm", { terminal: terminal.address });
      return "removed";
    } catch (error) {
      return error instanceof CoreError && error.kind === "not_found" ? "already-removed" : "skipped";
    }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.deadlineTimer);
    for (const job of this.list().filter((item) => item.parent === this.root && !terminalState(item.state)))
      await this.cancel(this.root, job.id).catch(() => {});
    for (const job of this.jobs.values()) {
      if (terminalState(this.tree.get(job.record.id).state) && !job.record.stopConfirmed)
        await this.confirmExit(job).catch(() => {});
      await job.endpoint?.dispose();
    }
  }
}
