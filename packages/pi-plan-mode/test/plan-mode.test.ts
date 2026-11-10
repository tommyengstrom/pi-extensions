import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditToolDefinition, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, test, vi } from "vitest";
import { ARTIFACT_TOOLS, type ArtifactReference } from "../src/artifacts.js";
import { IMPLEMENTATION_ENTRY, IMPLEMENTATION_HELPERS, restoreImplementation } from "../src/implementation-state.js";
import type { MenuLifecycle } from "../src/interactive-ui.js";
import planMode from "../src/plan-mode.js";
import { createPlanStore, type PlanRevision, type PlanStore, planHash } from "../src/plan-store.js";
import { readPlanModeBasePrompt } from "../src/planning-instructions.js";
import type { ProgressRunner } from "../src/progress-runner.js";
import { buildPlanModePrompt, DEFAULT_PLAN_MODE_PROMPT } from "../src/prompt.js";
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
    basePrompt?: string;
    automatic?: boolean;
    verify?: (input: VerificationInput) => Promise<VerificationResult>;
    progressRunner?: ProgressRunner;
    wrapStore?: (store: PlanStore) => PlanStore;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "plan-lifecycle-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  if (config.basePrompt !== undefined) await writeFile(join(agentDir, "pi-plan-mode-prompt.md"), config.basePrompt);
  await writeFile(join(root, "source.jsonl"), "source session");
  const mock = createMockPi({
    activeTools: BASELINE,
    allTools: [
      ...[...BASELINE, "grep", "find", "ls"].map(builtinTool),
      extensionTool("subagent"),
      extensionTool("nested_read"),
      ...ARTIFACT_TOOLS.map(extensionTool),
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
      getSessionId: () => "test-parent-session",
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
    readBasePrompt: () => readPlanModeBasePrompt(join(agentDir, "pi-plan-mode-prompt.md")),
    verify: config.verify,
    progressRunner: config.progressRunner,
    createStore: async (
      directory: string,
      location?: Parameters<typeof createPlanStore>[1],
      _agent?: string,
      options?: Parameters<typeof createPlanStore>[3],
    ) => {
      const store = await createPlanStore(directory, location, agentDir, options);
      return config.wrapStore?.(store) ?? store;
    },
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
  const command = (args: string) => {
    const current = mock.commands.get("plan");
    assert.ok(current);
    return current.handler(args, context.ctx);
  };
  const execute = <Details = { path: string }>(
    name: string,
    params: unknown,
    signal = new AbortController().signal,
  ) => {
    const tool = mock.tools.find((candidate) => candidate.name === name);
    assert.ok(tool);
    return (
      tool.execute as (
        ...args: unknown[]
      ) => Promise<{ content: { text: string }[]; details: Details; terminate?: boolean }>
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
    new Set(["read", "grep", "find", "ls", "plan_mode_question", "plan_mode_complete", "plan_mode_edit"]),
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

test.each([undefined, "# Custom protocol\n\nUse a checklist, without estimates."])(
  "base prompt %s is captured across turns, revisions, restoration and new workflows",
  async (basePrompt) => {
    const f = await fixture({ basePrompt });
    await f.command("start");
    const captured = f.state();
    assert.equal(captured.kind, "planning");
    assert.equal(captured.workflow.basePrompt, basePrompt ?? DEFAULT_PLAN_MODE_PROMPT);
    const expected = buildPlanModePrompt("Keep personal guidance.", captured.workflow.basePrompt);
    const path = join(f.agentDir, "pi-plan-mode-prompt.md");
    await writeFile(path, "# Changed on disk");
    f.instructions("Changed guidance");
    const assertPrompt = async () => {
      const event = promptEvent();
      await f.emit("before_agent_start", event);
      const actual = event.systemPromptOptions.sections.pi_plan_mode;
      assert.ok(actual.startsWith(expected));
      const state = f.state();
      const base =
        state.kind === "ready" ? state.revision : state.kind === "planning" ? state.workflow.parent : undefined;
      if (base) assert.ok(actual.includes(JSON.stringify(base.path)));
      else assert.equal(actual, expected);
      assert.equal(event.systemPromptOptions.sections.other, "keep");
    };
    await assertPrompt();
    await assertPrompt();
    // Completion accepts custom style and no estimate; it does not authorize implementation.
    const result = await f.execute("plan_mode_complete", { plan: "- Update the parser.\n- Test Unicode." });
    assert.equal(await readFile(result.details.path, "utf8"), "- Update the parser.\n- Test Unicode.");
    assert.equal(f.state().kind, "ready");
    assert.equal(implementationOf(f), undefined);
    assert.equal(((await f.emit("tool_call", { toolName: "write" })) as { block: boolean }).block, true);
    await assertPrompt();
    await f.execute("plan_mode_complete", { plan: "- Update the parser.\n- Test Unicode." });
    const branch = f.entries.map((entry) => ({ type: "custom", ...entry }));
    // Invalid current files must not be read during restoration.
    await writeFile(path, Buffer.from([0xff]));
    await f.command("exit");
    f.branch(branch);
    await f.emit("session_tree");
    await assertPrompt();
    await f.emit("session_shutdown");
    f.events.clear();
    await planMode(f.pi, f.dependencies);
    await f.emit("session_start");
    await assertPrompt();
    await f.emit("session_compact");
    await assertPrompt();
    await f.command("exit");
    await writeFile(path, "# Changed on disk");
    await f.command("start");
    const next = promptEvent();
    await f.emit("before_agent_start", next);
    assert.equal(
      next.systemPromptOptions.sections.pi_plan_mode,
      buildPlanModePrompt("Changed guidance", "# Changed on disk"),
    );
  },
);

test("legacy workflows restore the built-in base without consulting today's replacement", async () => {
  const f = await fixture({ basePrompt: "Today's replacement" });
  await f.command("start");
  const state = f.state();
  assert.equal(state.kind, "planning");
  delete state.workflow.basePrompt;
  f.branch([{ type: "custom", customType: PLAN_STATE_ENTRY, data: state }]);
  await f.emit("session_tree");
  const event = promptEvent();
  await f.emit("before_agent_start", event);
  assert.equal(event.systemPromptOptions.sections.pi_plan_mode, buildPlanModePrompt("Keep personal guidance."));
  await f.execute("plan_mode_complete", { plan: PLAN });
  const restored = f.state();
  assert.equal(restored.kind, "ready");
  assert.equal(restored.workflow.basePrompt, DEFAULT_PLAN_MODE_PROMPT);
});

test("invalid replacement blocks activation without detaching implementation or changing tools", async () => {
  for (const implementing of [false, true]) {
    const f = await fixture();
    if (implementing) {
      await ready(f);
      f.choose("here");
      await f.command("");
    }
    const before = structuredClone(f.entries);
    const tools = f.rawPi.getActiveTools();
    await writeFile(join(f.agentDir, "pi-plan-mode-prompt.md"), Buffer.from([0xff]));
    await f.command("start");
    assert.match(f.notifications.at(-1)?.message ?? "", /pi-plan-mode-prompt.md.*valid UTF-8/);
    assert.deepEqual(f.entries, before);
    assert.deepEqual(f.rawPi.getActiveTools(), tools);
    await writeFile(join(f.agentDir, "pi-plan-mode-prompt.md"), "Recovered prompt");
    await f.command("start");
    assert.equal(f.state().kind, "planning");
  }
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
  const second = await f.execute("plan_mode_complete", { plan: updated });
  const revised = f.state();
  assert.equal(revised.kind, "ready");
  assert.equal(revised.revision.history?.reason, undefined);
  assert.equal(revised.revision.history?.parent.hash, planHash(PLAN));
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
  assert.ok(
    prompt.systemPromptOptions.sections.pi_plan_mode.startsWith(buildPlanModePrompt("Keep personal guidance.")),
  );
  const restored = f.state();
  assert.equal(restored.kind, "planning");
  assert.ok(prompt.systemPromptOptions.sections.pi_plan_mode.includes(JSON.stringify(restored.workflow.parent?.path)));
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
    status: "ok",
    motivation: "Implemented. See `src/example.ts:1`.",
  },
};
const implementationOf = (f: Awaited<ReturnType<typeof fixture>>) =>
  restoreImplementation(f.entries.map((entry) => ({ type: "custom", ...entry })));

test("busy progress toggle bypasses command gate without weakening other guards; completion and tree clean up", async () => {
  const requests: Parameters<ProgressRunner>[0][] = [];
  const pending = Promise.withResolvers<string>();
  const f = await fixture({
    progressRunner: async (request) => {
      requests.push(request);
      return pending.promise;
    },
    automatic: false,
  });
  await ready(f);
  f.choose("here");
  await f.command("");
  Object.assign(f.ctx, {
    isIdle: () => false,
    hasPendingMessages: () => true,
    modelRegistry: { find: () => ({ reasoning: false, contextWindow: 128000 }) },
  });
  vi.useFakeTimers();
  try {
    await f.command("progress");
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(requests.length, 1);
    assert.ok(Array.isArray(f.widgets.get("plan-progress")));
    await f.command("start");
    assert.match(f.notifications.at(-1)?.message ?? "", /settle/);
    await f.emit("before_agent_start", promptEvent());
    await f.emit("input", { text: "next work", source: "rpc" });
    assert.equal(requests[0].signal.aborted, false);
    await f.command("cancel");
    assert.equal(requests[0].signal.aborted, false);
    await f.command("progress");
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(f.widgets.get("plan-progress"), undefined);
    pending.resolve("- Reported work");
    await vi.advanceTimersByTimeAsync(0);
    await f.command("progress");
    await vi.advanceTimersByTimeAsync(0);
    await f.execute("plan_mode_implementation_complete", {});
    assert.match(String(f.widgets.get("plan-progress")), /completed tracking; not verified/);
    await f.emit("session_tree");
    assert.equal(f.widgets.get("plan-progress"), undefined);
  } finally {
    vi.useRealTimers();
    await f.emit("session_shutdown");
  }
});

test("progress opens and closes while adherence checking holds the shared command gate", async () => {
  const checking = Promise.withResolvers<VerificationResult>();
  const started = Promise.withResolvers<void>();
  let assessments = 0;
  const f = await fixture({
    verify: async () => {
      started.resolve();
      return checking.promise;
    },
    progressRunner: async () => {
      assessments++;
      return "- Reported work";
    },
  });
  await ready(f);
  f.choose("here");
  await f.command("");
  const ctx = f.ctx as ExtensionContext;
  Object.assign(ctx.ui, {
    select: async (_title: string, _options: string[], options: { signal: AbortSignal }) =>
      new Promise((resolve) => options.signal.addEventListener("abort", () => resolve(undefined), { once: true })),
  });
  Object.assign(ctx, { modelRegistry: { find: () => ({ reasoning: false, contextWindow: 128000 }) } });
  const verification = f.command("verify");
  await started.promise;
  vi.useFakeTimers();
  try {
    await f.command("progress");
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(assessments, 1);
    await f.command("settings");
    assert.match(f.notifications.at(-1)?.message ?? "", /already open/);
    await f.command("progress");
    assert.equal(f.widgets.get("plan-progress"), undefined);
    checking.resolve(structuredClone(adherenceResult));
    await verification;
  } finally {
    vi.useRealTimers();
    await f.emit("session_shutdown");
  }
});

test("progress refuses non-interactive mode and absent implementation without inference", async () => {
  const f = await fixture({
    progressRunner: async () => {
      throw new Error("must not run");
    },
  });
  await f.command("progress");
  assert.match(f.notifications.at(-1)?.message ?? "", /No active tracked implementation/);
  for (const mode of ["print", "json"]) {
    Object.assign(f.ctx, { mode, hasUI: false });
    await assert.rejects(async () => f.command("progress"), /TUI or RPC/);
  }
});

test("reasonless implementation updates preserve baseline, restore, and verify by default", async () => {
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
  await f.execute("plan_mode_update", { plan: "# Changed\n\nNew requirement" });
  const revised = implementationOf(f);
  assert.ok(revised);
  assert.equal(revised.id, baseline.id);
  assert.equal(revised.revisions.length, 2);
  assert.deepEqual(revised.revisions[0], baseline.revisions[0]);
  assert.equal(revised.revisions[1].revision.history?.parent.hash, baseline.revisions[0].hash);
  await f.emit("session_start");
  const recovered = await f.execute("plan_mode_implementation_status", {});
  assert.ok(recovered.content[0].text.includes("# Changed\n\nNew requirement"));
  assert.match(recovered.content[0].text, /Reason: Not supplied/);
  const prompt = promptEvent();
  await f.emit("before_agent_start", prompt);
  assert.match(prompt.systemPromptOptions.sections.pi_plan_implementation, /BEFORE implementing/);
  const completed = await f.execute("plan_mode_implementation_complete", {});
  assert.equal(completed.terminate, true);
  assert.equal(checked.length, 1);
  assert.equal(checked[0].implementation.revisions.length, 2);
  assert.equal(implementationOf(f)?.phase, "completed");
  assert.equal(implementationOf(f)?.lastCheck?.status, "ok");
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

type Fixture = Awaited<ReturnType<typeof fixture>>;
type EditDetails = { revision: PlanRevision; sourcePath: string; diff: string; patch: string };
function editPlan(f: Fixture, path: string, oldText: string, newText: string, signal?: AbortSignal) {
  return f.execute<EditDetails>("plan_mode_edit", { path, edits: [{ oldText, newText }] }, signal);
}
async function beginImplementation(f: Fixture) {
  const saved = await ready(f);
  f.choose("here");
  await f.command("");
  return saved;
}

test("edit registers once with the SDK schema and is gated by planning or tracked implementation ownership", async () => {
  const f = await fixture({ automatic: false });
  const edit = f.tools.filter((tool) => tool.name === "plan_mode_edit");
  assert.equal(edit.length, 1);
  assert.equal(edit[0].defaultActive, false);
  assert.equal(edit[0].executionMode, "sequential");
  assert.deepEqual(edit[0].parameters, createEditToolDefinition(f.cwd).parameters);
  for (const name of ["plan_mode_complete", "plan_mode_update"]) {
    const tool = f.tools.find((tool) => tool.name === name);
    assert.ok(tool);
    assert.deepEqual((tool.parameters as { required: string[] }).required, ["plan"]);
  }
  const assertGate = async (allowed: boolean) => {
    assert.equal(f.rawPi.getActiveTools().includes("plan_mode_edit"), allowed);
    for (const parentToolCallId of [undefined, "orchestrator"]) {
      const result = await f.emit("tool_call", { toolName: "plan_mode_edit", parentToolCallId });
      if (allowed && (parentToolCallId === undefined || f.state().kind === "idle")) assert.equal(result, undefined);
      else assert.equal((result as { block: boolean }).block, true);
    }
    if (!allowed)
      await assert.rejects(editPlan(f, "/unused.md", "old", "new"), /not active|requires|active.*implementation/i);
  };
  await assertGate(false);
  const saved = await ready(f);
  await assertGate(true);
  const other = createMockContext({ cwd: f.cwd });
  assert.equal(
    (
      (await f.emit("tool_call", { toolName: "plan_mode_edit", parentToolCallId: "other" }, other.ctx)) as {
        block: boolean;
      }
    ).block,
    true,
  );
  assert.equal(
    ((await f.emit("tool_call", { toolName: "write", parentToolCallId: "orchestrator" })) as { block: boolean }).block,
    true,
  );
  f.choose("here");
  await f.command("");
  await assertGate(true);
  await f.execute("plan_mode_implementation_complete", {});
  await assertGate(false);
  await f.command("resume");
  await assertGate(true);
  await f.command("exit");
  await assertGate(false);
  await f.command("start");
  await assertGate(true);
  await f.emit("session_tree");
  await assertGate(true);
  assert.equal(f.tools.filter((tool) => tool.name === "plan_mode_edit").length, 1);
  await f.emit("session_shutdown");
  await assertGate(false);
  assert.equal(await readFile(saved.details.path, "utf8"), PLAN);
});

test("planning edit needs a saved base, chains ready and continuation revisions, and edits bodies rather than metadata", async () => {
  const publications: Parameters<PlanStore["save"]>[1][] = [];
  const f = await fixture({
    wrapStore: (store) => ({
      ...store,
      save: async (plan, options) => {
        publications.push(options);
        return store.save(plan, options);
      },
    }),
  });
  await f.command("start");
  await assert.rejects(editPlan(f, join(f.cwd, "missing.md"), "old", "new"), /saved|base|complete/i);
  assert.equal(publications.length, 0);
  const first = await f.execute("plan_mode_complete", { plan: PLAN });
  const second = await editPlan(f, first.details.path, "material", "important");
  assert.equal(second.terminate, true);
  assert.equal(second.details.sourcePath, first.details.path);
  assert.equal(second.details.revision.revision, 2);
  assert.equal(second.details.revision.history?.reason, undefined);
  assert.equal(publications.at(-1)?.parentPlan, PLAN);
  const secondBody = PLAN.replace("material", "important");
  const store = await createPlanStore(f.cwd, undefined, f.agentDir);
  assert.equal(await store.read(second.details.revision), secondBody);
  const secondBytes = await readFile(second.details.revision.path, "utf8");
  assert.ok(secondBytes.startsWith("<!-- pi-plan-revision-v1:"));
  assert.equal(await readFile(first.details.path, "utf8"), PLAN);
  const text = second.content.map((part) => part.text).join("\n");
  assert.ok(text.includes(second.details.revision.path));
  assert.ok(text.includes(second.details.diff));
  assert.equal(text.includes(secondBody), false, "edit results must not echo the full plan");
  assert.equal("plan" in second.details, false);
  assert.equal(f.state().kind, "ready");
  assert.equal(implementationOf(f), undefined);
  assert.deepEqual(f.reviews, []);
  const before = structuredClone(f.entries);
  await assert.rejects(editPlan(f, first.details.path, "material", "obsolete"), /selected|current|active/i);
  await assert.rejects(
    editPlan(f, second.details.revision.path, "<!-- pi-plan-revision-v1:", "changed"),
    /Could not find/,
  );
  assert.deepEqual(f.entries, before);
  assert.equal((await store.list()).length, 2);
  await f.emit("before_agent_start", promptEvent());
  assert.equal(f.state().kind, "planning");
  const third = await editPlan(f, second.details.revision.path, "important", "essential");
  assert.equal(publications.at(-1)?.parentPlan, secondBody);
  assert.equal(third.details.revision.series, second.details.revision.series);
  assert.deepEqual(third.details.revision.history?.parent, {
    series: second.details.revision.series,
    revision: 2,
    hash: planHash(secondBody),
  });
  assert.equal(await store.read(third.details.revision), PLAN.replace("material", "essential"));
  assert.equal(await readFile(second.details.revision.path, "utf8"), secondBytes);
  await f.emit("agent_settled", { aborted: false });
  const request = f.sentUserMessages.at(-1)?.text;
  assert.ok(request);
  assert.ok(request.startsWith("/plan __review "));
  await f.command(request.slice("/plan ".length));
  assert.deepEqual(f.reviews, [PLAN.replace("material", "essential")]);
  await f.emit("agent_settled", { aborted: false });
  assert.equal(f.sentUserMessages.length, 1);
});

test("continuing an older selected plan edits that parent, not the newest file in its series", async () => {
  let selected = "";
  const f = await fixture({ selectSaved: (revisions) => revisions.find((revision) => revision.path === selected) });
  const first = await ready(f);
  selected = first.details.path;
  const newer = await f.execute("plan_mode_complete", { plan: "# Newer alternative\n\nDifferent requirements." });
  const newerBytes = await readFile(newer.details.path, "utf8");
  await f.command("save");
  f.choose("continue");
  await f.command("saved");
  const edited = await editPlan(f, selected, "material", "selected");
  assert.equal(edited.details.revision.revision, 3);
  assert.equal(edited.details.revision.history?.parent.revision, 1);
  assert.equal(edited.details.revision.history?.parent.hash, planHash(PLAN));
  const store = await createPlanStore(f.cwd, undefined, f.agentDir);
  assert.equal(await store.read(edited.details.revision), PLAN.replace("material", "selected"));
  assert.equal(await readFile(selected, "utf8"), PLAN);
  assert.equal(await readFile(newer.details.path, "utf8"), newerBytes);
});

test("implementation edits preserve the baseline, clear checks/completion, restore reasonless history and keep running", async () => {
  const checked: VerificationInput[] = [];
  const f = await fixture({
    verify: async (input) => {
      checked.push(input);
      return structuredClone(adherenceResult);
    },
  });
  const first = await beginImplementation(f);
  const baseline = implementationOf(f);
  assert.ok(baseline);
  f.rawPi.appendEntry(IMPLEMENTATION_ENTRY, {
    ...baseline,
    completion: "previous completion",
    lastCheck: {
      status: "adherent",
      timestamp: new Date().toISOString(),
      revisionHash: baseline.revisions[0].hash,
    },
  });
  await f.emit("session_tree");
  const second = await editPlan(f, first.details.path, "material", "important");
  assert.equal(second.terminate, false);
  const revised = implementationOf(f);
  assert.ok(revised);
  assert.equal(revised.id, baseline.id);
  assert.equal(revised.phase, "implementing");
  assert.deepEqual(revised.revisions[0], baseline.revisions[0]);
  assert.equal(revised.revisions.length, 2);
  assert.equal(revised.lastCheck, undefined);
  assert.equal(revised.completion, undefined);
  assert.equal(revised.revisions[1].revision.history?.parent.hash, baseline.revisions[0].hash);
  assert.equal(revised.revisions[1].revision.history?.reason, undefined);
  assert.equal(await readFile(first.details.path, "utf8"), PLAN);
  const secondBytes = await readFile(second.details.revision.path, "utf8");
  await assert.rejects(editPlan(f, first.details.path, "material", "obsolete"), /selected|current|active/i);
  await f.emit("session_start");
  const status = await f.execute("plan_mode_implementation_status", {});
  assert.match(status.content[0].text, /Reason: Not supplied/);
  assert.ok(status.content[0].text.includes(second.details.revision.path));
  const third = await editPlan(f, second.details.revision.path, "important", "essential");
  assert.equal(third.terminate, false);
  assert.equal(await readFile(second.details.revision.path, "utf8"), secondBytes);
  await f.emit("agent_settled", { aborted: false });
  assert.equal(f.reviews.length, 1, "implementation edits do not request approval again");
  assert.equal(f.sentUserMessages.length, 1, "only the implementation kickoff is sent");
  await f.execute("plan_mode_implementation_complete", {});
  assert.equal(checked.length, 1);
  assert.equal(checked[0].implementation.revisions.length, 3);
  assert.equal(implementationOf(f)?.lastCheck?.status, "ok");
});

test.each(["planning", "implementing"] as const)(
  "%s edit rejects changed source bytes before publication",
  async (mode) => {
    let tamper = false;
    let sourcePath = "";
    const f = await fixture({
      wrapStore: (store) => ({
        ...store,
        save: async (body, options) => {
          if (tamper) {
            assert.equal(options?.parentPlan, PLAN, "publication must validate the snapshot that was edited");
            await writeFile(sourcePath, "# Externally changed");
          }
          return store.save(body, options);
        },
      }),
    });
    const first = mode === "planning" ? await ready(f) : await beginImplementation(f);
    sourcePath = first.details.path;
    const before = structuredClone(f.entries);
    tamper = true;
    await assert.rejects(editPlan(f, sourcePath, "material", "important"), /changed on disk/);
    assert.deepEqual(f.entries, before);
    assert.equal(await readFile(sourcePath, "utf8"), "# Externally changed");
    assert.equal((await (await createPlanStore(f.cwd, undefined, f.agentDir)).list()).length, 1);
  },
);

test.each(["planning", "implementing"] as const)(
  "%s edit cannot publish after cancellation or ownership loss during a read",
  async (mode) => {
    for (const interruption of ["abort", "tree", "shutdown"] as const) {
      let onRead: (() => Promise<void>) | undefined;
      const f = await fixture({
        wrapStore: (store) => ({
          ...store,
          read: async (revision) => {
            const body = await store.read(revision);
            await onRead?.();
            return body;
          },
        }),
      });
      const first = mode === "planning" ? await ready(f) : await beginImplementation(f);
      const controller = new AbortController();
      const before = structuredClone(f.entries);
      onRead = async () => {
        onRead = undefined;
        if (interruption === "abort") controller.abort();
        else await f.emit(interruption === "tree" ? "session_tree" : "session_shutdown");
      };
      await assert.rejects(
        editPlan(f, first.details.path, "material", "important", controller.signal),
        /cancel|abort|changed/i,
      );
      assert.deepEqual(f.entries, before);
      assert.equal(await readFile(first.details.path, "utf8"), PLAN);
      assert.equal((await (await createPlanStore(f.cwd, undefined, f.agentDir)).list()).length, 1);
    }
  },
);

test.each(["planning", "implementing"] as const)(
  "%s edit reports the recoverable new path after publication but never claims a stale or unpersisted revision",
  async (mode) => {
    for (const interruption of ["abort", "shutdown", "persist"] as const) {
      let afterSave: (() => Promise<void>) | undefined;
      let published: PlanRevision | undefined;
      const f = await fixture({
        wrapStore: (store) => ({
          ...store,
          save: async (body, options) => {
            const revision = await store.save(body, options);
            if (afterSave) {
              published = revision;
              await afterSave();
            }
            return revision;
          },
        }),
      });
      const first = mode === "planning" ? await ready(f) : await beginImplementation(f);
      if (mode === "planning") await f.emit("before_agent_start", promptEvent());
      const before = structuredClone(f.entries);
      const controller = new AbortController();
      afterSave = async () => {
        if (interruption === "abort") controller.abort();
        if (interruption === "shutdown") await f.emit("session_shutdown");
        if (interruption === "persist")
          f.rawPi.appendEntry = () => {
            throw new Error("disk full");
          };
      };
      await assert.rejects(
        editPlan(f, first.details.path, "material", "important", controller.signal),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(published);
          assert.ok(
            error.message.includes(published.path),
            "published revisions must remain discoverable from the failure",
          );
          assert.match(error.message, /cancel|changed|persist|ownership/i);
          return true;
        },
      );
      assert.deepEqual(f.entries, before);
      assert.ok(published);
      const store = await createPlanStore(f.cwd, undefined, f.agentDir);
      assert.equal(await store.read(published), PLAN.replace("material", "important"));
      assert.equal(await readFile(first.details.path, "utf8"), PLAN);
      await f.emit("agent_settled", { aborted: false });
      assert.equal(f.sentUserMessages.length, mode === "planning" ? 0 : 1);
    }
  },
);

test.each(["plan_mode_complete", "plan_mode_edit"])(
  "%s rejects nested and sibling planning saves without publishing or changing readiness",
  async (name) => {
    const f = await fixture();
    const saved = await ready(f);
    const input =
      name === "plan_mode_complete"
        ? { plan: `${PLAN}\n\nNew requirement.` }
        : { path: saved.details.path, edits: [{ oldText: "material", newText: "important" }] };
    const before = structuredClone(f.entries);
    const call = { type: "toolCall", id: "save", name, arguments: input };
    const assistant = (content: unknown[]) => ({ type: "message", message: { role: "assistant", content } });
    f.branch([...before.map((entry) => ({ type: "custom", ...entry })), assistant([call])]);
    assert.equal(await f.emit("tool_call", { toolName: name, input }), undefined);
    const nested = await f.emit("tool_call", { toolName: name, input, parentToolCallId: "relay" });
    assert.equal((nested as { block: boolean }).block, true);
    for (const sibling of [
      { type: "toolCall", id: "read", name: "read", arguments: { path: saved.details.path } },
      { ...call, id: "another-save" },
    ]) {
      f.branch([...before.map((entry) => ({ type: "custom", ...entry })), assistant([call, sibling])]);
      const blocked = await f.emit("tool_call", { toolName: name, input });
      assert.equal((blocked as { block: boolean }).block, true);
      await assert.rejects(f.execute(name, input), /alone|standalone|top.level|sibling/i);
      assert.deepEqual(f.entries, before);
    }
    assert.equal(f.state().kind, "ready");
    assert.equal(await readFile(saved.details.path, "utf8"), PLAN);
    assert.equal((await (await createPlanStore(f.cwd, undefined, f.agentDir)).list()).length, 1);
  },
);

test("artifact claims are available before save; pending work gates both readiness tools without publication", async () => {
  const f = await fixture({ tools: ["read", ...ARTIFACT_TOOLS] });
  await f.command("start");
  const state = f.state();
  assert.notEqual(state.kind, "idle");
  if (state.kind === "idle") return;
  const workspace = state.workflow.artifacts;
  assert.ok(workspace);
  const reference: ArtifactReference = {
    version: 1,
    artifactId: randomUUID(),
    jobId: randomUUID(),
    directory: join(workspace.workspace.directory, "checkout"),
    paths: [],
    status: "running",
  };
  f.rawPi.events.on("pi-artifacts-service-v1", (value) => {
    const request = value as { respond(value: unknown): void; action: string };
    request.respond(request.action === "status" ? { version: 1, jobs: [reference] } : { version: 1 });
  });
  f.rawPi.events.emit("pi-artifacts-reference-v1", { sessionId: "test-parent-session", reference });
  await assert.rejects(f.execute("plan_mode_complete", { plan: PLAN }), /still pending.*artifact_wait/);
  assert.equal((await (await createPlanStore(f.cwd, undefined, f.agentDir)).list()).length, 0);
  assert.equal(f.reviews.length, 0);
  assert.deepEqual(
    await f.emit("tool_call", { toolName: "artifact_create", input: { directory: join(f.cwd, "outside") } }),
    {
      block: true,
      reason: "Plan artifacts must be created in a new/empty child directory of the current artifact workspace.",
    },
  );
  assert.equal(
    await f.emit("tool_call", { toolName: "artifact_update", input: { artifactId: reference.artifactId } }),
    undefined,
  );
  assert.equal(((await f.emit("tool_call", { toolName: "write", input: {} })) as { block: boolean }).block, true);
  reference.status = "succeeded";
  reference.paths = [join(reference.directory, "index.html")];
  const saved = await f.execute("plan_mode_complete", { plan: PLAN });
  const revisions = await (await createPlanStore(f.cwd, undefined, f.agentDir)).list();
  assert.equal(revisions[0].artifacts?.references[0].artifactId, reference.artifactId);
  const next = { ...reference, jobId: randomUUID(), status: "queued" as const };
  Object.assign(reference, next);
  f.rawPi.events.emit("pi-artifacts-reference-v1", { sessionId: "test-parent-session", reference });
  await assert.rejects(
    f.execute("plan_mode_edit", { path: saved.details.path, edits: [{ oldText: "Simplify", newText: "Improve" }] }),
    /still pending/,
  );
  assert.equal((await (await createPlanStore(f.cwd, undefined, f.agentDir)).list()).length, 1);
  await f.command("exit");
});

test("failed artifacts require retry or explicit user omission; associations survive metadata without ancestry", async () => {
  const f = await fixture({ tools: ["read", ...ARTIFACT_TOOLS] });
  await f.command("start");
  const state = f.state();
  if (state.kind === "idle") throw new Error("Expected planning");
  assert.ok(state.workflow.artifacts);
  const reference: ArtifactReference = {
    version: 1,
    artifactId: randomUUID(),
    jobId: randomUUID(),
    directory: join(state.workflow.artifacts.workspace.directory, "design"),
    paths: [],
    status: "failed",
  };
  f.rawPi.events.on("pi-artifacts-service-v1", (value) => {
    (value as { respond(v: unknown): void }).respond({ version: 1, jobs: [reference] });
  });
  f.rawPi.events.emit("pi-artifacts-reference-v1", { sessionId: "test-parent-session", reference });
  await assert.rejects(f.execute("plan_mode_complete", { plan: PLAN }), /did not succeed/);
  await f.command(`artifacts omit ${reference.jobId}`);
  const saved = await f.execute("plan_mode_complete", { plan: PLAN });
  const store = await createPlanStore(f.cwd, undefined, f.agentDir);
  const [revision] = await store.list();
  assert.equal(revision.history, undefined);
  assert.deepEqual(revision.artifacts?.omittedJobIds, [reference.jobId]);
  assert.equal(await store.read(revision), PLAN);
  assert.ok((await readFile(saved.details.path, "utf8")).startsWith("<!-- pi-plan-document-v2:"));
  await f.emit("session_start");
  const restored = f.state();
  if (restored.kind === "idle") throw new Error("Expected restored workflow");
  assert.equal(restored.workflow.artifacts?.references[0].artifactId, reference.artifactId);
});
