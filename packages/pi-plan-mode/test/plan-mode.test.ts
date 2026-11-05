import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { IMPLEMENTATION_ENTRY, IMPLEMENTATION_HELPERS, restoreImplementation } from "../src/implementation-state.js";
import type { MenuLifecycle } from "../src/interactive-ui.js";
import planMode from "../src/plan-mode.js";
import { createPlanStore, type PlanRevision } from "../src/plan-store.js";
import { buildPlanModePrompt } from "../src/prompt.js";
import { DEFAULT_TOGGLE_SHORTCUT, type PlanModeSettings } from "../src/settings.js";
import { PLAN_STATE_ENTRY, restorePlanState } from "../src/state.js";
import type { VerificationInput, VerificationResult } from "../src/verification.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const BASELINE = ["read", "bash", "edit", "write"];
const PLAN = "# Simplify planning\n\nKeep only material decisions.";
type Action = "fresh" | "here" | "save" | "continue" | undefined;

async function fixture(
  config: {
    tools?: string[];
    shortcuts?: PlanModeSettings["shortcuts"];
    plansDirectory?: string;
    selectSaved?: (revisions: PlanRevision[]) => PlanRevision | undefined;
    instructions?: string;
    automatic?: boolean;
    verify?: (input: VerificationInput) => Promise<VerificationResult>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "plan-lifecycle-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await writeFile(join(root, "source.jsonl"), "source session");
  const mock = createMockPi({
    activeTools: BASELINE,
    allTools: [
      ...[...BASELINE, "grep", "find", "ls"].map(builtinTool),
      extensionTool("subagent"),
      extensionTool("nested_read"),
    ],
  });
  let branch: unknown[] | undefined;
  let action: Action;
  let chosenTools: string[] | undefined;
  let instructions = config.instructions ?? "Keep personal guidance.";
  let reviewHook: ((lifecycle: MenuLifecycle) => Promise<void>) | undefined;
  let settingsHook: (() => Promise<void>) | undefined;
  const reviews: string[] = [];
  const context = createMockContext({
    mode: "rpc",
    cwd,
    hasUI: true,
    editorText: "Unsent draft",
    sessionManager: {
      getSessionFile: () => join(root, "source.jsonl"),
      getBranch: () => branch ?? mock.entries.map((entry) => ({ type: "custom", ...entry })),
    },
  });
  const dependencies = {
    readSettings: async (): Promise<PlanModeSettings> => {
      await settingsHook?.();
      return {
        plansDirectory: config.plansDirectory ?? "plans",
        ...(config.shortcuts ? { shortcuts: config.shortcuts } : {}),
        ...(config.tools ? { tools: config.tools } : {}),
        ...(config.automatic !== undefined ? { verification: { automatic: config.automatic } } : {}),
      };
    },
    readInstructions: () => instructions,
    verify: config.verify,
    createStore: (
      directory: string,
      location?: Parameters<typeof createPlanStore>[1],
      _agent?: string,
      options?: Parameters<typeof createPlanStore>[3],
    ) => createPlanStore(directory, location, agentDir, options),
    loadUi: async () => ({
      reviewPlan: async (_ctx: unknown, text: string, _revision: PlanRevision, lifecycle: MenuLifecycle) => {
        reviews.push(text);
        await reviewHook?.(lifecycle);
        return action;
      },
      selectSavedPlan: async (_ctx: unknown, revisions: PlanRevision[]) =>
        config.selectSaved ? config.selectSaved(revisions) : revisions[0],
      selectPlanTools: async () => chosenTools,
    }),
  };
  await planMode(mock.pi, dependencies);
  async function emit(event: string, input: unknown = {}, ctx = context.ctx) {
    let result: unknown;
    for (const handler of mock.events.get(event) ?? []) {
      const next = await handler(input, ctx);
      if (next !== undefined) result = next;
      if (event === "tool_call" && next && typeof next === "object" && "block" in next && next.block) break;
    }
    return result;
  }
  const registeredCommand = mock.commands.get("plan");
  assert.ok(registeredCommand);
  const command = (args: string) => registeredCommand.handler(args, context.ctx);
  const execute = (name: string, params: unknown, signal = new AbortController().signal) => {
    const tool = mock.tools.find((candidate) => candidate.name === name);
    assert.ok(tool);
    return (
      tool.execute as (
        ...args: unknown[]
      ) => Promise<{ content: { text: string }[]; details: { path: string }; terminate?: boolean }>
    )("call", params, signal, undefined, context.ctx);
  };
  await emit("session_start");
  return {
    ...mock,
    ...context,
    cwd,
    agentDir,
    sourcePath: join(root, "source.jsonl"),
    draft: () => context.editorText,
    emit,
    command,
    execute,
    reviews,
    dependencies,
    toggle: async () => {
      Object.assign(context.ctx, { mode: "tui" });
      const shortcut = mock.shortcuts.get(config.shortcuts?.togglePlan ?? DEFAULT_TOGGLE_SHORTCUT);
      assert.ok(shortcut);
      await shortcut.handler(context.ctx);
    },
    state: () => restorePlanState(mock.entries.map((entry) => ({ type: "custom", ...entry }))),
    choose: (value: Action) => {
      action = value;
    },
    chooseTools: (value: string[]) => {
      chosenTools = value;
    },
    branch: (value: unknown[]) => {
      branch = value;
    },
    instructions: (value: string) => {
      instructions = value;
    },
    onReview: (hook: typeof reviewHook) => {
      reviewHook = hook;
    },
    onSettings: (hook: typeof settingsHook) => {
      settingsHook = hook;
    },
  };
}

test("default and configured shortcuts register once; disabling and reload replace the binding", async () => {
  for (const [shortcuts, keys] of [
    [undefined, [DEFAULT_TOGGLE_SHORTCUT]],
    [{ togglePlan: "shift+tab" }, ["shift+tab"]],
    [{ togglePlan: null }, []],
    [{}, [DEFAULT_TOGGLE_SHORTCUT]],
  ] as const) {
    const f = await fixture({ shortcuts });
    assert.deepEqual([...f.shortcuts.keys()], keys);
  }
  const f = await fixture();
  f.dependencies.readSettings = async () => ({ shortcuts: { togglePlan: "alt+p" } });
  assert.deepEqual([...f.shortcuts.keys()], [DEFAULT_TOGGLE_SHORTCUT]);
  const reloaded = createMockPi();
  await planMode(reloaded.pi, f.dependencies);
  assert.deepEqual([...reloaded.shortcuts.keys()], ["alt+p"]);
});

test("factory awaits shortcut settings; startup failure keeps commands and tools and reports once", async () => {
  const mock = createMockPi();
  const gate = Promise.withResolvers<PlanModeSettings>();
  const loading = planMode(mock.pi, { readSettings: () => gate.promise });
  assert.ok(mock.commands.has("plan"));
  assert.ok(mock.tools.some((tool) => tool.name === "plan_mode_complete"));
  assert.equal(mock.shortcuts.size, 0);
  gate.reject(new Error("invalid settings\u001b[31m"));
  await loading;
  assert.equal(mock.shortcuts.size, 0);
  const context = createMockContext({ mode: "tui" });
  for (let i = 0; i < 2; i++) {
    for (const handler of mock.events.get("session_start") ?? []) await handler({}, context.ctx);
  }
  const errors = context.notifications.filter((item) => item.message.includes("shortcut unavailable"));
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.level, "error");
  assert.ok(!errors[0]?.message.includes("\u001b"));
});

