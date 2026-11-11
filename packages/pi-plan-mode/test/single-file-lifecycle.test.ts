import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "vitest";
import { restoreImplementation } from "../src/implementation-state.js";
import planMode from "../src/plan-mode.js";
import type { requestPlanName } from "../src/plan-name.js";
import { createPlanStore, type PlanDocument, planHash } from "../src/plan-store.js";
import { restorePlanState } from "../src/state.js";
import type { VerificationInput, VerificationResult } from "../src/verification.js";
import { builtinTool, createMockContext, createMockPi } from "./support.js";

// Supplemental lifecycle regressions: existing plan-mode/runtime coverage is not replaced.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const BASELINE = ["read", "bash", "edit", "write"];
const PLAN = "# Current plan\n\nImplement blue.";
const RESULT: VerificationResult = {
  model: { provider: "offline", id: "checker" },
  report: { status: "ok", motivation: "Implemented." },
};
async function fixture(
  verify: (input: VerificationInput) => Promise<VerificationResult> = async () => RESULT,
  namer?: typeof requestPlanName,
) {
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
    select: async (title: string, _options: string[], options?: { signal?: AbortSignal }) => {
      if (!title.startsWith("Checking plan adherence")) return undefined;
      return new Promise<undefined>((resolve) => {
        if (options?.signal?.aborted) resolve(undefined);
        else options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
      });
    },
    sessionManager: {
      getSessionId: () => "single-file-session",
      getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })),
    },
  });
  let action: "here" | "continue" | "save" | undefined;
  let selectedTools: string[] | undefined;
  const naming: string[] = [];
  await planMode(mock.pi, {
    readSettings: async () => ({ verification: { automatic: true } }),
    readInstructions: () => "Captured guidance",
    namePlan: async (registry, task, settings, signal) => {
      naming.push(task);
      return namer ? namer(registry, task, settings, signal) : "blue-feature";
    },
    createStore: (directory, location, _agent, options) => createPlanStore(directory, location, agent, options),
    verify,
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
async function implementing(f: Awaited<ReturnType<typeof fixture>>) {
  const document = await ready(f);
  f.choose("here");
  await f.command("");
  return document;
}

test("unified status follows Normal, unnamed/named Planning, Implementing, Verifying and Normal exactly", async () => {
  const entered = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<VerificationResult>();
  const f = await fixture(async () => {
    entered.resolve();
    return completed.promise;
  });
  assert.equal(f.status(), "[Normal]");
  await f.command("start");
  assert.equal(f.status(), "[Planning]");
  await f.emit("input", { text: "Add blue feature", source: "interactive" });
  await f.execute("plan_mode_complete", { plan: PLAN });
  assert.equal(f.status(), "[Planning blue-feature]");
  assert.equal(f.naming.length, 1);
  f.choose("here");
  await f.command("");
  assert.equal(f.status(), "[Implementing blue-feature]");
  const pending = f.execute("plan_mode_implementation_complete", {});
  await entered.promise;
  assert.equal(f.status(), "[Verifying blue-feature]");
  completed.resolve(RESULT);
  await pending;
  assert.equal(f.status(), "[Normal]");
  assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
  for (const key of f.statuses.keys())
    assert.ok(!/implementation|verification/.test(key), `unexpected separate status: ${key}`);
});

test.each(["ok", "minor_issues", "issues", "failure", "cancel"] as const)(
  "checker exit %s always restores Normal and baseline tools",
  async (outcome) => {
    const entered = Promise.withResolvers<void>();
    const f = await fixture(async (input) => {
      entered.resolve();
      if (outcome === "failure") throw new Error("Checker failed");
      if (outcome === "cancel")
        await new Promise<void>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), {
            once: true,
          });
        });
      return {
        ...RESULT,
        report: { ...RESULT.report, status: outcome === "minor_issues" || outcome === "issues" ? outcome : "ok" },
      };
    });
    const checked = await implementing(f);
    const savedBytes = await readFile(checked.path, "utf8");
    const pending = f.execute("plan_mode_implementation_complete", {});
    await entered.promise;
    if (outcome === "cancel") await f.emit("before_agent_start", { systemPromptOptions: { sections: {} } });
    await pending;
    assert.equal(f.status(), "[Normal]");
    assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
    await f.command("start");
    assert.equal(f.status(), "[Planning]");
    await f.execute("plan_mode_complete", { plan: "# Independent plan" });
    const next = f.state();
    assert.ok(next.kind === "ready");
    assert.notEqual(next.document.id, checked.id);
    assert.notEqual(next.document.path, checked.path);
    assert.equal(await readFile(checked.path, "utf8"), savedBytes);
  },
);

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
  assert.ok(f.rawPi.getActiveTools().includes("grep"));
  assert.ok(!f.rawPi.getActiveTools().includes("write"));
  await f.command("exit");
  assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
});

