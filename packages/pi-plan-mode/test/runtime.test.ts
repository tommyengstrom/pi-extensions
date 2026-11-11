import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
const { createPlanStore, planHash } = await import("../src/plan-store.js");
const { default: planMode } = await import("../src/plan-mode.js");
const { default: entrypoint } = await import("../src/index.js");

type ReviewAction = Awaited<ReturnType<typeof import("../src/interactive-ui.js").reviewPlan>>;
const instructions = "Runtime smoke instructions: inspect before proposing changes.";
const plan = "# Runtime smoke\n\n1. Inspect the affected code.\n2. Implement the change.\n3. Verify the result.";
const helpers = ["plan_mode_question", "plan_mode_complete", "plan_mode_edit"];
const planningTools = ["read", "grep", "find", "ls", ...helpers];

async function fixture(
  extra?: (pi: ExtensionAPI) => void,
  shortcuts?: import("../src/settings.js").PlanModeSettings["shortcuts"],
  trustedTools?: string[],
  verify?: import("../src/implementation.js").ImplementationDependencies["verify"],
) {
  const cwd = await mkdtemp(join(suiteRoot, "project-"));
  await mkdir(agentDir, { recursive: true });
  const requests: Message[][] = [];
  const replies: ToolCall[][] = [];
  const errors: ExtensionError[] = [];
  const statuses = new Map<string, string | undefined>();
  const statusHistory: Array<{ key: string; value: string | undefined }> = [];
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
  const streamSimple: NonNullable<ProviderConfig["streamSimple"]> = (model, context, options) => {
    assert.equal(options?.apiKey, "offline-test-key", "main and checker requests must use the parent credential");
    requests.push(structuredClone(context.messages));
    const stream = createAssistantMessageEventStream();
    const checking = JSON.stringify(context.messages).includes("Assess implementation adherence.");
    const calls = checking
      ? [
          {
            type: "toolCall" as const,
            id: "report",
            name: "submit_adherence_report",
            arguments: { status: "ok", motivation: "Requirement accounted for. See `src/example.ts:1`." },
          },
        ]
      : replies.shift();
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
    if (calls) {
      message.stopReason = "toolUse";
      for (const [contentIndex, call] of calls.entries()) {
        message.content.push(call);
        stream.push({ type: "toolcall_start", contentIndex, partial: message });
        stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
      }
    } else {
      const text = "Offline response.";
      message.content.push({ type: "text", text });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
    }
    message.stopReason = calls ? "toolUse" : "stop";
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
            readSettings: async () => ({ plansDirectory: "plans", shortcuts, tools: trustedTools }),
            readInstructions: () => instructions,
            // Naming is isolated from the main/checker request queue in these runtime tests.
            namePlan: async () => "runtime-smoke",
            verify,
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
            statusHistory.push({ key, value });
          },
          notify: vi.fn(),
          select: verify
            ? async (_title, _options, options) =>
                new Promise<string | undefined>((resolve) => {
                  if (options?.signal?.aborted) resolve(undefined);
                  else options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
                })
            : baseUi.select,
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
      statusHistory,
      promptOptions,
      lifecycle,
      reviewPlan,
      loadUi,
      newSessions,
      async readPlan(document: import("../src/plan-store.js").PlanDocument) {
        return (await createPlanStore(cwd, { kind: "repo" }, agentDir)).read(document);
      },
      queueTool(name: string, args: ToolCall["arguments"] = {}) {
        replies.push([{ type: "toolCall", id: `tool-${requests.length}`, name, arguments: args }]);
      },
      queueBatch(calls: Array<{ name: string; arguments: ToolCall["arguments"] }>) {
        replies.push(
          calls.map((call, index) => ({ type: "toolCall", id: `tool-${requests.length}-${index}`, ...call })),
        );
      },
      choose(action: ReviewAction) {
        reviewPlan.mockResolvedValueOnce(action);
      },
      async complete() {
        const before = requests.length;
        replies.push([{ type: "toolCall", id: `complete-${before}`, name: "plan_mode_complete", arguments: { plan } }]);
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

function assertStatus(f: Awaited<ReturnType<typeof fixture>>, expected: string) {
  assert.equal(f.statuses.get("plan-mode"), expected);
  assert.equal(f.statuses.get("plan-implementation"), undefined);
  assert.ok(f.statusHistory.every(({ key, value }) => key !== "plan-implementation" || value === undefined));
}

async function assertSingleFile(document: import("../src/plan-store.js").PlanDocument) {
  assert.deepEqual(
    (await readdir(dirname(document.path))).filter((name) => name.endsWith(".md")),
    [basename(document.path)],
  );
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
    const toggle = shortcuts.get("alt+m");
    assert.ok(toggle);
    assert.match(toggle.description ?? "", /planning and normal/);
    assert.equal(shortcuts.size, 1);
    for (const enter of ["\r", "\n", "\u001b[13u"]) assert.equal(matchesKey(enter, "alt+m"), false);
    assert.equal(matchesKey("\u001b[200~pasted\u001b[109;3u\u001b[201~", "alt+m"), false);
    assert.equal(matchesKey("\u001b[109;3u", "alt+m"), true);
    assert.equal(matchesKey("\u001bm", "alt+m"), true);
    assert.equal(matchesKey("\u001b\r", "alt+m"), false);
    const context = { ...runner.createContext(), mode: "tui" as const };
    const previousTools = f.runtime.session.getActiveToolNames();
    await toggle.handler(context);
    assert.equal(stateOf(f.runtime.session).kind, "planning");
    assertStatus(f, "[Planning]");
    await toggle.handler(context);
    assert.equal(stateOf(f.runtime.session).kind, "idle");
    assertStatus(f, "[Normal]");
    assert.deepEqual(f.runtime.session.getActiveToolNames(), previousTools);
    assert.equal(f.requests.length, 0);
    // A user's reserved binding wins over the extension default.
    assert.equal(runner.getShortcuts({ ...bindings, "app.model.select": "alt+m" }).size, 0);
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

test("real tree navigation restores the verification-start boundary without resurrecting implementation", async () => {
  const entered = Promise.withResolvers<import("../src/verification.js").VerificationInput>();
  const finished = Promise.withResolvers<import("../src/verification.js").VerificationResult>();
  const f = await fixture(undefined, undefined, undefined, async (input) => {
    entered.resolve(input);
    return finished.promise;
  });
  try {
    const session = f.runtime.session;
    const baseline = session.getActiveToolNames();
    await session.prompt("/plan start");
    await f.complete();
    f.choose("here");
    const beforeKickoff = f.requests.length;
    await session.prompt("/plan");
    await vi.waitFor(() => assert.equal(f.requests.length, beforeKickoff + 1));
    await session.waitForIdle();
    const checking = session.prompt("/plan verify");
    const input = await entered.promise;
    const boundary = session.sessionManager.getLeafId();
    assert.ok(boundary);
    assert.equal(restoreImplementation(session.sessionManager.getBranch())?.phase, "completed");
    session.sessionManager.appendCustomEntry("test-descendant", {});
    await session.navigateTree(boundary, { summarize: false });
    assert.equal(input.signal.aborted, true);
    assertStatus(f, "[Normal]");
    assert.deepEqual(session.getActiveToolNames(), baseline);
    const entries = structuredClone(session.sessionManager.getEntries());
    finished.resolve({ model: { provider: "offline", id: "checker" }, report: { status: "ok", motivation: "Late" } });
    await checking;
    assert.deepEqual(session.sessionManager.getEntries(), entries);
    assertStatus(f, "[Normal]");
    await session.prompt("/plan resume");
    assertStatus(f, "[Implementing runtime-smoke]");
    assert.deepEqual(f.errors, []);
  } finally {
    await f.dispose();
  }
});

test("real completion runs one isolated checker and terminates without a main-agent retry", async () => {
  const f = await fixture();
  try {
    const session = f.runtime.session;
    await session.prompt("PRIVATE PLANNING CONTENT");
    await session.prompt("/plan start");
    const ready = await f.complete();
    f.choose("here");
    const beforeKickoff = f.requests.length;
    await session.prompt("/plan");
    await vi.waitFor(() => assert.equal(f.requests.length, beforeKickoff + 1));
    await session.waitForIdle();
    assertStatus(f, `[Implementing ${ready.document.name}]`);
    await session.prompt("Keep the material requirements unchanged.");
    const prefix = f.requests.at(-1);
    assert.ok(prefix);
    await session.prompt("Continue following the same plan.");
    assert.deepEqual(
      f.requests.at(-1)?.slice(0, prefix.length),
      prefix,
      "ordinary implementation turns retain the request prefix",
    );
    // The checker must capture the current disk target, not the kickoff text or stored hash.
    const currentPlan = `${plan}\n\nCurrent on-disk verification requirement.`;
    const raw = await readFile(ready.document.path, "utf8");
    await writeFile(ready.document.path, raw.replace(plan, currentPlan));
    const before = f.requests.length;
    f.queueTool("plan_mode_implementation_complete");
    await session.prompt("Implementation is ready; signal completion now.");
    assert.equal(f.requests.length, before + 2, "one main tool call plus one fresh checker response");
    const childRequest = f.requests.at(-1);
    assert.ok(childRequest);
    assert.equal(JSON.stringify(childRequest).includes("PRIVATE PLANNING CONTENT"), false);
    assert.ok(JSON.stringify(childRequest).includes("Keep the material requirements unchanged."));
    assert.ok(JSON.stringify(childRequest).includes("Current on-disk verification requirement."));
    assert.ok(JSON.stringify(childRequest).includes(planHash(currentPlan)));
    assert.equal(restoreImplementation(session.sessionManager.getBranch())?.phase, "completed");
    assert.equal(restoreImplementation(session.sessionManager.getBranch())?.lastCheck?.status, "ok");
    assert.equal(restoreImplementation(session.sessionManager.getBranch())?.lastCheck?.hash, planHash(currentPlan));
    assert.ok(
      f.statusHistory.some(({ key, value }) => key === "plan-mode" && value === `[Verifying ${ready.document.name}]`),
    );
    assertStatus(f, "[Normal]");
    assert.deepEqual(toolNames(childRequest), ["find", "grep", "ls", "read", "submit_adherence_report"]);
    assert.equal(session.getActiveToolNames().includes("submit_adherence_report"), false);
    assert.equal(session.getActiveToolNames().includes("plan_mode_implementation_complete"), false);
    await session.prompt("UNRELATED AFTER COMPLETION");
    await session.prompt("/plan resume");
    assert.equal(restoreImplementation(session.sessionManager.getBranch())?.lastCheck, undefined);
    assert.equal(restoreImplementation(session.sessionManager.getBranch())?.phase, "implementing");
    assert.equal(restoreImplementation(session.sessionManager.getBranch())?.hash, planHash(currentPlan));
    assertStatus(f, `[Implementing ${ready.document.name}]`);
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

test("a file replacement uses the configured agent directory and survives real compaction unchanged", async () => {
  const f = await fixture((pi) => {
    pi.on("session_before_compact", (event) => ({
      compaction: {
        summary: "Planning is still active.",
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    }));
  });
  const path = join(agentDir, "pi-plan-mode-prompt.md");
  try {
    await writeFile(path, "# Custom protocol\n\nPlan as a checklist.");
    const session = f.runtime.session;
    await session.prompt("/plan start");
    await session.prompt("First planning turn.");
    const first = f.requests.at(-1);
    assert.ok(first);
    const section = f.promptOptions.at(-1)?.section;
    assert.ok(section);
    assert.ok(section.startsWith("# Custom protocol"));
    assert.ok(section.includes(instructions));
    assert.equal(section.includes("CODEX-LIKE"), false);
    await writeFile(path, "# Edited protocol");
    await session.prompt("Second planning turn.");
    assert.deepEqual(f.requests.at(-1)?.slice(0, first.length), first);
    session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
    await session.compact();
    await session.prompt("Continue after compaction.");
    assert.equal(f.promptOptions.at(-1)?.section, section);
    assert.ok(getCurrentSystemPrompt(f.requests.at(-1) ?? []).includes(section));
    assert.deepEqual(toolNames(f.requests.at(-1) ?? []), [...planningTools].sort());
    await session.prompt("/plan exit");
    await session.prompt("/plan start");
    await session.prompt("New workflow.");
    assert.ok(f.promptOptions.at(-1)?.section?.startsWith("# Edited protocol"));
  } finally {
    await rm(path, { force: true });
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
    assert.equal(basename(ready.document.path), "runtime-smoke.md");
    assert.equal(dirname(dirname(ready.document.path)), join(agentDir, "pi-plan-mode"));
    assert.equal(await f.readPlan(ready.document), plan);
    assert.match(await readFile(ready.document.path, "utf8"), /^<!-- pi-plan-document-v3:/);
    assert.equal(ready.workflow.version, 3);
    assert.ok(ready.workflow.id);
    assert.equal(ready.workflow.name, ready.document.name);
    assert.deepEqual(ready.workflow.document, ready.document);
    assert.equal(ready.workflow.hash, planHash(plan));
    assert.equal("parent" in ready.workflow, false);
    assert.equal("series" in ready.workflow, false);
    assert.equal("plan" in ready.workflow, false);
    await assertSingleFile(ready.document);
    const result = session.messages.findLast((message) => message.role === "toolResult");
    assert.ok(result?.role === "toolResult");
    assert.equal(result.isError, false);
    const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    assert.ok(text.includes(plan));
    assert.ok(text.includes(ready.document.path));
    assertStatus(f, `[Planning ${ready.document.name}]`);
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
    const actions = tui.render().join("\n");
    assert.match(actions, /Implement in fresh session/);
    assert.match(actions, /Implement here/);
    assert.equal(f.requests.length, 1, "opening review is not implementation approval");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await reopened;
    await vi.waitFor(() => assert.equal(f.requests.length, 2));
    await session.waitForIdle();
    assert.equal(f.requests.length, 2);
    assert.equal(stateOf(session).kind, "idle");
    assert.equal(restoreImplementation(session.sessionManager.getBranch())?.phase, "implementing");
  } finally {
    await f.dispose();
  }
});

test("ordinary planning and later replacements automatically present review without control-text model requests", async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const unsubscribe = f.runtime.session.subscribe((event) => {
    if (event.type === "agent_start") started.resolve();
  });
  try {
    const session = f.runtime.session;
    await session.prompt("/plan start");
    f.queueTool("plan_mode_complete", { plan });
    await session.prompt("Finish the plan.");
    await started.promise;
    await session.waitForIdle();
    assert.equal(f.reviewPlan.mock.calls.length, 1);
    assert.equal(f.requests.length, 1);
    const first = stateOf(session);
    assert.ok(first.kind === "ready");
    const replacement = "# Replacement plan\n\nA new complete body, not an appended revision.";
    f.queueTool("plan_mode_complete", { plan: replacement });
    await session.prompt("Replace the plan with the new requirements.");
    await session.waitForIdle();
    assert.equal(f.reviewPlan.mock.calls.length, 2);
    assert.equal(f.requests.length, 2);
    const ready = stateOf(session);
    assert.ok(ready.kind === "ready");
    assert.equal(ready.document.id, first.document.id);
    assert.equal(ready.document.path, first.document.path);
    assert.equal(ready.document.name, first.document.name);
    assert.equal(ready.document.title, "Replacement plan");
    assert.equal(ready.workflow.id, first.workflow.id);
    assert.equal(ready.workflow.hash, planHash(replacement));
    assert.equal(await f.readPlan(first.document), replacement);
    assert.equal(f.reviewPlan.mock.calls.at(-1)?.[1], replacement);
    await assertSingleFile(ready.document);
    assert.equal(JSON.stringify(f.requests).includes("__review"), false);
  } finally {
    unsubscribe();
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
    assertStatus(f, `[Planning ${ready.document.name}]`);
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
  "implement reviews manual disk edits and action %s does not replace the session",
  async (action) => {
    const f = await fixture();
    try {
      const session = f.runtime.session;
      const previous = session.getActiveToolNames();
      await session.prompt("/plan start");
      const ready = await f.complete();
      const edited = plan.replace("Inspect the affected code.", "Preserve the manually edited requirements.");
      const bytes = await readFile(ready.document.path, "utf8");
      await writeFile(ready.document.path, bytes.replace(plan, edited));
      f.choose(action);
      await session.prompt("/plan implement");
      await session.waitForIdle();
      assert.equal(f.runtime.session, session);
      assert.equal(f.newSessions.length, 0);
      assert.equal(f.reviewPlan.mock.calls.length, 2, "implement reopens the dismissed automatic review");
      assert.equal(f.reviewPlan.mock.calls[1]?.[1], edited);
      assert.deepEqual(f.reviewPlan.mock.calls[1]?.[2], ready.document);
      assert.equal(await f.readPlan(ready.document), edited);
      if (action === undefined) {
        assert.equal(stateOf(session).kind, "ready");
        assert.equal(f.requests.length, 1);
      } else if (action === "save") {
        assert.equal(stateOf(session).kind, "idle");
        assert.deepEqual(session.getActiveToolNames(), previous);
        assert.equal(f.requests.length, 1);
      } else {
        assert.equal(f.requests.length, 2);
        const request = f.requests.at(-1);
        assert.ok(request);
        assert.ok(JSON.stringify(request).includes("Preserve the manually edited requirements."));
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
    assert.equal(await f.readPlan(ready.document), plan);
  } finally {
    await f.dispose();
  }
});

test("fresh review uses command newSession/withSession and transfers only the full plan", async () => {
  const f = await fixture();
  try {
    const old = f.runtime.session;
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
    assert.deepEqual(replacement.getActiveToolNames(), ["read", "write", ...IMPLEMENTATION_HELPERS]);
    const tracked = restoreImplementation(replacement.sessionManager.getBranch());
    assert.equal(tracked?.phase, "implementing");
    assert.ok(tracked);
    assert.equal(tracked.version, 3);
    assert.deepEqual(tracked.document, ready.document);
    assert.equal(tracked.hash, planHash(plan));
    assert.equal("revisions" in tracked, false);
    assert.equal("plan" in tracked, false);
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
    assert.ok(text.startsWith("Implement the reviewed plan below."));
    assert.ok(text.includes(plan));
    assert.ok(text.includes(ready.document.path));
    assert.equal(JSON.stringify(transferred).includes("Private planning discussion"), false);
    assert.equal(JSON.stringify(replacement.sessionManager.getEntries()).includes("not-for-implementation"), false);
    assert.equal(getCurrentSystemPrompt(transferred).includes(instructions), false);
    assert.deepEqual(toolNames(transferred), ["read", "write", ...IMPLEMENTATION_HELPERS].sort());
    assert.equal(await f.readPlan(ready.document), plan);
  } finally {
    await f.dispose();
  }
});

test("real edit activation, terminating planning review, implementation continuation, and branch restoration share one helper", async () => {
  const f = await fixture((pi) => {
    pi.on("session_before_compact", (event) => ({
      compaction: {
        summary: "Continue the tracked implementation from its authoritative plan status.",
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    }));
  });
  try {
    const session = f.runtime.session;
    const baselineTools = session.getActiveToolNames();
    await session.prompt("Baseline context before planning.");
    await session.prompt("/plan start");
    const first = await f.complete();
    const before = f.requests.length;
    f.queueTool("plan_mode_edit", {
      path: first.document.path,
      edits: [{ oldText: "Inspect the affected code.", newText: "Inspect the parser." }],
    });
    await session.prompt("Localize the inspection step.");
    assert.equal(f.requests.length, before + 1, "planning edits terminate without another model request");
    const second = stateOf(session);
    assert.ok(second.kind === "ready");
    const secondPlan = plan.replace("Inspect the affected code.", "Inspect the parser.");
    assert.equal(second.document.id, first.document.id);
    assert.equal(second.document.path, first.document.path);
    assert.equal(second.document.name, first.document.name);
    assert.equal(second.workflow.hash, planHash(secondPlan));
    assert.equal(await f.readPlan(first.document), secondPlan);
    assert.equal(f.reviewPlan.mock.calls.length, 2);
    assert.equal(f.reviewPlan.mock.calls.at(-1)?.[1], secondPlan);
    const result = session.messages.findLast((message) => message.role === "toolResult");
    assert.ok(result?.role === "toolResult");
    assert.equal(result.isError, false);
    const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    assert.ok(text.includes(second.document.path));
    assert.equal(text.includes(secondPlan), false);
    const readyLeaf = session.sessionManager.getLeafId();
    assert.ok(readyLeaf);
    f.choose("here");
    const beforeKickoff = f.requests.length;
    await session.prompt("/plan");
    await vi.waitFor(() => assert.equal(f.requests.length, beforeKickoff + 1));
    await session.waitForIdle();
    assert.deepEqual(session.getActiveToolNames(), [...baselineTools, ...IMPLEMENTATION_HELPERS]);
    assert.equal(session.getActiveToolNames().filter((name) => name === "plan_mode_edit").length, 1);
    const beforeEdit = f.requests.length;
    f.queueTool("plan_mode_edit", {
      path: second.document.path,
      edits: [{ oldText: "Verify the result.", newText: "Verify Unicode parsing." }],
    });
    await session.prompt("Include Unicode verification before proceeding.");
    assert.equal(f.requests.length, beforeEdit + 2, "implementation edits allow the normal follow-up request");
    const tracked = restoreImplementation(session.sessionManager.getBranch());
    assert.ok(tracked);
    assert.equal(tracked.phase, "implementing");
    assert.equal(tracked.version, 3);
    assert.deepEqual(tracked.document, second.document);
    const latestPlan = secondPlan.replace("Verify the result.", "Verify Unicode parsing.");
    assert.equal(tracked.hash, planHash(latestPlan));
    assert.equal(await f.readPlan(tracked.document), latestPlan);
    assert.equal("revisions" in tracked, false);
    assert.equal("plan" in tracked, false);
    await assertSingleFile(tracked.document);
    assert.equal(f.reviewPlan.mock.calls.length, 3, "only the manual implementation choice opened another review");
    session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
    await session.compact();
    // Recovery reads disk even when branch tracking still holds the previous fingerprint.
    const diskPlan = `${latestPlan}\n\nExternal current requirement.`;
    const raw = await readFile(tracked.document.path, "utf8");
    await writeFile(tracked.document.path, raw.replace(latestPlan, diskPlan));
    f.queueTool("plan_mode_implementation_status");
    await session.prompt("Recover the current plan after compaction.");
    assert.ok(session.getActiveToolNames().includes("plan_mode_edit"));
    const status = session.messages.findLast((message) => message.role === "toolResult");
    assert.ok(status?.role === "toolResult");
    assert.equal(status.isError, false);
    const statusText = status.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    assert.ok(statusText.includes(tracked.document.path));
    assert.ok(statusText.includes(diskPlan));
    assert.ok(statusText.includes(planHash(diskPlan)));
    assert.equal(restoreImplementation(session.sessionManager.getBranch())?.hash, planHash(diskPlan));
    const implementationLeaf = session.sessionManager.getLeafId();
    assert.ok(implementationLeaf);
    await session.prompt("/plan exit");
    assert.deepEqual(session.getActiveToolNames(), baselineTools);
    await session.navigateTree(readyLeaf, { summarize: false });
    assert.deepEqual(
      session.getActiveToolNames().sort(),
      [...planningTools].sort(),
      "implementation restoration must not strip the shared edit helper from planning",
    );
    // Branch restoration restores ownership, not historical file contents. Re-review
    // the live file to refresh the earlier planning branch's optimistic-write hash.
    await session.prompt("/plan");
    assert.equal(f.reviewPlan.mock.calls.at(-1)?.[1], diskPlan);
    f.queueTool("plan_mode_edit", {
      path: second.document.path,
      edits: [{ oldText: "Inspect the parser.", newText: "Inspect the lexer." }],
    });
    await session.prompt("Revise this earlier planning branch instead.");
    const branch = stateOf(session);
    assert.ok(branch.kind === "ready");
    const branchPlan = diskPlan.replace("Inspect the parser.", "Inspect the lexer.");
    assert.equal(branch.document.id, first.document.id);
    assert.equal(branch.document.path, first.document.path);
    assert.equal(branch.workflow.hash, planHash(branchPlan));
    assert.equal(await f.readPlan(branch.document), branchPlan);
    assert.equal(restoreImplementation(session.sessionManager.getBranch()), undefined);
    await session.navigateTree(implementationLeaf, { summarize: false });
    assert.deepEqual(restoreImplementation(session.sessionManager.getBranch())?.document, tracked.document);
    assert.equal(await f.readPlan(tracked.document), branchPlan, "navigation must not roll back the shared file");
    assert.deepEqual(session.getActiveToolNames(), [...baselineTools, ...IMPLEMENTATION_HELPERS]);
    f.queueTool("plan_mode_implementation_status");
    await session.prompt("Read the live plan on this restored implementation branch.");
    assert.equal(restoreImplementation(session.sessionManager.getBranch())?.hash, planHash(branchPlan));
    await assertSingleFile(branch.document);
    assert.equal(f.runtime.session.extensionRunner.getToolDefinition("plan_mode_edit")?.executionMode, "sequential");
    await f.runtime.newSession();
    assert.equal(f.runtime.session.getActiveToolNames().includes("plan_mode_edit"), false);
    assert.deepEqual(stateOf(f.runtime.session), { kind: "idle" });
    assert.equal(JSON.stringify(f.requests).includes("__review"), false);
  } finally {
    await f.dispose();
  }
});

test("real planning save helpers reject sibling batches and nested relays; implementation editing remains nestable", async () => {
  let target = "plan_mode_complete";
  let input: ToolCall["arguments"] = { plan };
  let nestedError: boolean | undefined;
  const f = await fixture(
    (pi) => {
      pi.registerTool({
        name: "plan_test_relay",
        label: "Test relay",
        description: "Exercise nested tool permissions.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute(_id, _params, signal, _update, ctx) {
          const result = await ctx.executeTool(target, input, { signal });
          nestedError = result.isError;
          return { ...result.result, isError: result.isError };
        },
      });
    },
    undefined,
    ["read", "plan_test_relay"],
  );
  try {
    const session = f.runtime.session;
    await session.prompt("/plan start");
    const first = await f.complete();
    for (const name of ["plan_mode_complete", "plan_mode_edit"]) {
      target = name;
      input =
        name === "plan_mode_complete"
          ? { plan: `${plan}\n\nNew requirement.` }
          : {
              path: first.document.path,
              edits: [{ oldText: "Verify the result.", newText: "Verify Unicode parsing." }],
            };
      f.queueBatch([
        { name, arguments: input },
        { name: "read", arguments: { path: first.document.path } },
      ]);
      await session.prompt("Try saving alongside an inspection call.");
      const blocked = session.messages.findLast(
        (message) => message.role === "toolResult" && message.toolName === name,
      );
      assert.ok(blocked?.role === "toolResult");
      assert.equal(blocked.isError, true);
      nestedError = undefined;
      f.queueTool("plan_test_relay");
      await session.prompt("Try the same save through a trusted relay.");
      assert.equal(nestedError, true, "a trusted orchestrator cannot hide a planning finalization call");
      const current = stateOf(session);
      assert.ok(current.kind === "planning");
      assert.deepEqual(current.workflow.document, first.document);
      assert.equal(current.workflow.hash, planHash(plan));
      assert.equal(await f.readPlan(first.document), plan);
      await assertSingleFile(first.document);
      assert.equal(f.reviewPlan.mock.calls.length, 1, "rejected saves must not schedule review");
    }
    // A standalone retry still works, and only planning imposes this turn-ending protocol.
    await f.complete();
    f.choose("here");
    const beforeKickoff = f.requests.length;
    await session.prompt("/plan");
    await vi.waitFor(() => assert.equal(f.requests.length, beforeKickoff + 1));
    await session.waitForIdle();
    const baseline = restoreImplementation(session.sessionManager.getBranch());
    assert.ok(baseline);
    target = "plan_mode_edit";
    input = {
      path: baseline.document.path,
      edits: [{ oldText: "Verify the result.", newText: "Verify Unicode parsing." }],
    };
    nestedError = undefined;
    const before = f.requests.length;
    f.queueTool("plan_test_relay");
    await session.prompt("Record this implementation change through the relay.");
    assert.equal(nestedError, false);
    assert.equal(f.requests.length, before + 2, "nested implementation edits do not end the turn");
    const revised = restoreImplementation(session.sessionManager.getBranch());
    assert.ok(revised);
    const revisedPlan = plan.replace("Verify the result.", "Verify Unicode parsing.");
    assert.deepEqual(revised.document, baseline.document);
    assert.equal(revised.hash, planHash(revisedPlan));
    assert.equal(await f.readPlan(baseline.document), revisedPlan);
    assert.equal("revisions" in revised, false);
    assert.equal("plan" in revised, false);
    assert.equal(f.reviewPlan.mock.calls.length, 3);
    // Broad implementation updates use the same complete-body schema, without a reason.
    const replacement = "# New implementation body\n\nImplement the replacement requirements.";
    const beforeUpdate = f.requests.length;
    f.queueTool("plan_mode_update", { plan: replacement });
    await session.prompt("Replace the implementation plan with this complete body.");
    assert.equal(f.requests.length, beforeUpdate + 2);
    const updated = restoreImplementation(session.sessionManager.getBranch());
    assert.ok(updated);
    assert.equal(updated.document.id, baseline.document.id);
    assert.equal(updated.document.path, baseline.document.path);
    assert.equal(updated.document.name, baseline.document.name);
    assert.equal(updated.document.title, "New implementation body");
    assert.equal(updated.hash, planHash(replacement));
    assert.equal(await f.readPlan(baseline.document), replacement);
    await assertSingleFile(updated.document);
    assert.equal(f.reviewPlan.mock.calls.length, 3, "implementation replacement does not open another review");
  } finally {
    await f.dispose();
  }
});