test("toggle enters and leaves directly without messages, review, effort changes, or editor mutation", async () => {
  const f = await fixture();
  await f.toggle();
  assert.equal(f.state().kind, "planning");
  assert.equal(f.statuses.get("plan-mode"), "plan active");
  assert.ok(!f.rawPi.getActiveTools().includes("write"));
  const prompt = promptEvent();
  await f.emit("before_agent_start", prompt);
  assert.ok(prompt.systemPromptOptions.sections.pi_plan_mode);
  await f.toggle();
  assert.equal(f.state().kind, "idle");
  assert.equal(f.statuses.get("plan-mode"), undefined);
  assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
  await f.emit("before_agent_start", prompt);
  assert.equal(prompt.systemPromptOptions.sections.pi_plan_mode, undefined);
  assert.equal(f.draft(), "Unsent draft");
  assert.deepEqual(f.sentUserMessages, []);
  assert.deepEqual(f.sentMessages, []);
  assert.deepEqual(f.thinkingLevels, []);
  assert.deepEqual(f.reviews, []);
});

test("toggle exits a ready plan without implementation or automatic review and preserves saved bytes", async () => {
  const f = await fixture();
  const saved = await ready(f);
  await f.toggle();
  await f.emit("agent_settled", { aborted: false });
  assert.equal(f.state().kind, "idle");
  assert.equal(await readFile(saved.details.path, "utf8"), PLAN);
  assert.deepEqual(f.sentUserMessages, []);
  assert.deepEqual(f.reviews, []);
  assert.equal(implementationOf(f), undefined);
  await f.toggle();
  const state = f.state();
  assert.equal(state.kind, "planning");
  assert.equal(state.workflow.series, undefined);
});

test("toggle rejects busy and pending states and ignores non-TUI contexts", async () => {
  for (const override of [{ isIdle: () => false }, { hasPendingMessages: () => true }]) {
    const f = await fixture();
    Object.assign(f.ctx, override);
    await f.toggle();
    assert.equal(f.state().kind, "idle");
    assert.match(f.notifications.at(-1)?.message ?? "", /settle/);
    assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
  }
  const f = await fixture();
  for (const mode of ["rpc", "print", "json"]) {
    Object.assign(f.ctx, { mode });
    await f.shortcuts.get(DEFAULT_TOGGLE_SHORTCUT)?.handler(f.ctx);
    assert.equal(f.state().kind, "idle");
  }
});

