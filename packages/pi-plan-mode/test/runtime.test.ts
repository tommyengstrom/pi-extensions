import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AssistantMessage, Message, SystemMessage, ToolCall } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
  ExtensionAPI,
  ExtensionCommandContextActions,
  ExtensionError,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { afterAll, test, vi } from "vitest";
import type { PlanState } from "../src/state.js";

// Set the agent directory before importing Pi or any extension implementation.
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const suiteRoot = mkdtempSync(join(tmpdir(), "pi-plan-runtime-"));
const agentDir = join(suiteRoot, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(suiteRoot, { recursive: true, force: true });
});

const {
  AgentSession: RealAgentSession,
  ExtensionRunner,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
} = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } = await import(
  "@earendil-works/pi-ai"
);
const { IMPLEMENTATION_HELPERS, restoreImplementation } = await import("../src/implementation-state.js");
const { default: planMode } = await import("../src/plan-mode.js");
const { default: entrypoint } = await import("../src/index.js");

type ReviewAction = Awaited<ReturnType<typeof import("../src/interactive-ui.js").reviewPlan>>;
const instructions = "Runtime smoke instructions: inspect before proposing changes.";
const plan = "# Runtime smoke\n\n1. Inspect the affected code.\n2. Implement the change.\n3. Verify the result.";
const helpers = ["plan_mode_question", "plan_mode_complete"];
const planningTools = ["read", "grep", "find", "ls", ...helpers];

async function fixture(
  extra?: (pi: ExtensionAPI) => void,
  shortcuts?: import("../src/settings.js").PlanModeSettings["shortcuts"],
) {
  const cwd = await mkdtemp(join(suiteRoot, "project-"));
  await mkdir(agentDir, { recursive: true });
  const requests: Message[][] = [];
  const replies: ToolCall[] = [];
  const errors: ExtensionError[] = [];
  const statuses = new Map<string, string | undefined>();
  const promptOptions: Array<{ section: string | undefined; forced: string | undefined }> = [];
  const lifecycle: string[] = [];
  const reviewPlan = vi.fn<typeof import("../src/interactive-ui.js").reviewPlan>(async () => undefined);
  const loadUi = vi.fn(async () => ({ ...(await import("../src/interactive-ui.js")), reviewPlan }));
  const newSessions: Parameters<ExtensionCommandContextActions["newSession"]>[0][] = [];
  let runtime: AgentSessionRuntime | undefined;
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const streamSimple: NonNullable<ProviderConfig["streamSimple"]> = (model, context) => {
    requests.push(structuredClone(context.messages));
    const stream = createAssistantMessageEventStream();
    const call = replies.shift();
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      stopReason: "pending",
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    stream.push({ type: "start", partial: message });
    if (call) {
      message.content.push(call);
      message.stopReason = "toolUse";
      stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
    } else {
      const checking = JSON.stringify(context.messages).includes("Assess implementation adherence.");
      const text = checking
        ? JSON.stringify({
            status: "adherent",
            summary: "Requirement accounted for.",
            requirements: [
              {
                requirement: "Implement the change",
                revision: "1",
                status: "implemented",
                evidence: "src/example.ts:1",
              },
            ],
            changes: [],
            deviations: [],
            limitations: [],
          })
        : "Offline response.";
      message.content.push({ type: "text", text });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
    }
    message.stopReason = call ? "toolUse" : "stop";
    stream.push({ type: "done", reason: message.stopReason, message });
    stream.end();
    return stream;
  };
  // No transport exists: every model request is answered by this in-process stream.
  modelRuntime.registerProvider("plan-smoke", {
    api: "openai-completions",
    apiKey: "offline-test-key",
    baseUrl: "https://offline.invalid",
    streamSimple,
    models: [
      {
        id: "offline",
        name: "Offline smoke model",
        reasoning: false,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const model = modelRuntime.getModel("plan-smoke", "offline");
  assert.ok(model);
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) =>
          planMode(pi, {
            readSettings: async () => ({ plansDirectory: "plans", shortcuts }),
            readInstructions: () => instructions,
            loadUi,
          }),
        (pi) => {
          pi.on("before_agent_start", (event) => {
            promptOptions.push({
              section: event.systemPromptOptions.sections.pi_plan_mode,
              forced: event.systemPromptOptions.forceSystemPrompt,
            });
          });
          pi.on("session_start", (event) => {
            lifecycle.push(`start:${event.reason}`);
          });
          pi.on("session_shutdown", (event) => {
            lifecycle.push(`shutdown:${event.reason}`);
          });
          extra?.(pi);
        },
      ],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const services = { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model,
        thinkingLevel: "off",
      })),
      services,
      diagnostics: [],
    };
  };
  try {
    runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
    });
    const currentRuntime = runtime;
    const bind = async (session: AgentSession) => {
      const baseUi = session.extensionRunner.getUIContext();
      await session.bindExtensions({
        mode: "rpc",
        uiContext: {
          ...baseUi,
          setStatus: (key, value) => {
            statuses.set(key, value);
          },
          notify: vi.fn(),
        },
        onError: (error) => {
          errors.push(error);
        },
        commandContextActions: {
          waitForIdle: () => session.waitForIdle(),
          newSession: (options) => {
            newSessions.push(options);
            return currentRuntime.newSession(options);
          },
          switchSession: (path, options) => currentRuntime.switchSession(path, options),
          fork: (id, options) => currentRuntime.fork(id, options),
          navigateTree: (id, options) => session.navigateTree(id, options),
          reload: async () => {
            throw new Error("Unexpected reload");
          },
        },
      });
    };
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    return {
      runtime,
      requests,
      errors,
      statuses,
      promptOptions,
      lifecycle,
      reviewPlan,
      loadUi,
      newSessions,
      queueTool(name: string, args: ToolCall["arguments"] = {}) {
        replies.push({ type: "toolCall", id: `tool-${requests.length}`, name, arguments: args });
      },
      choose(action: ReviewAction) {
        reviewPlan.mockResolvedValueOnce(action);
      },
      async complete() {
        const before = requests.length;
        replies.push({ type: "toolCall", id: `complete-${before}`, name: "plan_mode_complete", arguments: { plan } });
        await currentRuntime.session.prompt("Complete the plan now.");
        assert.equal(requests.length, before + 1, "terminating completion must not make a follow-up request");
        const state = stateOf(currentRuntime.session);
        assert.equal(state.kind, "ready");
        assert.ok(state.kind === "ready");
        return state;
      },
      async dispose() {
        try {
          await currentRuntime.dispose();
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
        assert.deepEqual(errors, []);
      },
    };
  } catch (error) {
    await runtime?.dispose();
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
}

