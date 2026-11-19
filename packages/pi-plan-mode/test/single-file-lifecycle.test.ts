import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "vitest";
import { restoreImplementation } from "../src/implementation-state.js";
import planMode from "../src/plan-mode.js";
import type { requestPlanName } from "../src/plan-name.js";
import { createPlanStore, type PlanDocument, planHash } from "../src/plan-store.js";
import { restorePlanState } from "../src/state.js";
import { builtinTool, createMockContext, createMockPi } from "./support.js";

// Supplemental lifecycle regressions: existing plan-mode/runtime coverage is not replaced.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const BASELINE = ["read", "bash", "edit", "write"];
const PLAN = "# Current plan\n\nImplement blue.";
async function fixture(namer?: typeof requestPlanName) {
  const root = await mkdtemp(join(tmpdir(), "single-plan-lifecycle-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agent = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agent);
  const mock = createMockPi({ activeTools: BASELINE, allTools: [...BASELINE, "grep", "find", "ls"].map(builtinTool) });
  const context = createMockContext({
    mode: "rpc",
    cwd,
    hasUI: true,
    sessionManager: {
      getSessionId: () => "single-file-session",
      getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })),
    },
  });
  let action: "here" | "continue" | "save" | undefined;
  let selectedTools: string[] | undefined;
  const naming: string[] = [];
  await planMode(mock.pi, {
    readSettings: async () => ({}),
    readInstructions: () => "Captured guidance",
    namePlan: async (registry, task, settings, signal) => {
      naming.push(task);
      return namer ? namer(registry, task, settings, signal) : "blue-feature";
    },
    createStore: (directory, location, _agent, options) => createPlanStore(directory, location, agent, options),
    loadUi: async () => ({
      reviewPlan: async () => action,
      selectSavedPlan: async (_ctx: unknown, documents: PlanDocument[]) => documents[0],
      selectPlanTools: async () => selectedTools,
    }),
  });
  const emit = async (event: string, input: unknown = {}) => {
    for (const handler of mock.events.get(event) ?? []) await handler(input, context.ctx);
  };
  const command = async (args: string) => {
    const registered = mock.commands.get("plan");
    assert.ok(registered);
    await registered.handler(args, context.ctx);
  };
  const execute = async (name: string, input: unknown) => {
    const tool = mock.tools.find((tool) => tool.name === name);
    assert.ok(tool);
    return await (tool as unknown as ToolDefinition).execute(
      "test-call",
      input as never,
      new AbortController().signal,
      undefined,
      context.ctx,
    );
  };
  const entries = () => mock.entries.map((entry) => ({ type: "custom", ...entry }));
  await emit("session_start");
  return {
    ...mock,
    ...context,
    cwd,
    agent,
    emit,
    command,
    execute,
    naming,
    choose: (value: typeof action) => {
      action = value;
    },
    chooseTools: (value: string[]) => {
      selectedTools = value;
    },
    state: () => restorePlanState(entries()),
    implementation: () => restoreImplementation(entries()),
    status: () => context.statuses.get("plan-mode"),
    store: () => createPlanStore(cwd, undefined, agent),
  };
}
async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  await f.command("Add blue feature");
  await f.execute("plan_mode_complete", { plan: PLAN });
  const state = f.state();
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") throw new Error("Expected ready");
  return state.document;
}
test("entering Explain cancels pending Plan naming and rejects its late result", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const named = Promise.withResolvers<string>();
  const f = await fixture(async (_registry, _task, _settings, signal) => {
    entered.resolve(signal);
    return named.promise;
  });
  await f.command("Name this future plan");
  const signal = await entered.promise;
  const command = f.commands.get("explain");
  assert.ok(command);
  await command.handler("start", f.ctx);
  assert.equal(signal.aborted, true);
  assert.equal(f.state().kind, "explain");
  const snapshot = structuredClone(f.entries);
  named.resolve("late-name");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.entries, snapshot);
  assert.equal(f.status(), "[Explain]");
});

test("unified status follows Normal, unnamed/named Planning, Implementing and Normal exactly", async () => {
  const f = await fixture();
  assert.equal(f.status(), "[Normal]");
  await f.command("start");
  assert.equal(f.status(), "[Plan decision-brief]");
  await f.emit("input", { text: "Add blue feature", source: "interactive" });
  await f.execute("plan_mode_complete", { plan: PLAN });
  assert.equal(f.status(), "[Plan decision-brief] blue-feature");
  assert.equal(f.naming.length, 1);
  f.choose("here");
  await f.command("");
  assert.equal(f.status(), "[Implementing blue-feature]");
  await f.execute("plan_mode_implementation_complete", {});
  assert.equal(f.status(), "[Normal]");
  assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
  for (const key of f.statuses.keys())
    assert.ok(!/implementation|verification/.test(key), `unexpected separate status: ${key}`);
});