test("toggle and commands share a gate across asynchronous entry in either direction", async () => {
  for (const first of ["toggle", "command"]) {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    f.onSettings(() => gate.promise);
    const pending = first === "toggle" ? f.toggle() : f.command("start");
    await f.toggle();
    await f.command("start");
    assert.equal(f.notifications.filter((item) => item.message.includes("already open")).length, 2);
    gate.resolve();
    await pending;
    assert.equal(f.state().kind, "planning");
    assert.equal(f.entries.filter((entry) => entry.customType === PLAN_STATE_ENTRY).length, 1);
    await f.toggle();
    assert.equal(f.state().kind, "idle");
  }
});

test("toggle revalidates ownership after settings and store awaits", async () => {
  for (const stage of ["settings", "store"]) {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    if (stage === "settings")
      f.onSettings(() => {
        reached.resolve();
        return gate.promise;
      });
    else {
      // A fresh instance captures the blocked store dependency.
      await f.emit("session_shutdown");
      const makeStore = f.dependencies.createStore;
      f.dependencies.createStore = async (...args) => {
        reached.resolve();
        await gate.promise;
        return makeStore(...args);
      };
      f.events.clear();
      await planMode(f.pi, f.dependencies);
      await f.emit("session_start");
    }
    const pending = f.toggle();
    await reached.promise;
    await f.emit("session_shutdown");
    const other = createMockContext({ mode: "tui", cwd: f.cwd });
    await f.emit("session_start", {}, other.ctx);
    gate.resolve();
    await pending;
    assert.equal(f.state().kind, "idle");
    assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
    assert.deepEqual(f.sentUserMessages, []);
  }
});

test("failed toggle transitions roll back tools and release the command gate", async () => {
  const f = await fixture();
  const append = f.rawPi.appendEntry;
  f.rawPi.appendEntry = () => {
    throw new Error("persist failed");
  };
  await f.toggle();
  assert.equal(f.state().kind, "idle");
  assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
  assert.match(f.notifications.at(-1)?.message ?? "", /persist failed/);
  f.rawPi.appendEntry = append;
  await f.toggle();
  const planningTools = f.rawPi.getActiveTools();
  f.rawPi.appendEntry = () => {
    throw new Error("exit failed");
  };
  await f.toggle();
  assert.equal(f.state().kind, "planning");
  assert.deepEqual(f.rawPi.getActiveTools(), planningTools);
  f.rawPi.appendEntry = append;
  await f.toggle();
  assert.equal(f.state().kind, "idle");
});

test("toggle detaches implementation like plan start and rolls it back on entry failure", async () => {
  for (const fail of [false, true]) {
    const f = await fixture();
    await ready(f);
    f.choose("here");
    await f.command("");
    assert.equal(implementationOf(f)?.phase, "implementing");
    const append = f.rawPi.appendEntry;
    if (fail)
      f.rawPi.appendEntry = (type, data) => {
        if (type === PLAN_STATE_ENTRY) throw new Error("persist failed");
        append(type, data);
      };
    const messages = f.sentUserMessages.length;
    await f.toggle();
    assert.equal(f.state().kind, fail ? "idle" : "planning");
    assert.equal(implementationOf(f)?.phase, fail ? "implementing" : "detached");
    assert.equal(f.sentUserMessages.length, messages);
  }
});

test("custom legacy hints do not redirect new series and browsing uses the selected location", async () => {
  let target = "";
  let listed: PlanRevision[] = [];
  const f = await fixture({
    plansDirectory: "design/plans",
    selectSaved: (revisions) => {
      listed = revisions;
      return revisions.find((revision) => revision.path === target);
    },
  });
  const first = await ready(f);
  assert.equal(first.details.path.startsWith(`${f.agentDir}/pi-plan-mode/project/`), true);
  await f.command("save");
  const legacyDefault = await createPlanStore(f.cwd, "plans", f.agentDir);
  const legacyCustom = await createPlanStore(f.cwd, "design/plans", f.agentDir);
  const old = await legacyDefault.save("# Legacy default");
  const custom = await legacyCustom.save("# Legacy custom");
  target = custom.path;
  f.choose("continue");
  await f.command("saved");
  assert.deepEqual(
    new Set(listed.map((revision) => revision.path)),
    new Set([first.details.path, old.path, custom.path]),
  );
  assert.equal(f.reviews.at(-1), "# Legacy custom");
  await f.execute("plan_mode_complete", { plan: "# Legacy custom" });
  assert.equal((await legacyCustom.list()).length, 2);
  assert.equal((await legacyDefault.list()).length, 1);
  assert.equal(await legacyDefault.read(old), "# Legacy default");
});