function stateOf(session: AgentSession): PlanState {
  for (const entry of [...session.sessionManager.getBranch()].reverse()) {
    if (entry.type === "custom" && entry.customType === "pi-plan-state") return entry.data as PlanState;
  }
  return { kind: "idle" };
}
function systems(messages: Message[]): SystemMessage[] {
  return messages.filter((message): message is SystemMessage => message.role === "system");
}
function toolNames(messages: Message[]) {
  return getCurrentTools(messages)
    .map((tool) => tool.name)
    .sort();
}

test("native shortcut resolution and key matching preserve Enter and reserved host bindings", async () => {
  const { KeybindingsManager } = await import(
    new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
  );
  const { matchesKey } = await import("@earendil-works/pi-tui");
  const bindings = new KeybindingsManager().getResolvedBindings();
  const f = await fixture();
  try {
    const runner = f.runtime.session.extensionRunner;
    const shortcuts = runner.getShortcuts(bindings);
    const toggle = shortcuts.get("ctrl+alt+p");
    assert.ok(toggle);
    assert.match(toggle.description ?? "", /planning and normal/);
    assert.equal(shortcuts.size, 1);
    for (const enter of ["\r", "\n", "\u001b[13u"]) assert.equal(matchesKey(enter, "ctrl+alt+p"), false);
    assert.equal(matchesKey("\u001b[200~pasted\u001b[112;7u\u001b[201~", "ctrl+alt+p"), false);
    assert.equal(matchesKey("\u001b[112;7u", "ctrl+alt+p"), true);
    const context = { ...runner.createContext(), mode: "tui" as const };
    const previousTools = f.runtime.session.getActiveToolNames();
    await toggle.handler(context);
    assert.equal(stateOf(f.runtime.session).kind, "planning");
    await toggle.handler(context);
    assert.equal(stateOf(f.runtime.session).kind, "idle");
    assert.deepEqual(f.runtime.session.getActiveToolNames(), previousTools);
    assert.equal(f.requests.length, 0);
    // A user's reserved binding wins over the extension default.
    assert.equal(runner.getShortcuts({ ...bindings, "app.model.select": "ctrl+alt+p" }).size, 0);
  } finally {
    await f.dispose();
  }
  const custom = await fixture(undefined, { togglePlan: "shift+tab" });
  try {
    const runner = custom.runtime.session.extensionRunner;
    assert.equal(runner.getShortcuts(bindings).size, 0);
    assert.equal(runner.getShortcuts({ ...bindings, "app.thinking.cycle": [] }).has("shift+tab"), true);
  } finally {
    await custom.dispose();
  }
});

