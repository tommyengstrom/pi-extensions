import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { MenuLifecycle } from "../src/interactive-ui.js";
import planMode from "../src/plan-mode.js";
import { createPlanStore, type PlanRevision } from "../src/plan-store.js";
import { buildPlanModePrompt } from "../src/prompt.js";
import { PLAN_STATE_ENTRY, restorePlanState } from "../src/state.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const BASELINE = ["read", "bash", "edit", "write"];
const PLAN = "# Simplify planning\n\nKeep only material decisions.";
type Action = "fresh" | "here" | "save" | "continue" | undefined;

async function fixture(config: { tools?: string[]; instructions?: string } = {}) {
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
    sessionManager: {
      getSessionFile: () => join(root, "source.jsonl"),
      getBranch: () => branch ?? mock.entries.map((entry) => ({ type: "custom", ...entry })),
    },
  });
  const dependencies = {
    readSettings: async () => {
      await settingsHook?.();
      return { plansDirectory: "plans", ...(config.tools ? { tools: config.tools } : {}) };
    },
    readInstructions: () => instructions,
    createStore: (directory: string, plansDirectory?: string) => createPlanStore(directory, plansDirectory, agentDir),
    loadUi: async () => ({
      reviewPlan: async (_ctx: unknown, text: string, _revision: PlanRevision, lifecycle: MenuLifecycle) => {
        reviews.push(text);
        await reviewHook?.(lifecycle);
        return action;
      },
      selectSavedPlan: async (_ctx: unknown, revisions: PlanRevision[]) => revisions[0],
      selectPlanTools: async () => chosenTools,
    }),
  };
  planMode(mock.pi, dependencies);
  async function emit(event: string, input: unknown = {}, ctx = context.ctx) {
    let result: unknown;
    for (const handler of mock.events.get(event) ?? []) result = await handler(input, ctx);
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
    emit,
    command,
    execute,
    reviews,
    dependencies,
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
  const second = await f.execute("plan_mode_complete", { plan: updated });
  assert.match(second.details.path, /simplify-planning-02\.md$/);
  assert.equal(await readFile(first.details.path, "utf8"), PLAN);
  assert.equal(await readFile(second.details.path, "utf8"), updated);
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
  const revision = await f.execute("plan_mode_complete", { plan: "# Another title\n\nNew brief." });
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
  assert.deepEqual(f.rawPi.getActiveTools(), BASELINE);
});

test("fresh handoff transfers only the plan and links the source without custom setup", async () => {
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
      assert.equal(options.setup, undefined);
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
  const store = await createPlanStore(f.cwd, "plans", f.agentDir);
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

test("malformed current state does not reconstruct a workflow from prose or unrelated entries", () => {
  assert.deepEqual(restorePlanState([{ type: "custom", customType: PLAN_STATE_ENTRY, data: { kind: "ready" } }]), {
    kind: "idle",
  });
  assert.deepEqual(restorePlanState([{ type: "message", message: { role: "assistant", content: PLAN } }]), {
    kind: "idle",
  });
});