test("old ready and implementation sessions restore their captured custom storage", async () => {
  const f = await fixture();
  const legacy = await createPlanStore(f.cwd, "old/custom", f.agentDir);
  const revision = await legacy.save(PLAN);
  f.rawPi.appendEntry(PLAN_STATE_ENTRY, {
    kind: "ready",
    workflow: {
      projectRoot: f.cwd,
      plansDirectory: "old/custom",
      instructions: "",
      previousTools: BASELINE,
      series: revision.series,
    },
    revision,
  });
  await f.emit("session_tree");
  f.choose("here");
  await f.command("");
  assert.deepEqual(f.reviews, [PLAN]);
  const tracked = restoreImplementation(f.entries.map((entry) => ({ type: "custom", ...entry })));
  assert.ok(tracked);
  assert.deepEqual(tracked.storage, legacy.storage);
  // Simulate a pre-locator implementation session entry, then restore it normally.
  const { storage: _storage, ...old } = tracked;
  f.rawPi.appendEntry(IMPLEMENTATION_ENTRY, { ...old, plansDirectory: "old/custom" });
  await f.emit("session_tree");
  await f.execute("plan_mode_update", { plan: "# Restored legacy update", reason: "User-requested change" });
  const revisions = await legacy.list();
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].series, revision.series);
  assert.equal(revisions[0].revision, 2);
});

test("old unfinished workflows start new series in the fixed layout", async () => {
  const f = await fixture();
  f.rawPi.appendEntry(PLAN_STATE_ENTRY, {
    kind: "planning",
    workflow: {
      projectRoot: f.cwd,
      plansDirectory: "old/custom",
      instructions: "",
      previousTools: BASELINE,
    },
  });
  await f.emit("session_tree");
  const result = await f.execute("plan_mode_complete", { plan: PLAN });
  assert.equal(result.details.path.startsWith(`${f.agentDir}/pi-plan-mode/project/`), true);
});

test("review errors leave readiness recoverable without repeating automatic presentation", async () => {
  const f = await fixture();
  const result = await ready(f);
  f.onReview(async () => {
    throw new Error("Review unavailable");
  });
  await f.emit("agent_settled", { aborted: false });
  const request = f.sentUserMessages.at(-1);
  assert.ok(request);
  await f.command(request.text.slice("/plan ".length));
  assert.equal(f.state().kind, "ready");
  assert.equal(await readFile(result.details.path, "utf8"), PLAN);
  assert.match(f.notifications.at(-1)?.message ?? "", /Open \/plan to retry/);
  await f.emit("agent_settled", { aborted: false });
  assert.equal(f.sentUserMessages.length, 1);
  f.onReview(undefined);
  await f.command("");
  assert.equal(f.reviews.length, 2);
});

test("automatic review dispatch is one-shot and requires the matching live token", async () => {
  const f = await fixture();
  await ready(f);
  assert.equal(f.reviews.length, 0, "tool execution must not show review");
  await f.emit("agent_settled", { aborted: false });
  const request = f.sentUserMessages.at(-1);
  assert.ok(request);
  assert.ok(request.text.startsWith("/plan __review "));
  assert.deepEqual(request.options, { expandPromptTemplates: true });
  await f.emit("agent_settled", { aborted: false });
  assert.equal(f.sentUserMessages.length, 1);
  await f.command("__review wrong-token");
  assert.equal(f.reviews.length, 0);
  await f.command(request.text.slice("/plan ".length));
  assert.deepEqual(f.reviews, [PLAN]);
  await f.command(request.text.slice("/plan ".length));
  assert.equal(f.reviews.length, 1);
  assert.equal(f.state().kind, "ready");
});

test("automatic command resolution uses helper provenance, not another extension's plan command", async () => {
  const f = await fixture();
  await ready(f);
  Object.assign(f.rawPi, {
    getCommands: () => [
      { name: "plan:1", source: "extension", sourceInfo: { path: "/foreign" } },
      { name: "plan:2", source: "extension", sourceInfo: extensionTool("plan_mode_complete").sourceInfo },
    ],
  });
  await f.emit("agent_settled", { aborted: false });
  assert.match(f.sentUserMessages.at(-1)?.text ?? "", /^\/plan:2 __review /);
});

test("aborted runs, non-interactive contexts, queued work, and continuations do not auto-review", async () => {
  for (const reason of ["aborted", "print", "json", "pending", "continuation"] as const) {
    const f = await fixture();
    await ready(f);
    if (reason === "print" || reason === "json") Object.assign(f.ctx, { mode: reason, hasUI: false });
    if (reason === "pending") Object.assign(f.ctx, { hasPendingMessages: () => true });
    if (reason === "continuation") await f.emit("agent_start");
    await f.emit("agent_settled", { aborted: reason === "aborted" });
    assert.equal(f.sentUserMessages.length, 0, reason);
    assert.equal(f.reviews.length, 0, reason);
  }
});