test("real completion runs one isolated checker and terminates without a main-agent retry", async () => {
  const f = await fixture();
  try {
    const session = f.runtime.session;
    await session.prompt("PRIVATE PLANNING CONTENT");
    await session.prompt("/plan start");
    await f.complete();
    f.choose("here");
    await session.prompt("/plan");
    await session.waitForIdle();
    await session.prompt("Keep the material requirements unchanged.");
    const prefix = f.requests.at(-1);
    assert.ok(prefix);
    await session.prompt("Continue following the same plan.");
    assert.deepEqual(
      f.requests.at(-1)?.slice(0, prefix.length),
      prefix,
      "ordinary implementation turns retain the request prefix",
    );
    const before = f.requests.length;
    f.queueTool("plan_mode_implementation_complete");
    await session.prompt("Implementation is ready; signal completion now.");
    assert.equal(f.requests.length, before + 2, "one main tool call plus one fresh checker response");
    const childRequest = f.requests.at(-1);
    assert.ok(childRequest);
    assert.equal(JSON.stringify(childRequest).includes("PRIVATE PLANNING CONTENT"), false);
    assert.ok(JSON.stringify(childRequest).includes("Keep the material requirements unchanged."));
    assert.equal(restoreImplementation(session.sessionManager.getBranch())?.phase, "completed");
    assert.equal(restoreImplementation(session.sessionManager.getBranch())?.lastCheck?.status, "adherent");
    assert.deepEqual(toolNames(childRequest), ["find", "grep", "ls", "read"]);
    assert.equal(session.getActiveToolNames().includes("plan_mode_implementation_complete"), false);
    await session.prompt("UNRELATED AFTER COMPLETION");
    await session.prompt("/plan resume");
    assert.equal(restoreImplementation(session.sessionManager.getBranch())?.lastCheck, undefined);
    assert.equal(restoreImplementation(session.sessionManager.getBranch())?.phase, "implementing");
  } finally {
    await f.dispose();
  }
});

test("entrypoint registers inactive helpers and selects real core inspection tools", async () => {
  const f = await fixture();
  try {
    assert.equal(entrypoint, planMode);
    const session = f.runtime.session;
    assert.ok(session instanceof RealAgentSession);
    assert.ok(session.extensionRunner instanceof ExtensionRunner);
    assert.ok(session.extensionRunner.getCommand("plan"));
    assert.equal(session.extensionRunner.hasHandlers("context"), false);
    assert.equal(session.extensionRunner.hasHandlers("context_with_system"), false);
    for (const name of helpers) {
      assert.equal(session.extensionRunner.getToolDefinition(name)?.defaultActive, false);
      assert.equal(session.getActiveToolNames().includes(name), false);
    }
    const previous = session.getActiveToolNames();
    await session.prompt("/plan start");
    assert.deepEqual(session.getActiveToolNames().sort(), [...planningTools].sort());
    assert.equal(stateOf(session).kind, "planning");
    assert.equal(f.requests.length, 0);
    assert.equal(f.loadUi.mock.calls.length, 0);
    await session.prompt("/plan exit");
    assert.deepEqual(session.getActiveToolNames(), previous);
    assert.equal(stateOf(session).kind, "idle");
  } finally {
    await f.dispose();
  }
});

