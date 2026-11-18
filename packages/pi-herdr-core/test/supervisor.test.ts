/* biome-ignore-all lint/style/noNonNullAssertion: Mock allocations and handlers are installed before each assertion. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlHandler } from "../src/control.js";
import type { ChildSnapshot } from "../src/snapshot.js";

const fake = vi.hoisted(() => ({
  terminals: new Map<string, Record<string, unknown>>(),
  peers: new Map<string, FakePeer>(),
  calls: [] as Array<{ method: string; params: Record<string, unknown> }>,
  uncertain: false,
  next: 2,
}));
class FakePeer {
  handler?: ControlHandler;
  listeners: Array<() => void> = [];
  alive = true;
  onRequest(handler: ControlHandler) {
    this.handler = handler;
  }
  onClose(handler: () => void) {
    this.listeners.push(handler);
    return () => {};
  }
  async request(method: string) {
    return method === "steer" ? { status: "queued" } : { accepted: true };
  }
  close() {
    if (!this.alive) return;
    this.alive = false;
    for (const listener of this.listeners) listener();
  }
  async child(method: string, data: unknown = {}) {
    if (!this.handler) throw new Error("Supervisor handler not installed");
    return this.handler(method, data);
  }
}
vi.mock("../src/control.js", () => ({
  createControlEndpoint: async (job: string) => {
    const peer = new FakePeer();
    fake.peers.set(job, peer);
    return {
      socket: `/private/${job}.sock`,
      credentialFile: `/private/${job}.json`,
      connected: Promise.resolve(peer),
      dispose: async () => peer.close(),
    };
  },
}));
vi.mock("../src/snapshot.js", () => ({ verifyConfiguration: async () => {} }));
vi.mock("../src/core.js", async (original) => {
  const actual = await original<typeof import("../src/core.js")>();
  return {
    ...actual,
    CoreClient: class {
      async call(method: string, params: Record<string, unknown>) {
        fake.calls.push({ method, params });
        let result: unknown;
        if (method === "terminal.get") result = fake.terminals.get(String(params.terminal));
        else if (method === "terminal.list") {
          const labels = params.labels as Record<string, string>;
          result = {
            terminals: [...fake.terminals.values()].filter((terminal) =>
              Object.entries(labels).every(
                ([key, value]) => (terminal.labels as Record<string, string>)[key] === value,
              ),
            ),
          };
        } else if (method === "terminal.run") {
          const labels = params.labels as Record<string, string>;
          const address = `t${fake.next++}`;
          const terminal = {
            address,
            state: "live",
            parent: params.parent,
            argv: params.argv,
            labels,
            created_ms: Date.now(),
            keep: false,
            rm: false,
            notify: false,
          };
          fake.terminals.set(address, terminal);
          result = terminal;
          const peer = fake.peers.get(labels["pi-herdr-core-job"])!;
          // Like a real child, it requests only its allocated assignment and then acknowledges.
          void Promise.resolve()
            .then(async () => {
              await peer.child("assignment");
              await peer.child("ready", {
                terminal: address,
                transcript: `/transcripts/${labels["pi-herdr-core-job"]}.jsonl`,
              });
            })
            .catch(() => {});
          if (fake.uncertain) {
            fake.uncertain = false;
            throw new actual.CoreError("lost response", true);
          }
        } else if (method === "terminal.kill") {
          const terminal = fake.terminals.get(String(params.terminal))!;
          terminal.state = "finished";
          result = terminal;
        } else if (method === "terminal.rm") {
          fake.terminals.delete(String(params.terminal));
          result = { removed: params.terminal };
        } else throw new Error(`Unexpected method ${method}`);
        return { core: { id: "core", version: "0.1.21" }, result };
      }
    },
  };
});

import { Supervisor } from "../src/supervisor.js";

let directory: string;
let supervisor: Supervisor | undefined;
const completed = vi.fn();
const snapshot = {
  version: 1,
  cwd: "/project",
  trusted: true,
  agentDir: "/agent",
  sdkUrl: "file:///sdk/index.js",
  capabilities: { tools: [], excluded: [], files: [], builtins: [] },
  mcp: [],
  model: { provider: "fake", id: "deterministic" },
  thinking: "off",
  auth: { apiKey: "never-persist-me" },
  guidance: "Inspect",
  configFiles: [],
} as unknown as ChildSnapshot;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-herdr-core-supervisor-"));
  fake.terminals.clear();
  fake.peers.clear();
  fake.calls.length = 0;
  fake.next = 2;
  fake.uncertain = false;
  fake.terminals.set("t1", {
    address: "t1",
    parent: null,
    state: "live",
    labels: {},
    argv: ["pi"],
    created_ms: 1,
    keep: false,
    rm: false,
    notify: false,
  });
  completed.mockClear();
  supervisor = new Supervisor({
    session: "session",
    agentDir: directory,
    parentTerminal: "t1",
    coreSocket: "/private/core.sock",
    bootstrap: process.execPath,
    current: () => true,
    completed,
  });
});
afterEach(async () => {
  await supervisor?.dispose();
  await rm(directory, { recursive: true, force: true });
});
const launch = () => supervisor!.launch({ task: "literal /not-a-command", snapshot, group: "request", scope: "scope" });
async function finish(id: string, outcome = "success") {
  const job = supervisor!.query(id);
  const result = await fake.peers.get(id)!.child("settled", {
    version: 1,
    job: id,
    attempt: job.attempt,
    outcome,
    summary: "Authoritative result",
    transcript: job.transcript,
    usage: { input: 2, output: 3 },
  });
  const terminal = fake.terminals.get(job.terminal!)!;
  terminal.state = "finished";
  fake.peers.get(id)!.close();
  return result;
}
describe("root supervision with mocked Core and private IPC", () => {
  it("persists intent/acquisition, binds ready identity, and never persists auth", async () => {
    const job = await launch();
    expect(job.state).toBe("running");
    const run = fake.calls.find((call) => call.method === "terminal.run")!;
    expect(run.params).toMatchObject({ parent: "t1", no_notify: true, keep: false, rm: false });
    expect(run.params.argv).toEqual([process.execPath, process.execPath]);
    const saved = await readFile(join(supervisor!.store.jobDirectory(job.id), "job.json"), "utf8");
    expect(saved).not.toContain("never-persist-me");
    expect(saved).not.toContain("credentialFile");
    expect(saved).toContain(job.attempt);
  });
  it("reconciles an uncertain dispatch without launching twice", async () => {
    fake.uncertain = true;
    const job = await launch();
    expect(job.state).toBe("running");
    expect(fake.calls.filter((call) => call.method === "terminal.run")).toHaveLength(1);
    expect(fake.calls.some((call) => call.method === "terminal.list")).toBe(true);
  });
  it("uses native immediate parents, descendant authorization, and child query variants", async () => {
    const parent = await launch();
    const child = (await fake.peers
      .get(parent.id)!
      .child("launch", { task: "grandchild", parent: "forged", activeTools: [], callableTools: [] })) as {
      id: string;
      terminal: string;
    };
    expect(fake.terminals.get(child.terminal)?.parent).toBe(parent.terminal);
    const listed = (await fake.peers.get(parent.id)!.child("query", { action: "list" })) as {
      jobs: Array<{ id: string }>;
    };
    expect(listed.jobs.map((job) => job.id)).toEqual([child.id]);
    await expect(fake.peers.get(child.id)!.child("query", { action: "result", id: parent.id })).rejects.toThrow();
    await finish(child.id);
    const result = (await fake.peers.get(parent.id)!.child("query", { action: "result", id: child.id })) as {
      result: { summary: string };
    };
    expect(result.result.summary).toBe("Authoritative result");
    expect(completed).not.toHaveBeenCalled(); // Grandchild results belong to the immediate parent.
  });
  it("delivers an already-finished descendant exactly once before parent success", async () => {
    const parent = await launch();
    const peer = fake.peers.get(parent.id)!;
    const child = (await peer.child("launch", { task: "quick leaf", activeTools: [], callableTools: [] })) as {
      id: string;
    };
    await finish(child.id);
    await vi.waitFor(() => expect(supervisor!.query(child.id).stopConfirmed).toBe(true));
    const synthesis = await peer.child("settled", {
      version: 1,
      job: parent.id,
      attempt: parent.attempt,
      outcome: "success",
      summary: "Premature final",
      transcript: parent.transcript,
    });
    expect(synthesis).toMatchObject({ continue: true, results: [{ id: child.id, summary: "Authoritative result" }] });
    expect(supervisor!.query(parent.id).state).toBe("running");
    expect(await finish(parent.id)).toEqual({ continue: false });
    expect(completed).toHaveBeenCalledTimes(1);
  });
  it("distinguishes missing child results from intentional cancellation", async () => {
    const job = await launch();
    fake.peers.get(job.id)!.close();
    await vi.waitFor(() => expect(supervisor!.query(job.id).stopConfirmed).toBe(true));
    expect(supervisor!.query(job.id)).toMatchObject({ state: "failed", outcome: "missing-result" });
    expect(completed.mock.calls[0][1].outcome).toBe("missing-result");
  });
  it("routes failed settlements and truthfully stops the subtree", async () => {
    const job = await launch();
    await finish(job.id, "error");
    await supervisor!.cancel(supervisor!.root, job.id);
    expect(supervisor!.query(job.id).stopConfirmed).toBe(true);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0][1].outcome).toBe("error");
  });
  it("retains successful process slots and rejects steering after settlement", async () => {
    const job = await launch();
    const peer = fake.peers.get(job.id)!;
    await peer.child("settled", {
      version: 1,
      job: job.id,
      attempt: job.attempt,
      outcome: "success",
      summary: "Done",
      transcript: job.transcript,
    });
    expect(supervisor!.query(job.id).stopConfirmed).toBe(false);
    await expect(supervisor!.steer(supervisor!.root, job.id, "resume")).rejects.toThrow();
    await supervisor!.dispose();
    expect(fake.terminals.get(job.terminal!)?.state).toBe("finished");
  });
  it("revokes before asynchronous cleanup and rejects child dispatch/steering", async () => {
    const job = await launch();
    const cancellation = supervisor!.revoke("scope");
    await expect(fake.peers.get(job.id)!.child("charge", { kind: "turn" })).rejects.toThrow();
    await cancellation;
    await expect(supervisor!.steer(supervisor!.root, job.id, "continue")).rejects.toThrow();
  });
});
