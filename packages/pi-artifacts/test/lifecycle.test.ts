import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { WorkflowScope } from "@narumitw/pi-background";
import { afterEach, expect, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { RunInput } from "../src/agent.js";
import artifacts from "../src/artifacts.js";
import { ArtifactJobs } from "../src/jobs.js";
import type { Job } from "../src/store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(run: (input: RunInput) => Promise<string>) {
  const directory = mkdtempSync(join(tmpdir(), "artifact-lifecycle-"));
  const mock = createMockPi();
  const context = createMockContext({ cwd: directory, hasUI: true });
  const branch: unknown[] = [];
  Object.assign(context.ctx, {
    model: { id: "fake", provider: "fake" },
    thinkingLevel: "off",
    sessionManager: { ...(context.ctx as ExtensionContext).sessionManager, getBranch: () => branch },
  });
  // Match public Pi unsubscription and transcript commitment, rather than treating
  // a proposed boundary or an execute() return as already delivered to the model.
  const register = mock.rawPi.on.bind(mock.rawPi);
  mock.rawPi.on = (name, handler) => {
    register(name, handler);
    return () =>
      mock.events.set(
        name,
        (mock.events.get(name) ?? []).filter((candidate) => candidate !== handler),
      );
  };
  artifacts(mock.pi, { run, agentDir: join(directory, "agent") });
  async function emit(name: string, event: unknown = {}, ctx = context.ctx, commit = true) {
    let result: unknown;
    let proposal = event;
    for (const handler of [...(mock.events.get(name) ?? [])]) {
      const next = await handler(proposal, ctx);
      if (next !== undefined) {
        result = next;
        if (next && typeof next === "object" && proposal && typeof proposal === "object")
          proposal = { ...proposal, ...next };
      }
    }
    if (
      commit &&
      name === "turn_end" &&
      result &&
      typeof result === "object" &&
      "entries" in result &&
      Array.isArray(result.entries)
    )
      branch.push(...result.entries);
    return result;
  }
  const call = async (name: string, input: unknown) => {
    const tool = mock.tools.find((t) => t.name === name);
    if (!tool) throw new Error("Missing tool");
    const output = await (
      tool.execute as (...args: unknown[]) => Promise<{ details: { artifacts: Job[]; backgroundEventIds?: string[] } }>
    )("call", input, undefined, undefined, context.ctx);
    branch.push({ type: "message", message: { role: "toolResult", toolName: name, details: output.details } });
    return output;
  };
  await emit("session_start");
  cleanups.push(async () => {
    await emit("session_shutdown");
    rmSync(directory, { recursive: true, force: true });
  });
  return { ...mock, ...context, directory, emit, call, branch };
}
async function write(input: RunInput) {
  await input.backend
    .tools()[0]
    .execute("write", { path: "index.html", content: "prototype" }, input.signal, undefined, {
      cwd: input.artifact.root.path,
    } as ExtensionToolContext);
}

test("jobs survive ordinary settlement and compaction; terminal notifications wait for a safe boundary and never trigger a duplicate turn", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await fixture(async (input) => {
    started.resolve();
    await release.promise;
    await write(input);
    return "done";
  });
  const ack = await f.call("artifact_create", { directory: "out", task: "prototype" });
  const job = ack.details.artifacts[0];
  expect(job.status).toBe("queued");
  await started.promise;
  await f.emit("agent_settled", { aborted: false });
  await f.emit("session_compact");
  expect((await f.call("artifact_status", { jobId: job.jobId })).details.artifacts[0].status).toBe("running");
  await f.emit("ui_prompt_start");
  release.resolve();
  for (let i = 0; i < 100; i++) {
    if ((await f.call("artifact_status", { jobId: job.jobId })).details.artifacts[0].status === "succeeded") break;
    await new Promise((r) => setTimeout(r, 2));
  }
  expect(await f.emit("turn_end", { entries: [], outcome: "completed" })).toBeUndefined();
  await f.emit("ui_prompt_end");
  const notification = (await f.emit("turn_end", { entries: [], outcome: "completed" })) as {
    entries: unknown[];
    continue?: boolean;
  };
  expect(notification.entries).toHaveLength(1);
  expect(notification.continue).toBeUndefined();
  expect(await f.emit("turn_end", { entries: [], outcome: "completed" })).toBeUndefined();
  expect(f.sentUserMessages).toHaveLength(0);
  expect(f.sentMessages).toHaveLength(0);
  const waited = await f.call("artifact_wait", { jobIds: [job.jobId] });
  expect(waited.details.artifacts[0].status).toBe("succeeded");
  expect(waited).not.toHaveProperty("usage");
});