test("superseding work, navigation, shutdown, or manual review invalidates a dispatched request", async () => {
  for (const reason of ["work", "tree", "shutdown", "manual"] as const) {
    const f = await fixture();
    await ready(f);
    await f.emit("agent_settled", { aborted: false });
    const request = f.sentUserMessages.at(-1)?.text;
    assert.ok(request);
    if (reason === "work") await f.emit("before_agent_start", promptEvent());
    if (reason === "tree") await f.emit("session_tree");
    if (reason === "shutdown") await f.emit("session_shutdown");
    if (reason === "manual") await f.command("");
    await f.command(request.slice("/plan ".length));
    assert.equal(f.reviews.length, reason === "manual" ? 1 : 0, reason);
  }
});

test("legacy browsing and continuation retain the selected store through implementation", async () => {
  const f = await fixture();
  const legacy = await createPlanStore(f.cwd, "plans", f.agentDir);
  const first = await legacy.save(PLAN);
  f.choose("continue");
  await f.command("saved");
  const continued = f.state();
  assert.ok(continued.kind !== "idle");
  assert.deepEqual(continued.workflow.storage, legacy.storage);
  const result = await f.execute("plan_mode_complete", { plan: PLAN });
  assert.equal(result.details.path, first.path.replace("-01.md", "-02.md"));
  f.choose("here");
  await f.command("");
  const implementation = f.entries.findLast((entry) => entry.customType === "pi-plan-implementation")?.data as {
    storage: unknown;
  };
  assert.deepEqual(implementation.storage, legacy.storage);
  await f.execute("plan_mode_update", { plan: "# Revised legacy plan", reason: "Requested change" });
  assert.equal((await legacy.list())[0]?.revision, 3);
  assert.equal(await legacy.read(first), PLAN);
});

async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  await f.command("start");
  return f.execute("plan_mode_complete", { plan: PLAN });
}

function promptEvent() {
  return {
    messageType: "user",
    prompt: "Continue",
    systemPromptOptions: { sections: { other: "keep" } as Record<string, string>, selectedTools: [...BASELINE] },
  };
}

test("helpers start inactive; strict defaults select inspection tools and restore the baseline", async () => {
  const f = await fixture();
  assert.ok(f.tools.every((tool) => tool.defaultActive === false));
  assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
  await assert.rejects(f.execute("plan_mode_complete", { plan: PLAN }), /not active/);
  await f.command("start");
  assert.deepEqual(
    new Set(f.rawPi.getActiveTools()),
    new Set(["read", "grep", "find", "ls", "plan_mode_question", "plan_mode_complete"]),
  );
  assert.deepEqual(await f.emit("tool_call", { toolName: "read" }), undefined);
  for (const name of ["write", "edit", "bash", "subagent"]) {
    assert.equal(((await f.emit("tool_call", { toolName: name })) as { block: boolean }).block, true);
  }
  await f.command("exit");
  assert.equal(f.state().kind, "idle");
  assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
});

test("explicit tool changes take effect during planning without authorizing nested callees", async () => {
  const f = await fixture();
  await f.command("start");
  f.chooseTools(["read", "subagent", "bash"]);
  await f.command("tools");
  assert.equal(await f.emit("tool_call", { toolName: "subagent" }), undefined);
  assert.equal(
    await f.emit("tool_call", { toolName: "bash", input: { command: "arbitrary trusted command" } }),
    undefined,
  );
  assert.equal(
    ((await f.emit("tool_call", { toolName: "nested_read", parentToolCallId: "parent" })) as { block: boolean }).block,
    true,
  );
  await f.command("exit");
  assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
});

test("native prompt section is stable across turns, snapshots guidance, and is removed on exit", async () => {
  const f = await fixture();
  await f.command("start");
  f.instructions("Changed on disk");
  const event = promptEvent();
  await f.emit("before_agent_start", event);
  assert.equal(event.systemPromptOptions.sections.pi_plan_mode, buildPlanModePrompt("Keep personal guidance."));
  const second = promptEvent();
  await f.emit("before_agent_start", second);
  assert.deepEqual(event.systemPromptOptions, second.systemPromptOptions);
  assert.equal(event.systemPromptOptions.sections.other, "keep");
  assert.equal(f.events.has("context"), false);
  await f.command("exit");
  await f.emit("before_agent_start", event);
  assert.equal(event.systemPromptOptions.sections.pi_plan_mode, undefined);
});