test.each(["exit", "implementation"] as const)(
  "%s restores available captured tools, not independently disabled tools",
  async (exit) => {
    const f = await fixture();
    f.rawPi.setActiveTools(["read", "edit"]);
    if (exit === "implementation") await implementing(f);
    else {
      await f.command("start");
      await f.command("exit");
    }
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

test("verification receives only the current on-disk target; missing files cannot fall back to session copies", async () => {
  const inputs: VerificationInput[] = [];
  const f = await fixture(async (input) => {
    inputs.push(input);
    return RESULT;
  });
  const document = await implementing(f);
  const store = await f.store();
  const current = "# Current external edit\n\nImplement green.";
  const bytes = await readFile(document.path, "utf8");
  await writeFile(document.path, bytes.replace(PLAN, current));
  await f.command("verify");
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].target.plan, current);
  assert.equal(inputs[0].target.hash, planHash(current));
  assert.equal(inputs[0].target.document.path, document.path);
  assert.equal(f.status(), "[Normal]");
  assert.equal(await store.read(document), current);
  await unlink(document.path);
  await f.command("verify");
  assert.equal(inputs.length, 1);
  assert.equal(f.status(), "[Normal]");
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
  const f = await fixture(undefined, async () => named.promise);
  await f.command("start");
  assert.equal(f.naming.length, 0);
  assert.equal(f.status(), "[Planning]");
  await f.emit("input", { text: "Support uploading images", source: "interactive" });
  await f.emit("input", { text: "This later task must not be sent to naming", source: "interactive" });
  assert.deepEqual(f.naming, ["Support uploading images"]);
  const saving = f.execute("plan_mode_complete", { plan: PLAN });
  assert.deepEqual(await (await f.store()).list(), []);
  named.resolve("support-uploading-images");
  await saving;
  assert.equal(f.status(), "[Planning support-uploading-images]");
  const state = f.state();
  assert.ok(state.kind === "ready");
  assert.equal(state.workflow.task, "Support uploading images");
  await f.emit("session_tree");
  assert.equal(f.status(), "[Planning support-uploading-images]");
  assert.equal(f.naming.length, 1);
});