test("ordinary turns preserve the request prefix while Plan uses native section and tool deltas", async () => {
  const f = await fixture();
  try {
    const session = f.runtime.session;
    const previous = session.getActiveToolNames().sort();
    await session.prompt("Baseline turn.");
    await session.prompt("/plan start");
    await session.prompt("First planning turn.");
    await session.prompt("Second planning turn.");
    await session.prompt("/plan exit");
    await session.prompt("Normal turn after exit.");
    assert.equal(f.requests.length, 4);
    const [baseline, first, second, exited] = f.requests;
    assert.ok(baseline && first && second && exited);
    assert.equal(systems(baseline).length, 1);
    assert.equal(systems(first).length, 2);
    assert.equal(systems(second).length, 2, "unchanged planning turns must not append another system patch");
    assert.equal(systems(exited).length, 3);
    assert.deepEqual(first.slice(0, baseline.length), baseline);
    assert.deepEqual(second.slice(0, first.length), first);
    assert.deepEqual(exited.slice(0, second.length), second);
    assert.equal(systems(baseline)[0]?.sections?.pi_plan_mode, undefined);
    assert.ok(systems(first).at(-1)?.sections?.pi_plan_mode?.includes(instructions));
    assert.equal(systems(exited).at(-1)?.sections?.pi_plan_mode, null);
    assert.ok(getCurrentSystemPrompt(second).includes(instructions));
    assert.equal(getCurrentSystemPrompt(exited).includes(instructions), false);
    assert.deepEqual(toolNames(first), [...planningTools].sort());
    assert.deepEqual(toolNames(exited), previous);
    assert.equal(f.promptOptions[0]?.section, undefined);
    assert.ok(f.promptOptions[1]?.section?.includes(instructions));
    assert.equal(f.promptOptions[1]?.section, f.promptOptions[2]?.section);
    assert.equal(f.promptOptions[3]?.section, undefined);
    assert.ok(f.promptOptions.every((options) => options.forced === undefined));
  } finally {
    await f.dispose();
  }
});

test("completion saves the full Markdown, terminates, and automatically opens review without another model request", async () => {
  const f = await fixture();
  try {
    const session = f.runtime.session;
    await session.prompt("/plan start");
    const ready = await f.complete();
    assert.match(basename(ready.revision.path), /^\d{4}-\d{2}-\d{2}-runtime-smoke-01\.md$/);
    assert.equal(dirname(dirname(ready.revision.path)), join(agentDir, "pi-plan-mode"));
    assert.equal(await readFile(ready.revision.path, "utf8"), plan);
    const result = session.messages.findLast((message) => message.role === "toolResult");
    assert.ok(result?.role === "toolResult");
    assert.equal(result.isError, false);
    const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    assert.ok(text.includes(plan));
    assert.ok(text.includes(ready.revision.path));
    assert.ok([...f.statuses.values()].some((value) => value?.includes("ready")));
    assert.equal(f.reviewPlan.mock.calls.length, 1);
    assert.equal(f.loadUi.mock.calls.length, 1);
    assert.equal(f.reviewPlan.mock.calls[0]?.[1], plan);
    assert.equal(JSON.stringify(f.requests).includes("__review"), false);
    assert.equal(f.requests.length, 1);
    assert.equal(f.newSessions.length, 0);
  } finally {
    await f.dispose();
  }
});

test.each([undefined, "save", "continue", "here", "fresh"] as const)(
  "automatic review action %s runs through a real idle command context",
  async (action) => {
    const f = await fixture();
    try {
      const source = f.runtime.session;
      await source.prompt("Private planning discussion");
      await source.prompt("/plan start");
      f.choose(action);
      f.queueTool("plan_mode_complete", { plan });
      await source.prompt("Finish planning now.");
      await f.runtime.session.waitForIdle();
      assert.equal(f.reviewPlan.mock.calls.length, 1);
      assert.equal(f.reviewPlan.mock.calls[0]?.[1], plan);
      assert.equal(f.newSessions.length, action === "fresh" ? 1 : 0);
      assert.equal(f.requests.length, action === "here" || action === "fresh" || action === "continue" ? 3 : 2);
      assert.equal(JSON.stringify(f.requests).includes("__review"), false);
      if (action === "fresh") {
        assert.notEqual(f.runtime.session, source);
        assert.equal(JSON.stringify(f.requests.at(-1)).includes("Private planning discussion"), false);
        assert.equal(restoreImplementation(f.runtime.session.sessionManager.getBranch())?.phase, "implementing");
      } else {
        assert.equal(f.runtime.session, source);
        assert.equal(
          stateOf(source).kind,
          action === undefined ? "ready" : action === "continue" ? "planning" : "idle",
        );
      }
    } finally {
      await f.dispose();
    }
  },
);