test("completion saves a new numbered file before ready, and revisions keep their series", async () => {
  const f = await fixture();
  const first = await ready(f);
  assert.equal(first.terminate, true);
  assert.equal(f.state().kind, "ready");
  assert.equal(await readFile(first.details.path, "utf8"), PLAN);
  assert.match(first.details.path, /simplify-planning-01\.md$/);
  await f.emit("before_agent_start", promptEvent());
  assert.equal(f.state().kind, "planning");
  const updated = "# Changed title\n\nRevised decisions.";
  await assert.rejects(f.execute("plan_mode_complete", { plan: updated }), /change reason/);
  const second = await f.execute("plan_mode_complete", { plan: updated, reason: "The user changed the decisions." });
  assert.match(second.details.path, /simplify-planning-02\.md$/);
  assert.equal(await readFile(first.details.path, "utf8"), PLAN);
  assert.ok((await readFile(second.details.path, "utf8")).endsWith(updated));
  assert.deepEqual(await readdir(f.cwd), []);
});

test("Save for later exits without deleting files and saved plans can be reviewed in another workflow", async () => {
  const f = await fixture();
  const result = await ready(f);
  await f.command("save");
  assert.equal(f.state().kind, "idle");
  assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
  f.choose("continue");
  await f.command("saved");
  assert.equal(f.state().kind, "planning");
  assert.equal(f.reviews[0], PLAN);
  assert.ok(f.sentUserMessages.at(-1)?.text.includes(PLAN));
  const revision = await f.execute("plan_mode_complete", {
    plan: "# Another title\n\nNew brief.",
    reason: "User requested a new brief.",
  });
  assert.match(revision.details.path, /simplify-planning-02\.md$/);
  assert.ok(await readFile(result.details.path, "utf8"));
});

test("Implement here sends exactly the reviewed text and restores normal tools", async () => {
  const f = await fixture();
  await ready(f);
  f.choose("here");
  await f.command("");
  assert.equal(f.reviews.at(-1), PLAN);
  assert.ok(f.sentUserMessages.at(-1)?.text.endsWith(PLAN));
  assert.equal(f.state().kind, "idle");
  assert.deepEqual(f.rawPi.getActiveTools(), [...BASELINE, ...IMPLEMENTATION_HELPERS]);
  assert.equal(restoreImplementation(f.entries.map((entry) => ({ type: "custom", ...entry })))?.phase, "implementing");
});

test("fresh handoff transfers the plan and plain tracking data, not source history", async () => {
  const f = await fixture();
  await ready(f);
  f.choose("fresh");
  let kickoff = "";
  Object.assign(f.ctx as object, {
    newSession: async (options: {
      parentSession: string;
      setup?: unknown;
      withSession: (ctx: unknown) => Promise<void>;
    }) => {
      assert.match(options.parentSession, /source\.jsonl$/);
      assert.equal(typeof options.setup, "function");
      await f.emit("session_shutdown");
      await options.withSession({
        sendUserMessage: async (text: string) => {
          kickoff = text;
        },
      });
      return { cancelled: false };
    },
  });
  await f.command("");
  assert.ok(kickoff.endsWith(PLAN));
  assert.equal(kickoff.includes("Keep personal guidance"), false);
  assert.equal(f.state().kind, "idle", "successful handoff ends source ownership");
  assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
});

test("failed fresh replacement restores ready; partial kickoff recovers only in the destination editor", async () => {
  const f = await fixture();
  const saved = await ready(f);
  f.choose("fresh");
  Object.assign(f.ctx, {
    newSession: async () => {
      throw new Error("replacement failed");
    },
  });
  await f.command("");
  assert.equal(f.state().kind, "ready");
  assert.ok(!f.rawPi.getActiveTools().includes("write"));
  assert.match(f.notifications.at(-1)?.message ?? "", /replacement failed/);

  let draft = "";
  let recovery = "";
  Object.assign(f.ctx, {
    newSession: async (options: { withSession: (ctx: unknown) => Promise<void> }) => {
      await f.emit("session_shutdown");
      await options.withSession({
        sendUserMessage: async () => {
          throw new Error("kickoff failed");
        },
        ui: {
          setEditorText: (text: string) => {
            draft = text;
          },
          notify: (text: string) => {
            recovery = text;
          },
        },
      });
      return { cancelled: false };
    },
  });
  await f.command("");
  assert.equal(f.state().kind, "idle");
  assert.ok(draft.endsWith(PLAN));
  assert.ok(recovery);
  assert.equal(await readFile(saved.details.path, "utf8"), PLAN);
});

test("fresh handoff omits an allocated but unwritten parent session", async () => {
  const f = await fixture();
  await ready(f);
  await rm(f.sourcePath);
  let parent: string | undefined = "not called";
  Object.assign(f.ctx, {
    newSession: async (options: { parentSession?: string }) => {
      parent = options.parentSession;
      return { cancelled: false };
    },
  });
  f.choose("fresh");
  await f.command("");
  assert.equal(parent, undefined);
});

test("cancelled fresh replacement leaves source ready and restricted", async () => {
  const f = await fixture();
  await ready(f);
  const active = f.rawPi.getActiveTools();
  Object.assign(f.ctx as object, { newSession: async () => ({ cancelled: true }) });
  f.choose("fresh");
  await f.command("");
  assert.equal(f.state().kind, "ready");
  assert.deepEqual(f.rawPi.getActiveTools(), active);
});

