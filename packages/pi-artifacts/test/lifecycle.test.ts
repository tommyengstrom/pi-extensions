import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { RunInput } from "../src/agent.js";
import artifacts from "../src/artifacts.js";
import type { Job } from "../src/store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(run: (input: RunInput) => Promise<string>) {
  const directory = mkdtempSync(join(tmpdir(), "artifact-lifecycle-"));
  const mock = createMockPi();
  const context = createMockContext({ cwd: directory, hasUI: true });
  Object.assign(context.ctx, { model: { id: "fake", provider: "fake" }, thinkingLevel: "off" });
  artifacts(mock.pi, { run, agentDir: join(directory, "agent") });
  async function emit(name: string, event: unknown = {}, ctx = context.ctx) {
    let result: unknown;
    for (const handler of mock.events.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
    return result;
  }
  const call = async (name: string, input: unknown) => {
    const tool = mock.tools.find((t) => t.name === name);
    if (!tool) throw new Error("Missing tool");
    return (tool.execute as (...args: unknown[]) => Promise<{ details: { artifacts: Job[] } }>)(
      "call",
      input,
      undefined,
      undefined,
      context.ctx,
    );
  };
  await emit("session_start");
  cleanups.push(async () => {
    await emit("session_shutdown");
    rmSync(directory, { recursive: true, force: true });
  });
  return { ...mock, ...context, directory, emit, call };
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