test("real-runtime TUI smoke: automatic document review, dismissal, reopening, then explicit implementation", async () => {
  const { createTuiHarness } = await import("@narumitw/pi-tui-kit/testing");
  const { reviewPlan } = await import("../src/interactive-ui.js");
  const f = await fixture();
  try {
    const session = f.runtime.session;
    const tui = createTuiHarness({ rows: 32 });
    session.extensionRunner.setUIContext({ ...session.extensionRunner.getUIContext(), custom: tui.custom }, "tui");
    f.reviewPlan.mockImplementation(reviewPlan);
    await session.prompt("/plan start");
    f.queueTool("plan_mode_complete", { plan });
    const completion = session.prompt("Finish the plan.");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Runtime smoke/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.newSessions.length, 0);
    tui.press("tui.select.cancel");
    await completion;
    assert.equal(stateOf(session).kind, "ready");
    const reopened = session.prompt("/plan");
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    const actions = tui.render().join("\n");
    assert.match(actions, /Implement in fresh session/);
    assert.match(actions, /Implement here/);
    assert.equal(f.requests.length, 1, "document confirmation is not implementation approval");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await reopened;
    await session.waitForIdle();
    assert.equal(f.requests.length, 2);
    assert.equal(stateOf(session).kind, "idle");
    assert.equal(restoreImplementation(session.sessionManager.getBranch())?.phase, "implementing");
  } finally {
    await f.dispose();
  }
});

test("finalize and later revisions automatically present review without control-text model requests", async () => {
  const f = await fixture();
  try {
    const session = f.runtime.session;
    await session.prompt("/plan start");
    f.queueTool("plan_mode_complete", { plan });
    await session.prompt("/plan finalize");
    await session.waitForIdle();
    assert.equal(f.reviewPlan.mock.calls.length, 1);
    assert.equal(f.requests.length, 1);
    f.queueTool("plan_mode_complete", { plan: `${plan}\n\nNew requirement.`, reason: "User added a requirement" });
    await session.prompt("Revise the plan with the new requirement.");
    await session.waitForIdle();
    assert.equal(f.reviewPlan.mock.calls.length, 2);
    assert.equal(f.requests.length, 2);
    const ready = stateOf(session);
    assert.ok(ready.kind === "ready");
    assert.equal(ready.revision.revision, 2);
    assert.equal(JSON.stringify(f.requests).includes("__review"), false);
  } finally {
    await f.dispose();
  }
});

test("tree navigation restores planning, ready, and idle from the active branch only", async () => {
  const f = await fixture();
  try {
    const session = f.runtime.session;
    const previous = session.getActiveToolNames();
    const root = session.sessionManager.appendCustomEntry("smoke-root", {});
    await session.prompt("/plan start");
    const planning = session.sessionManager.getLeafId();
    assert.ok(planning);
    const ready = await f.complete();
    const readyLeaf = session.sessionManager.getLeafId();
    assert.ok(readyLeaf);
    await session.prompt("/plan exit");
    await session.navigateTree(planning, { summarize: false });
    assert.equal(stateOf(session).kind, "planning");
    assert.deepEqual(session.getActiveToolNames().sort(), [...planningTools].sort());
    await session.navigateTree(readyLeaf, { summarize: false });
    assert.deepEqual(stateOf(session), ready);
    assert.ok([...f.statuses.values()].some((value) => value?.includes("ready")));
    await session.navigateTree(root, { summarize: false });
    assert.equal(stateOf(session).kind, "idle");
    assert.deepEqual(session.getActiveToolNames(), previous);
    await session.prompt("An ordinary branch turn.");
    const request = f.requests.at(-1);
    assert.ok(request);
    assert.equal(getCurrentSystemPrompt(request).includes(instructions), false);
    assert.equal(f.reviewPlan.mock.calls.length, 1, "restored readiness must not present another review");
  } finally {
    await f.dispose();
  }
});