test("Normal /plan tools configures future planning without activating it or changing the current loadout", async () => {
  const f = await fixture();
  f.chooseTools(["read", "grep"]);
  await f.command("tools");
  assert.equal(f.state().kind, "idle");
  assert.equal(f.status(), "[Normal]");
  assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
  assert.deepEqual(f.sentUserMessages, []);
  assert.equal(f.naming.length, 0);
  await f.command("start");
  assert.ok(!f.rawPi.getActiveTools().includes("grep"));
  assert.ok(f.rawPi.getActiveTools().includes("write"));
  await f.command("exit");
  assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
});

test.each(["exit", "implementation"] as const)(
  "%s preserves changes made to ordinary tools while the plan was active",
  async (exit) => {
    const f = await fixture();
    await ready(f);
    f.rawPi.setActiveTools(f.rawPi.getActiveTools().filter((name) => name !== "write" && name !== "bash"));
    if (exit === "implementation") {
      f.choose("here");
      await f.command("");
    } else await f.command("exit");
    const active = f.rawPi.getActiveTools();
    assert.ok(active.includes("read"));
    assert.ok(active.includes("edit"));
    assert.ok(!active.includes("write"));
    assert.ok(!active.includes("bash"));
    assert.ok(!active.includes("grep"));
    assert.ok(!active.includes("find"));
    assert.ok(!active.includes("ls"));
    if (exit === "implementation") {
      await f.execute("plan_mode_implementation_complete", {});
      assert.deepEqual(f.rawPi.getActiveTools(), ["read", "edit"]);
    }
  },
);

test("completion, localized edits and implementation updates retain one path and the original name", async () => {
  const f = await fixture();
  const document = await ready(f);
  await f.execute("plan_mode_edit", { path: document.path, edits: [{ oldText: "blue", newText: "green" }] });
  const state = f.state();
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") throw new Error("Expected ready");
  assert.equal(state.document.path, document.path);
  assert.equal(state.document.id, document.id);
  f.choose("here");
  await f.command("");
  await f.execute("plan_mode_update", { plan: "# Different title\n\nImplement red." });
  const implementation = f.implementation();
  assert.ok(implementation);
  assert.equal(implementation.document.path, document.path);
  assert.equal(implementation.document.name, document.name);
  assert.equal(implementation.hash, planHash("# Different title\n\nImplement red."));
  assert.equal("revisions" in implementation, false);
  assert.equal(f.naming.length, 1);
  const store = await f.store();
  assert.equal((await store.list()).length, 1);
  assert.equal(await store.read(document), "# Different title\n\nImplement red.");
});

test("removed import gives migration guidance without creating planning state or a document", async () => {
  const f = await fixture();
  await f.command(`import ${join(f.cwd, "missing.md")}`);
  assert.equal(f.state().kind, "idle");
  assert.equal(f.status(), "[Normal]");
  assert.deepEqual(await (await f.store()).list(), []);
  assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
  assert.ok(f.notifications.some((notice) => /removed.*paste the Markdown body/i.test(notice.message)));
});

test("bare planning waits for the first task; first save waits for naming without creating an empty file", async () => {
  const named = Promise.withResolvers<string>();
  const f = await fixture(async () => named.promise);
  await f.command("start");
  assert.equal(f.naming.length, 0);
  assert.equal(f.status(), "[Plan decision-brief]");
  await f.emit("input", { text: "Support uploading images", source: "interactive" });
  await f.emit("input", { text: "This later task must not be sent to naming", source: "interactive" });
  assert.deepEqual(f.naming, ["Support uploading images"]);
  const saving = f.execute("plan_mode_complete", { plan: PLAN });
  assert.deepEqual(await (await f.store()).list(), []);
  named.resolve("support-uploading-images");
  await saving;
  assert.equal(f.status(), "[Plan decision-brief] support-uploading-images");
  const state = f.state();
  assert.ok(state.kind === "ready");
  assert.equal(state.workflow.task, "Support uploading images");
  await f.emit("session_tree");
  assert.equal(f.status(), "[Plan decision-brief] support-uploading-images");
  assert.equal(f.naming.length, 1);
});

test.each(["exit", "replacement", "shutdown"] as const)("late naming is discarded on %s", async (event) => {
  const old = Promise.withResolvers<string>();
  let signal: AbortSignal | undefined;
  const f = await fixture(async (_registry, _task, _settings, input) => {
    signal = input;
    return old.promise;
  });
  await f.command("Old task");
  assert.ok(signal);
  if (event === "exit") await f.command("exit");
  else if (event === "shutdown") await f.emit("session_shutdown");
  else {
    f.entries.splice(0);
    Object.assign(f.ctx, {
      sessionManager: { ...(f.ctx as ExtensionContext).sessionManager, getSessionId: () => "replacement" },
    });
    await f.emit("session_start");
  }
  assert.equal(signal.aborted, true);
  old.resolve("stale-provider-name");
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(!String(f.status()).includes("stale-provider-name"));
  assert.deepEqual(await (await f.store()).list(), []);
  if (event !== "shutdown") {
    await f.command("start");
    assert.equal(f.status(), "[Plan decision-brief]");
  }
});