test("persistence failure on handoff preserves ready state and its tool loadout", async () => {
  const f = await fixture();
  const result = await ready(f);
  const active = f.rawPi.getActiveTools();
  f.rawPi.appendEntry = () => {
    throw new Error("disk full");
  };
  f.choose("here");
  await f.command("");
  assert.equal(f.state().kind, "ready");
  assert.deepEqual(f.rawPi.getActiveTools(), active);
  assert.equal(f.sentUserMessages.length, 0);
  assert.ok(await readFile(result.details.path, "utf8"));
  assert.match(f.notifications.at(-1)?.message ?? "", /disk full/);
});

test("failed same-session kickoff restores ready state; no success is reported", async () => {
  const f = await fixture();
  await ready(f);
  f.rawPi.sendUserMessage = () => {
    throw new Error("delivery failed");
  };
  f.choose("here");
  await f.command("");
  assert.equal(f.state().kind, "ready");
  assert.ok(!f.rawPi.getActiveTools().includes("write"));
  assert.match(f.notifications.at(-1)?.message ?? "", /delivery failed/);
});

test("completion persistence failure keeps the file discoverable without claiming readiness", async () => {
  const f = await fixture();
  await f.command("start");
  const appendEntry = f.rawPi.appendEntry;
  f.rawPi.appendEntry = () => {
    throw new Error("disk full");
  };
  await assert.rejects(f.execute("plan_mode_complete", { plan: PLAN }), /saved at.*ready state could not be persisted/);
  assert.equal(f.state().kind, "planning");
  const store = await createPlanStore(f.cwd, undefined, f.agentDir);
  assert.equal((await store.list()).length, 1);
  f.rawPi.appendEntry = appendEntry;
  const retried = await f.execute("plan_mode_complete", { plan: PLAN });
  assert.match(retried.details.path, /simplify-planning-02\.md$/);
  assert.equal((await store.list()).length, 2);
});

test("cancelled completion cannot save or mark ready", async () => {
  const f = await fixture();
  await f.command("start");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.execute("plan_mode_complete", { plan: PLAN }, controller.signal));
  assert.equal(f.state().kind, "planning");
  assert.equal((await (await createPlanStore(f.cwd, "plans", f.agentDir)).list()).length, 0);
});

test("branch restoration selects current state and keeps guidance, series and previous tools", async () => {
  const f = await fixture();
  await ready(f);
  const branch = f.entries.map((entry) => ({ type: "custom", ...entry }));
  await f.command("exit");
  f.branch(branch);
  await f.emit("session_tree");
  assert.ok(f.rawPi.getActiveTools().includes("plan_mode_complete"));
  const prompt = promptEvent();
  await f.emit("before_agent_start", prompt);
  assert.equal(prompt.systemPromptOptions.sections.pi_plan_mode, buildPlanModePrompt("Keep personal guidance."));
  f.branch([{ type: "custom", customType: PLAN_STATE_ENTRY, data: { kind: "idle" } }]);
  await f.emit("session_tree");
  assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
});

test("a stale review cannot implement after session replacement", async () => {
  const f = await fixture();
  await ready(f);
  f.choose("here");
  f.onReview(async (lifecycle) => {
    await f.emit("session_shutdown");
    const other = createMockContext({ mode: "rpc", cwd: f.cwd });
    await f.emit("session_start", {}, other.ctx);
    assert.equal(lifecycle.isCurrent(), false);
    assert.equal(lifecycle.signal.aborted, true);
  });
  await f.command("");
  assert.equal(f.sentUserMessages.length, 0);
});

test("cancelled entry cannot send its old request into a restored workflow", async () => {
  const f = await fixture();
  await f.command("start");
  const planningBranch = f.entries.map((entry) => ({ type: "custom", ...entry }));
  await f.command("exit");
  const gate = Promise.withResolvers<void>();
  f.onSettings(() => gate.promise);
  const pending = f.command("an obsolete request");
  f.branch(planningBranch);
  await f.emit("session_tree");
  gate.resolve();
  await pending;
  assert.equal(f.sentUserMessages.length, 0);
  assert.ok(!f.rawPi.getActiveTools().includes("write"));
});

test("handoff sends the reviewed snapshot even when the file changes during review", async () => {
  const f = await fixture();
  const saved = await ready(f);
  f.onReview(() => writeFile(saved.details.path, "# Changed after review"));
  f.choose("here");
  await f.command("");
  assert.ok(f.sentUserMessages.at(-1)?.text.endsWith(PLAN));
  assert.equal(await readFile(saved.details.path, "utf8"), "# Changed after review");
});