test.each([undefined, "save", "continue", "here"] as const)(
  "command review action %s does not replace the session",
  async (action) => {
    const f = await fixture();
    try {
      const session = f.runtime.session;
      const previous = session.getActiveToolNames();
      await session.prompt("/plan start");
      const ready = await f.complete();
      f.choose(action);
      await session.prompt("/plan");
      await session.waitForIdle();
      assert.equal(f.runtime.session, session);
      assert.equal(f.newSessions.length, 0);
      assert.equal(f.reviewPlan.mock.calls.length, 2, "manual /plan reopens the dismissed automatic review");
      assert.equal(f.reviewPlan.mock.calls[1]?.[1], plan);
      assert.deepEqual(f.reviewPlan.mock.calls[1]?.[2], ready.revision);
      assert.equal(await readFile(ready.revision.path, "utf8"), plan);
      if (action === undefined) {
        assert.deepEqual(stateOf(session), ready);
        assert.equal(f.requests.length, 1);
      } else if (action === "save") {
        assert.equal(stateOf(session).kind, "idle");
        assert.deepEqual(session.getActiveToolNames(), previous);
        assert.equal(f.requests.length, 1);
      } else {
        assert.equal(f.requests.length, 2);
        const request = f.requests.at(-1);
        assert.ok(request);
        assert.ok(JSON.stringify(request).includes("Inspect the affected code."));
        assert.equal(stateOf(session).kind, action === "continue" ? "planning" : "idle");
        assert.equal(getCurrentSystemPrompt(request).includes(instructions), action === "continue");
        if (action === "here") assert.deepEqual(session.getActiveToolNames(), [...previous, ...IMPLEMENTATION_HELPERS]);
      }
    } finally {
      await f.dispose();
    }
  },
);

test("a review completed after runtime replacement is ignored without accessing the disposed context", async () => {
  const f = await fixture();
  const opened = Promise.withResolvers<void>();
  const choice = Promise.withResolvers<ReviewAction>();
  try {
    const source = f.runtime.session;
    await source.prompt("/plan start");
    await f.complete();
    f.reviewPlan.mockImplementationOnce(async () => {
      opened.resolve();
      return choice.promise;
    });
    const pending = source.prompt("/plan");
    try {
      await opened.promise;
      const reviewLifecycle = f.reviewPlan.mock.calls.at(-1)?.[3];
      assert.ok(reviewLifecycle);
      assert.equal(reviewLifecycle.isCurrent(), true);
      await f.runtime.newSession();
      const replacement = f.runtime.session;
      assert.notEqual(replacement, source);
      assert.equal(reviewLifecycle.signal.aborted, true);
      assert.equal(reviewLifecycle.isCurrent(), false);
      choice.resolve("fresh");
      await pending;
      assert.equal(f.runtime.session, replacement);
      assert.deepEqual(stateOf(replacement), { kind: "idle" });
      assert.equal(f.newSessions.length, 0);
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.errors, []);
    } finally {
      choice.resolve(undefined);
      await pending;
    }
  } finally {
    await f.dispose();
  }
});

test("question execution cancellation reaches a stalled RPC dialog independently of the session signal", async () => {
  const f = await fixture();
  try {
    const session = f.runtime.session;
    await session.prompt("/plan start");
    const runner = session.extensionRunner;
    const question = runner.getToolDefinition("plan_mode_question");
    assert.ok(question);
    const opened = Promise.withResolvers<AbortSignal | undefined>();
    const dialog = Promise.withResolvers<string | undefined>();
    runner.setUIContext(
      {
        ...runner.getUIContext(),
        select: async (_title, _items, options) => {
          const signal = options?.signal;
          signal?.addEventListener("abort", () => dialog.resolve(undefined), { once: true });
          opened.resolve(signal);
          return dialog.promise;
        },
      },
      "rpc",
    );
    const parent = new AbortController();
    const execution = new AbortController();
    const ctx = runner.createToolContext("question-with-independent-signal", parent.signal);
    assert.equal(ctx.signal, undefined);
    const pending = question.execute(
      "question-with-independent-signal",
      {
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope should the plan cover?",
            options: [
              { label: "Small", description: "Limit the change to one module." },
              { label: "Broad", description: "Include related modules." },
            ],
          },
        ],
      },
      execution.signal,
      undefined,
      ctx,
    );
    try {
      const signal = await opened.promise;
      assert.ok(signal);
      assert.equal(signal.aborted, false);
      execution.abort();
      assert.equal(signal.aborted, true);
      assert.equal(parent.signal.aborted, false);
      const result = await pending;
      assert.ok(result.details && typeof result.details === "object");
      assert.ok("cancelled" in result.details && "reason" in result.details);
      assert.equal(result.details.cancelled, true);
      assert.equal(result.details.reason, "cancelled");
      assert.equal(stateOf(session).kind, "planning");
      assert.equal(f.requests.length, 0);
    } finally {
      dialog.resolve(undefined);
      await pending;
    }
  } finally {
    await f.dispose();
  }
});