test.each(["exit", "replacement", "shutdown"] as const)("late naming is discarded on %s", async (event) => {
  const old = Promise.withResolvers<string>();
  let signal: AbortSignal | undefined;
  const f = await fixture(undefined, async (_registry, _task, _settings, input) => {
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
    assert.equal(f.status(), "[Planning]");
  }
});

test("manual verification snapshots once, leaves later edits untouched and returns to Normal", async () => {
  const entered = Promise.withResolvers<VerificationInput>();
  const finished = Promise.withResolvers<VerificationResult>();
  const f = await fixture(async (input) => {
    entered.resolve(input);
    return finished.promise;
  });
  const document = await implementing(f);
  const checking = f.command("verify");
  const input = await entered.promise;
  assert.equal(f.status(), "[Verifying blue-feature]");
  const raw = await readFile(document.path, "utf8");
  const changed = raw.replace(PLAN, "# Changed after check start");
  await writeFile(document.path, changed);
  assert.equal(input.target.plan, PLAN);
  finished.resolve(RESULT);
  await checking;
  assert.equal(f.status(), "[Normal]");
  assert.equal(f.implementation()?.lastCheck?.hash, planHash(PLAN));
  assert.equal(await readFile(document.path, "utf8"), changed);
  await f.command("resume");
  assert.equal(f.status(), "[Implementing blue-feature]");
});

test.each(["resolve", "reject"] as const)(
  "tree restoration of verification boundary ignores late %s",
  async (outcome) => {
    const entered = Promise.withResolvers<VerificationInput>();
    const finished = Promise.withResolvers<VerificationResult>();
    const f = await fixture(async (input) => {
      entered.resolve(input);
      return finished.promise;
    });
    const document = await implementing(f);
    const source = f.implementation();
    const checking = f.command("verify");
    // The boundary is durable even before the first asynchronous store read finishes.
    assert.equal(f.implementation()?.phase, "completed");
    assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
    const input = await entered.promise;
    assert.equal(input.implementation.id, source?.id);
    assert.equal(f.status(), "[Verifying blue-feature]");
    const boundary = structuredClone(f.entries);
    await f.emit("session_tree");
    assert.equal(input.signal.aborted, true);
    assert.deepEqual(f.entries, boundary, "restoration must not write through the old workflow");
    assert.equal(f.status(), "[Normal]");
    assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
    assert.equal(f.implementation()?.document.path, document.path);
    await f.emit("session_start", { reason: "reload" });
    assert.equal(f.status(), "[Normal]");
    assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
    if (outcome === "resolve") finished.resolve(RESULT);
    else finished.reject(new Error("Late checker failure"));
    await checking;
    assert.deepEqual(f.entries, boundary);
    assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
    assert.equal(f.status(), "[Normal]");
    await f.command("resume");
    assert.equal(f.status(), "[Implementing blue-feature]");
    await f.command("exit");
    await f.command("start");
    assert.equal(f.status(), "[Planning]");
    await f.execute("plan_mode_complete", { plan: "# Independent plan" });
    const next = f.state();
    assert.ok(next.kind === "ready");
    assert.notEqual(next.document.path, document.path);
  },
);

test.each(["session_tree", "session_start"] as const)(
  "%s restores another active workflow without stale checker writes",
  async (event) => {
    const entered = Promise.withResolvers<VerificationInput>();
    const finished = Promise.withResolvers<VerificationResult>();
    const f = await fixture(async (input) => {
      entered.resolve(input);
      return finished.promise;
    });
    await implementing(f);
    const otherBranch = structuredClone(f.entries);
    // Model a different branch's independently active implementation record.
    const record = otherBranch.findLast((entry) => entry.customType === "pi-plan-implementation");
    assert.ok(record);
    Object.assign(record.data as object, { id: "independent-implementation" });
    const checking = f.command("verify");
    const input = await entered.promise;
    f.entries.splice(0, f.entries.length, ...otherBranch);
    if (event === "session_start") {
      Object.assign(f.ctx, {
        sessionManager: { ...(f.ctx as ExtensionContext).sessionManager, getSessionId: () => "replacement" },
      });
    }
    await f.emit(event);
    assert.equal(input.signal.aborted, true);
    assert.equal(f.status(), "[Implementing blue-feature]");
    assert.equal(f.implementation()?.id, "independent-implementation");
    const tools = f.rawPi.getActiveTools();
    assert.ok(tools.includes("plan_mode_implementation_complete"));
    assert.deepEqual(f.entries, otherBranch);
    finished.resolve(RESULT);
    await checking;
    assert.deepEqual(f.entries, otherBranch);
    assert.deepEqual(f.rawPi.getActiveTools(), tools);
    assert.equal(f.status(), "[Implementing blue-feature]");
  },
);

test("shutdown cancels checking and persists Normal restoration rather than an active checked plan", async () => {
  const entered = Promise.withResolvers<void>();
  const f = await fixture(async (input) => {
    entered.resolve();
    await new Promise<void>((_resolve, reject) => {
      input.signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
    });
    return RESULT;
  });
  await implementing(f);
  const checking = f.command("verify");
  await entered.promise;
  await f.emit("session_shutdown");
  await checking;
  assert.equal(f.implementation()?.phase, "completed");
  await f.emit("session_start");
  assert.equal(f.status(), "[Normal]");
  assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
});