const adherenceResult: VerificationResult = {
  model: { provider: "offline", id: "checker" },
  report: {
    status: "adherent",
    summary: "Implemented.",
    requirements: [
      { requirement: "Keep material decisions", revision: "1", status: "implemented", evidence: "src/example.ts:1" },
    ],
    changes: [],
    deviations: [],
    limitations: [],
  },
};
const implementationOf = (f: Awaited<ReturnType<typeof fixture>>) =>
  restoreImplementation(f.entries.map((entry) => ({ type: "custom", ...entry })));

test("implementation updates require reasons, preserve baseline, and completion checks by default", async () => {
  const checked: VerificationInput[] = [];
  const f = await fixture({
    verify: async (input) => {
      checked.push(input);
      return structuredClone(adherenceResult);
    },
  });
  await ready(f);
  f.choose("here");
  await f.command("");
  const baseline = implementationOf(f);
  assert.ok(baseline);
  await assert.rejects(f.execute("plan_mode_update", { plan: "# Changed\n\nNew requirement" }), /reason/);
  await f.execute("plan_mode_update", {
    plan: "# Changed\n\nNew requirement",
    reason: "User requested a new requirement.",
  });
  const revised = implementationOf(f);
  assert.ok(revised);
  assert.equal(revised.id, baseline.id);
  assert.equal(revised.revisions.length, 2);
  assert.deepEqual(revised.revisions[0], baseline.revisions[0]);
  assert.equal(revised.revisions[1].revision.history?.parent.hash, baseline.revisions[0].hash);
  await f.emit("session_start");
  const recovered = await f.execute("plan_mode_implementation_status", {});
  assert.ok(recovered.content[0].text.includes("# Changed\n\nNew requirement"));
  const prompt = promptEvent();
  await f.emit("before_agent_start", prompt);
  assert.match(prompt.systemPromptOptions.sections.pi_plan_implementation, /BEFORE implementing/);
  const completed = await f.execute("plan_mode_implementation_complete", {});
  assert.equal(completed.terminate, true);
  assert.equal(checked.length, 1);
  assert.equal(checked[0].implementation.revisions.length, 2);
  assert.equal(implementationOf(f)?.phase, "completed");
  assert.equal(implementationOf(f)?.lastCheck?.status, "adherent");
  assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
  await assert.rejects(f.execute("plan_mode_implementation_complete", {}), /not active/);
  await f.command("resume");
  assert.equal(implementationOf(f)?.phase, "implementing");
  assert.equal(implementationOf(f)?.lastCheck, undefined);
});

test("explicit automatic off avoids the checker; manual verification works after exit", async () => {
  let calls = 0;
  const f = await fixture({
    automatic: false,
    verify: async () => {
      calls++;
      return structuredClone(adherenceResult);
    },
  });
  await ready(f);
  f.choose("here");
  await f.command("");
  await f.emit("agent_end");
  assert.equal(calls, 0);
  const result = await f.execute("plan_mode_implementation_complete", {});
  assert.match(result.content[0].text, /not checked/);
  assert.equal(calls, 0);
  await f.command("exit");
  Object.assign(f.ctx, { hasUI: false });
  await f.command("verify");
  assert.equal(calls, 1);
  assert.equal(f.sentMessages.length, 1);
});

test("tampered history prevents verification and session replacement suppresses stale results", async () => {
  let calls = 0;
  const finished = Promise.withResolvers<VerificationResult>();
  const entered = Promise.withResolvers<void>();
  const f = await fixture({
    verify: async () => {
      calls++;
      entered.resolve();
      return finished.promise;
    },
  });
  await ready(f);
  f.choose("here");
  await f.command("");
  const tracked = implementationOf(f);
  assert.ok(tracked);
  await writeFile(tracked.revisions[0].revision.path, "# Tampered");
  const failed = await f.execute("plan_mode_implementation_complete", {});
  assert.match(failed.content[0].text, /changed on disk/);
  assert.equal(calls, 0);
  await writeFile(tracked.revisions[0].revision.path, tracked.revisions[0].plan);
  await f.command("resume");
  const pending = f.execute("plan_mode_implementation_complete", {});
  await entered.promise;
  await f.emit("session_shutdown");
  Object.defineProperty(f.ctx, "sessionManager", {
    configurable: true,
    get: () => {
      throw new Error("Stale source context touched");
    },
  });
  finished.resolve(structuredClone(adherenceResult));
  const cancelled = await pending;
  assert.match(cancelled.content[0].text, /cancelled/);
  assert.equal(
    f.entries.filter((entry) => entry.customType === "pi-plan-check").length,
    1,
    "only the earlier failed attempt was persisted",
  );
});

test("malformed current state does not reconstruct a workflow from prose or unrelated entries", () => {
  assert.deepEqual(restorePlanState([{ type: "custom", customType: PLAN_STATE_ENTRY, data: { kind: "ready" } }]), {
    kind: "idle",
  });
  assert.deepEqual(restorePlanState([{ type: "message", message: { role: "assistant", content: PLAN } }]), {
    kind: "idle",
  });
});