test("explicit wait supplies the result once without a later duplicate notification", async () => {
  const f = await fixture(async (input) => {
    await write(input);
    return "done";
  });
  const ack = await f.call("artifact_create", { directory: "out", task: "prototype" });
  await f.call("artifact_wait", { jobIds: [ack.details.artifacts[0].jobId] });
  expect(await f.emit("turn_end", { entries: [], outcome: "completed" })).toBeUndefined();
  expect(f.sentUserMessages).toHaveLength(0);
});

test.each(["session_tree", "agent_settled", "session_shutdown"])(
  "%s aborts owned work and suppresses abandoned delivery",
  async (event) => {
    const started = Promise.withResolvers<void>();
    let aborted = false;
    const f = await fixture(async (input) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) =>
        input.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(input.signal.reason);
          },
          { once: true },
        ),
      );
      return "unreachable";
    });
    await f.call("artifact_create", { directory: "out", task: "prototype" });
    await started.promise;
    await f.emit(event, { aborted: true });
    expect(aborted).toBe(true);
    if (event !== "agent_settled")
      expect(await f.emit("turn_end", { entries: [], outcome: "completed" })).toBeUndefined();
    expect(f.sentUserMessages).toHaveLength(0);
  },
);

test("scoped cancellation service does not cancel unassociated independent jobs", async () => {
  const f = await fixture(async (input) => {
    await write(input);
    return "done";
  });
  const a = (await f.call("artifact_create", { directory: "a", task: "a" })).details.artifacts[0];
  const b = (await f.call("artifact_create", { directory: "b", task: "b" })).details.artifacts[0];
  await new Promise<void>((resolve, reject) =>
    f.rawPi.events.emit("pi-artifacts-service-v1", {
      version: 1,
      sessionId: (f.ctx as ExtensionContext).sessionManager.getSessionId(),
      action: "cancel",
      jobIds: [a.jobId],
      respond(value: { error?: string }) {
        if (value.error) reject(new Error(value.error));
        else resolve();
      },
    }),
  );
  expect(
    (await f.call("artifact_wait", { jobIds: [a.jobId, b.jobId] })).details.artifacts.map((j) => j.status),
  ).toEqual(["cancelled", "succeeded"]);
});

test.each(["artifact_create", "artifact_update"])(
  "%s rejects a scope replaced during admission instead of adopting the replacement scope",
  async (name) => {
    const run = vi.fn(async (input: RunInput) => {
      await write(input);
      return "done";
    });
    const f = await fixture(run);
    const scope = new WorkflowScope(f.rawPi.events);
    const session = (f.ctx as ExtensionContext).sessionManager.getSessionId();
    scope.replace(session, { allowedTools: [name], parentOnly: [], guidance: "Old workflow" });
    let input: Record<string, string> = { directory: "late", task: "late" };
    if (name === "artifact_update") {
      const first = (await f.call("artifact_create", { directory: "base", task: "base" })).details.artifacts[0];
      await f.call("artifact_wait", { jobIds: [first.jobId] });
      input = { artifactId: first.artifactId, task: "late update" };
    }
    const runs = run.mock.calls.length;
    const references = f.entries.length;
    const submit = ArtifactJobs.prototype.submit;
    const intercept = vi.spyOn(ArtifactJobs.prototype, "submit").mockImplementation(function (
      this: ArtifactJobs,
      target,
      task,
      selection,
      admission,
    ) {
      // The real current submit is synchronous. This reentrant replacement exercises
      // the same late-acceptance invariant required if admission becomes asynchronous.
      scope.replace(session, { allowedTools: [name], parentOnly: [], guidance: "Replacement workflow" });
      return submit.call(this, target, task, selection, admission);
    });
    try {
      await expect(f.call(name, input)).rejects.toThrow(/revoked during admission/);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(run.mock.calls.length).toBe(runs);
      expect(f.entries.length).toBe(references);
      expect(await f.emit("turn_end", { entries: [], outcome: "completed" })).toBeUndefined();
    } finally {
      intercept.mockRestore();
      scope.dispose();
    }
  },
);

test("an uncommitted artifact boundary proposal is retried rather than lost", async () => {
  const f = await fixture(async (input) => {
    await write(input);
    return "done";
  });
  const job = (await f.call("artifact_create", { directory: "out", task: "prototype" })).details.artifacts[0];
  for (let i = 0; i < 100; i++) {
    if ((await f.call("artifact_status", { jobId: job.jobId })).details.artifacts[0].status === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const first = await f.emit("turn_end", { entries: [], outcome: "completed" }, f.ctx, false);
  expect(first).toHaveProperty("entries");
  await f.emit("turn_start");
  const retry = await f.emit("turn_end", { entries: [], outcome: "completed" });
  expect(retry).toHaveProperty("entries");
  expect(await f.emit("turn_end", { entries: [], outcome: "completed" })).toBeUndefined();
});