test("cancelled fresh replacement leaves the source ready and its plan available", async () => {
  const f = await fixture((pi) => {
    pi.on("session_before_switch", (event) => (event.reason === "new" ? { cancel: true } : undefined));
  });
  try {
    const session = f.runtime.session;
    await session.prompt("/plan start");
    const ready = await f.complete();
    f.choose("fresh");
    await session.prompt("/plan");
    assert.equal(f.runtime.session, session);
    assert.deepEqual(stateOf(session), ready);
    assert.deepEqual(session.getActiveToolNames().sort(), [...planningTools].sort());
    assert.equal(f.newSessions.length, 1);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.lifecycle, ["start:startup"]);
    assert.equal(await readFile(ready.revision.path, "utf8"), plan);
  } finally {
    await f.dispose();
  }
});

test("fresh review uses command newSession/withSession and transfers only the full plan", async () => {
  const f = await fixture();
  try {
    const old = f.runtime.session;
    const defaultTools = old.getActiveToolNames();
    await old.prompt("Private planning discussion that must not be copied.");
    old.sessionManager.appendCustomEntry("private-smoke-history", { secret: "not-for-implementation" });
    old.setActiveToolsByName(["read", "write"]);
    await old.prompt("/plan start");
    const ready = await f.complete();
    const oldContext = old.extensionRunner.createCommandContext();
    f.choose("fresh");
    await old.prompt("/plan");
    const replacement = f.runtime.session;
    await replacement.waitForIdle();
    assert.notEqual(replacement, old);
    assert.equal(f.newSessions.length, 1);
    const options = f.newSessions[0];
    assert.ok(options);
    assert.equal(typeof options.withSession, "function");
    assert.equal(typeof options.setup, "function", "fresh implementation initializes only tracking data");
    assert.equal(options.parentSession, undefined, "in-memory sessions have no parent file");
    assert.deepEqual(Object.keys(options), ["setup", "withSession"]);
    assert.deepEqual(f.lifecycle, ["start:startup", "shutdown:new", "start:new"]);
    assert.throws(() => oldContext.sessionManager.getSessionId());
    assert.deepEqual(stateOf(old), { kind: "idle" }, "the source branch must not resume into a completed workflow");
    assert.equal(stateOf(replacement).kind, "idle");
    assert.deepEqual(replacement.getActiveToolNames(), [...defaultTools, ...IMPLEMENTATION_HELPERS]);
    assert.equal(restoreImplementation(replacement.sessionManager.getBranch())?.phase, "implementing");
    const transferred = f.requests.at(-1);
    assert.ok(transferred);
    const users = transferred.filter((message) => message.role === "user");
    assert.equal(users.length, 1);
    const user = users[0];
    assert.ok(user);
    assert.ok(JSON.stringify(user).includes("Inspect the affected code."));
    const text =
      typeof user.content === "string"
        ? user.content
        : user.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    assert.ok(text.includes(plan));
    assert.equal(JSON.stringify(transferred).includes("Private planning discussion"), false);
    assert.equal(JSON.stringify(replacement.sessionManager.getEntries()).includes("not-for-implementation"), false);
    assert.equal(getCurrentSystemPrompt(transferred).includes(instructions), false);
    assert.deepEqual(toolNames(transferred), [...defaultTools, ...IMPLEMENTATION_HELPERS].sort());
    assert.equal(await readFile(ready.revision.path, "utf8"), plan);
  } finally {
    await f.dispose();
  }
});
