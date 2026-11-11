import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText as terminalText } from "@narumitw/pi-tui-kit/terminal-text";
import {
  ARTIFACT_ENTRY,
  ARTIFACT_TOOLS,
  ArtifactNotReady,
  artifactGuidance,
  artifactReadiness,
  artifactRequest,
  artifactScope,
  associate,
  collectArtifactReferences,
  validArtifactReference,
} from "./artifacts.js";
import {
  normalizePlanModeCompletion,
  PLAN_MODE_COMPLETE_PARAMS,
  PLAN_MODE_COMPLETE_TOOL_NAME,
  planModeCompleted,
  renderPlanModeCompletion,
} from "./completion-tool.js";
import { applyPlanEdits, PLAN_MODE_EDIT_PARAMS, PLAN_MODE_EDIT_TOOL_NAME, planModeEdited } from "./edit-tool.js";
import { implementationPrompt, startFreshImplementation } from "./fresh-implementation.js";
import { type ImplementationDependencies, registerImplementation } from "./implementation.js";
import { editPlanDocument } from "./plan-editor.js";
import { fallbackPlanName, MAX_NAME_TASK_CHARS, requestPlanName } from "./plan-name.js";
import {
  createPlanStore,
  type PlanDocument,
  type PlanStorage,
  type PlanStore,
  planHash,
  storedPlanStorage,
} from "./plan-store.js";
import {
  openPlanModePrompt,
  planModePromptPath,
  readPlanModeBasePrompt,
  readPlanModeInstructions,
  savePlanModePrompt,
} from "./planning-instructions.js";
import { buildPlanModePrompt } from "./prompt.js";
import {
  answerPlanModeQuestions,
  normalizePlanModeQuestionParams,
  PLAN_MODE_QUESTION_PARAMS,
  PLAN_MODE_QUESTION_TOOL_NAME,
  planModeQuestionCancelled,
} from "./question-tool.js";
import {
  DEFAULT_TOGGLE_SHORTCUT,
  type PlanModeSettings,
  readPlanModeSettings,
  updatePlanModeSettings,
} from "./settings.js";
import { legacyPlanState, PLAN_STATE_ENTRY, type PlanState, type PlanWorkflow, restorePlanState } from "./state.js";
import { defaultPlanTools, PLAN_HELPER_NAMES, resolvePlanTools, standaloneToolCall } from "./tool-policy.js";

type InteractiveUi = typeof import("./interactive-ui.js");
interface PlanModeDependencies extends ImplementationDependencies {
  readSettings?(): Promise<PlanModeSettings>;
  readInstructions?(): string;
  readBasePrompt?(): string;
  createStore?: typeof createPlanStore;
  loadUi?(): Promise<InteractiveUi>;
  namePlan?: typeof requestPlanName;
}

export default async function planMode(pi: ExtensionAPI, dependencies: PlanModeDependencies = {}) {
  let state: PlanState = { kind: "idle" };
  let session: ExtensionContext["sessionManager"] | undefined;
  let generation = 0;
  let interaction = new AbortController();
  // Commands and keyboard toggles share this gate across asynchronous transitions.
  let commandOpen = false;
  let naming: { id: string; controller: AbortController; promise: Promise<string> } | undefined;
  function cancelNaming() {
    naming?.controller.abort();
    naming = undefined;
  }
  function startNaming(ctx: ExtensionContext, task: string) {
    if (state.kind === "idle" || state.workflow.name || state.workflow.task || !task.trim()) return;
    const workflow = { ...state.workflow, task: task.slice(0, MAX_NAME_TASK_CHARS) };
    commit({ ...state, workflow });
    const owner = ctx.sessionManager;
    const controller = new AbortController();
    const request = { id: workflow.id, controller, promise: Promise.resolve("") };
    naming = request;
    request.promise = (async () => {
      let name = fallbackPlanName(workflow.task);
      try {
        const settings = await readSettings();
        if (!controller.signal.aborted)
          name = await (dependencies.namePlan ?? requestPlanName)(
            ctx.modelRegistry,
            workflow.task,
            settings,
            controller.signal,
          );
      } catch {
        /* Naming never prevents planning. */
      }
      const live: PlanState = state as PlanState;
      if (
        naming === request &&
        session === owner &&
        !controller.signal.aborted &&
        live.kind !== "idle" &&
        live.workflow.id === workflow.id
      ) {
        try {
          commit({ ...live, workflow: { ...live.workflow, name } });
          updateStatus(ctx);
        } catch (error) {
          notify(ctx, `Plan name could not be persisted; first save will retry: ${errorMessage(error)}`, "warning");
        }
      }
      return name;
    })();
  }
  async function resolveName() {
    if (state.kind === "idle") throw new Error("No active planning workflow.");
    if (state.workflow.name) return state.workflow.name;
    if (naming?.id === state.workflow.id) return naming.promise;
    return fallbackPlanName(state.workflow.task ?? "untitled plan");
  }
  let shortcutStartupError: string | undefined;
  let pendingReview:
    | {
        token: string;
        path: string;
        current: ReturnType<typeof lifecycle>;
        queued: boolean;
      }
    | undefined;
  const readSettings = dependencies.readSettings ?? readPlanModeSettings;
  const makeStore = dependencies.createStore ?? createPlanStore;
  const loadUi = dependencies.loadUi ?? (() => import("./interactive-ui.js"));

  function invalidate() {
    pendingReview = undefined;
    generation++;
    interaction.abort();
    interaction = new AbortController();
  }

  function lifecycle(ctx: ExtensionContext) {
    const version = generation;
    const controller = interaction;
    const owner = ctx.sessionManager;
    return {
      signal: controller.signal,
      isCurrent: () => session === owner && generation === version && !controller.signal.aborted,
    };
  }

  function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
    if (session !== ctx.sessionManager || !ctx.hasUI) return;
    ctx.ui.notify(terminalText(message), level);
  }

  function updateStatus(ctx: ExtensionContext) {
    if (session !== ctx.sessionManager || !ctx.hasUI) return;
    const tracked = implementation.state;
    const text =
      state.kind !== "idle"
        ? `[Planning${state.workflow.name ? ` ${state.workflow.name}` : ""}]`
        : implementation.checking(ctx) && tracked
          ? `[Verifying ${tracked.document.name}]`
          : implementation.active(ctx) && tracked
            ? `[Implementing ${tracked.document.name}]`
            : "[Normal]";
    ctx.ui.setStatus("plan-mode", terminalText(text));
  }

  function commit(next: PlanState) {
    // Persistence can throw. Do not discard the recoverable in-memory state first.
    pi.appendEntry(PLAN_STATE_ENTRY, next);
    state = next;
  }

  function idle(ctx: ExtensionContext) {
    if (!ctx.isIdle() || ctx.hasPendingMessages())
      throw new Error("Wait for the agent to settle before changing Plan mode.");
  }

  function planTools(workflow: PlanWorkflow) {
    const resolved = resolvePlanTools(pi.getAllTools(), workflow.tools);
    if (PLAN_HELPER_NAMES.some((name) => !resolved.active.includes(name))) {
      throw new Error("The Plan helpers must be registered and available.");
    }
    return resolved;
  }

  function transition(next: PlanState, ctx: ExtensionContext) {
    const oldTools = pi.getActiveTools();
    const tools =
      next.kind !== "idle"
        ? planTools(next.workflow).active
        : state.kind !== "idle"
          ? state.workflow.previousTools
          : oldTools;
    try {
      pi.setActiveTools(tools);
      commit(next);
    } catch (error) {
      try {
        pi.setActiveTools(oldTools);
      } catch {
        /* The old state's execution gate remains in force. */
      }
      throw error;
    }
    if (next.kind === "idle") cancelNaming();
    invalidate();
    updateStatus(ctx);
  }

  async function storeFor(ctx: ExtensionContext, workflow?: PlanWorkflow): Promise<PlanStore> {
    const location = workflow ? storedPlanStorage(workflow) : { kind: "repo" as const };
    const store = await makeStore(ctx.cwd, location);
    if (workflow && store.projectRoot !== workflow.projectRoot)
      throw new Error("This Plan workflow belongs to a different project.");
    return store;
  }

  async function enter(
    ctx: ExtensionContext,
    options: {
      tools?: string[];
      document?: PlanDocument;
      hash?: string;
      storage?: PlanStorage;
    } = {},
  ) {
    idle(ctx);
    if (state.kind !== "idle") return lifecycle(ctx);
    const current = lifecycle(ctx);
    const settings = await readSettings();
    if (!current.isCurrent()) return;
    const store = await makeStore(ctx.cwd, options.storage ?? { kind: "repo" });
    if (!current.isCurrent()) return;
    idle(ctx);
    const instructions = (dependencies.readInstructions ?? readPlanModeInstructions)();
    const basePrompt = (dependencies.readBasePrompt ?? readPlanModeBasePrompt)();
    const previousImplementation = implementation.state;
    let workflow: PlanWorkflow;
    try {
      if (previousImplementation?.phase === "implementing") implementation.detach(ctx);
      workflow = {
        version: 3,
        id: randomUUID(),
        projectRoot: store.projectRoot,
        storage: store.storage,
        artifacts: options.document?.artifacts ?? {
          version: 1,
          workspace: { id: randomUUID(), directory: "" },
          references: [],
        },
        instructions,
        basePrompt,
        previousTools: pi.getActiveTools(),
        ...((options.tools ?? settings.tools) ? { tools: options.tools ?? settings.tools } : {}),
        ...(options.document ? { document: options.document, name: options.document.name, hash: options.hash } : {}),
      };
      if (workflow.artifacts && !workflow.artifacts.workspace.directory)
        workflow.artifacts.workspace.directory = join(store.directory, "artifacts", workflow.artifacts.workspace.id);
      transition({ kind: "planning", workflow }, ctx);
    } catch (error) {
      if (previousImplementation?.phase === "implementing") implementation.rollback(previousImplementation, ctx);
      throw error;
    }
    const unavailable = planTools(workflow).unavailable;
    if (unavailable.length)
      notify(ctx, `Selected tools are not currently available: ${unavailable.join(", ")}`, "warning");
    return lifecycle(ctx);
  }

  async function leave(ctx: ExtensionContext) {
    idle(ctx);
    const current = lifecycle(ctx);
    if (state.kind !== "idle") {
      await artifactRequest(
        pi,
        ctx,
        "cancel",
        collectArtifactReferences(ctx, state.workflow.artifacts)
          ?.references.filter((r) => r.status === "queued" || r.status === "running")
          .map((r) => r.jobId) ?? [],
      );
      if (current.isCurrent()) transition({ kind: "idle" }, ctx);
    }
  }

  async function restore(ctx: ExtensionContext) {
    const previous = state;
    cancelNaming();
    invalidate();
    // Tree navigation does not replace the extension instance. Release its previous loadout first.
    if (session === ctx.sessionManager && previous.kind !== "idle") pi.setActiveTools(previous.workflow.previousTools);
    session = ctx.sessionManager;
    try {
      state = restorePlanState(ctx.sessionManager.getBranch());
    } catch (error) {
      state = { kind: "idle" };
      notify(
        ctx,
        `${legacyPlanState(ctx.sessionManager.getBranch()) ? "Legacy Plan workflows are not restored." : errorMessage(error)} Start fresh with /plan start and paste the Markdown body text.`,
        "warning",
      );
    }
    const current = lifecycle(ctx);
    try {
      if (state.kind !== "idle") {
        if (state.workflow.task && !state.workflow.name)
          commit({ ...state, workflow: { ...state.workflow, name: fallbackPlanName(state.workflow.task) } });
        const candidate = state;
        const store = await storeFor(ctx, candidate.workflow);
        if (!current.isCurrent()) return;
        if (!candidate.workflow.artifacts) {
          const id = randomUUID();
          candidate.workflow.artifacts = candidate.workflow.document?.artifacts ?? {
            version: 1,
            workspace: { id, directory: join(store.directory, "artifacts", id) },
            references: [],
          };
        }
        for (const entry of ctx.sessionManager.getBranch())
          if (entry.type === "custom" && entry.customType === ARTIFACT_ENTRY && validArtifactReference(entry.data))
            candidate.workflow.artifacts = associate(candidate.workflow.artifacts, entry.data);
        pi.setActiveTools(planTools(candidate.workflow).active);
      }
    } catch (error) {
      if (!current.isCurrent()) return;
      const candidate = state;
      if (candidate.kind !== "idle") pi.setActiveTools(candidate.workflow.previousTools);
      state = { kind: "idle" };
      notify(ctx, `Plan mode could not be restored: ${errorMessage(error)}`, "error");
    }
    if (current.isCurrent()) updateStatus(ctx);
  }

  pi.events.on(ARTIFACT_ENTRY, (value) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("sessionId" in value) ||
      !("reference" in value) ||
      !validArtifactReference(value.reference) ||
      state.kind === "idle" ||
      value.sessionId !== session?.getSessionId() ||
      !state.workflow.artifacts
    )
      return;
    const artifacts = associate(state.workflow.artifacts, value.reference);
    if (artifacts !== state.workflow.artifacts) commit({ ...state, workflow: { ...state.workflow, artifacts } });
  });

  pi.on("session_start", async (_event, ctx) => {
    await restore(ctx);
    if (shortcutStartupError && session === ctx.sessionManager && ctx.hasUI) {
      notify(ctx, shortcutStartupError, "error");
      shortcutStartupError = undefined;
    }
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (session !== ctx.sessionManager) return;
    cancelNaming();
    invalidate();
    try {
      if (state.kind !== "idle") pi.setActiveTools(state.workflow.previousTools);
    } finally {
      if (ctx.hasUI) ctx.ui.setStatus("plan-mode", undefined);
      session = undefined;
    }
  });

  pi.on("input", (event, ctx) => {
    if (session === ctx.sessionManager) startNaming(ctx, event.text);
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (session === ctx.sessionManager && event.messageType === "user") startNaming(ctx, event.prompt);
    invalidate();
    if (state.kind !== "idle" && session === ctx.sessionManager) {
      // Set guidance even if persisting the ready-to-planning transition subsequently fails.
      // Native sections survive compaction and use Pi's ordinary prompt/tool deltas.
      const base = state.kind === "ready" ? state.document : state.workflow.document;
      event.systemPromptOptions.sections.pi_plan_mode =
        buildPlanModePrompt(state.workflow.instructions, state.workflow.basePrompt) +
        (planTools(state.workflow).allowed.some((name) => ARTIFACT_TOOLS.includes(name))
          ? artifactGuidance(state.workflow.artifacts)
          : "") +
        (base
          ? `\n\nCurrent saved plan: ${JSON.stringify(base.path)}. plan_mode_edit and plan_mode_complete update this same file.`
          : "");
      event.systemPromptOptions.selectedTools = planTools(state.workflow).active;
      if (state.kind === "ready" && event.messageType !== "custom") {
        commit({
          kind: "planning",
          workflow: { ...state.workflow, document: state.document },
        });
        updateStatus(ctx);
      }
    } else {
      delete event.systemPromptOptions.sections.pi_plan_mode;
    }
  });

  // A queued continuation can start without another before_agent_start event.
  pi.on("agent_start", () => {
    pendingReview = undefined;
  });

  pi.on("agent_settled", (event, ctx) => {
    const request = pendingReview;
    if (!request || request.queued) return;
    if (event.aborted || !canAutoReview(ctx, request) || commandOpen) {
      pendingReview = undefined;
      return;
    }
    // Match command provenance to our registered helper, including suffixed invocations.
    const source = pi.getAllTools().find((tool) => tool.name === PLAN_MODE_COMPLETE_TOOL_NAME)?.sourceInfo;
    const command = pi
      .getCommands()
      .find(
        (candidate) =>
          /^plan(?::\d+)?$/.test(candidate.name) &&
          candidate.source === "extension" &&
          candidate.sourceInfo?.path === source?.path &&
          source?.path !== undefined,
      );
    if (!command) {
      pendingReview = undefined;
      notify(ctx, "Plan ready. Open /plan to review it (automatic command dispatch is unavailable).", "warning");
      return;
    }
    request.queued = true;
    try {
      pi.sendUserMessage(`/${command.name} __review ${request.token}`, {
        expandPromptTemplates: true,
      });
    } catch {
      pendingReview = undefined;
      notify(ctx, "Plan ready. Open /plan to review and choose implementation.", "warning");
    }
  });

  function canAutoReview(ctx: ExtensionContext, request: NonNullable<typeof pendingReview>) {
    return (
      request.current.isCurrent() &&
      session === ctx.sessionManager &&
      ctx.hasUI &&
      (ctx.mode === "tui" || ctx.mode === "rpc") &&
      ctx.isIdle() &&
      !ctx.hasPendingMessages() &&
      state.kind === "ready" &&
      state.document.path === request.path
    );
  }

  pi.on("tool_call", (event, ctx) => {
    const helper = PLAN_HELPER_NAMES.some((name) => name === event.toolName);
    if (session !== ctx.sessionManager) return;
    if (state.kind === "idle") {
      if (event.toolName === PLAN_MODE_EDIT_TOOL_NAME && implementation.active(ctx)) return;
      if (helper)
        return {
          block: true,
          reason: "Plan helpers require active /plan mode or tracked implementation for plan_mode_edit.",
        };
      return;
    }
    if (session !== ctx.sessionManager || !planTools(state.workflow).allowed.includes(event.toolName)) {
      return {
        block: true,
        reason: `Plan mode blocks '${event.toolName}'. The user can change trusted tools with /plan tools while idle. Each nested call needs its own permission.`,
      };
    }
    const scopeError = artifactScope(state.workflow.artifacts, event.toolName, event.input, ctx.cwd);
    if (scopeError) return { block: true, reason: scopeError };
    if (
      (event.toolName === PLAN_MODE_COMPLETE_TOOL_NAME || event.toolName === PLAN_MODE_EDIT_TOOL_NAME) &&
      (event.parentToolCallId !== undefined || !standaloneToolCall(ctx, event.toolName))
    )
      return {
        block: true,
        reason: "Planning saves must be called alone as a top-level tool, not nested or batched.",
      };
  });

  pi.registerTool({
    name: PLAN_MODE_QUESTION_TOOL_NAME,
    label: "Plan question",
    defaultActive: false,
    description:
      "Ask one to three structured questions while /plan mode is active. Not for ordinary planning outside /plan.",
    parameters: PLAN_MODE_QUESTION_PARAMS,
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      if (state.kind === "idle" || session !== ctx.sessionManager) {
        return planModeQuestionCancelled([], "plan_mode_inactive", "Plan mode is not active.");
      }
      const parsed = normalizePlanModeQuestionParams(params);
      if (!parsed.ok) return planModeQuestionCancelled([], "invalid_input", parsed.error);
      if (!ctx.hasUI)
        return planModeQuestionCancelled(parsed.questions, "ui_unavailable", "Interactive UI is unavailable.");
      const current = lifecycle(ctx);
      return answerPlanModeQuestions(parsed.questions, ctx, {
        isCurrent: current.isCurrent,
        isEnabled: () => state.kind !== "idle",
        signal: AbortSignal.any(
          [current.signal, signal, ctx.signal].filter((value): value is AbortSignal => value !== undefined),
        ),
      });
    },
  });

  function planningOperation(ctx: ExtensionContext, name: string, signal?: AbortSignal) {
    if (state.kind === "idle" || session !== ctx.sessionManager) throw new Error("Plan mode is not active.");
    if (!standaloneToolCall(ctx, name)) throw new Error("Planning saves must be called alone as a top-level tool.");
    const source = state;
    const current = lifecycle(ctx);
    const combined = AbortSignal.any(
      [current.signal, signal, ctx.signal].filter((value): value is AbortSignal => !!value),
    );
    return {
      source,
      signal: combined,
      isCurrent: () =>
        current.isCurrent() && state.kind !== "idle" && state.workflow.id === source.workflow.id && !combined.aborted,
    };
  }

  async function publishPlan(
    ctx: ExtensionContext,
    operation: ReturnType<typeof planningOperation>,
    store: PlanStore,
    plan: string,
    expectedHash?: string,
  ) {
    const { source, signal, isCurrent } = operation;
    if (!isCurrent()) throw new Error("Plan completion cancelled because the session changed.");
    let artifacts: PlanWorkflow["artifacts"];
    try {
      artifacts = await artifactReadiness(pi, ctx, collectArtifactReferences(ctx, source.workflow.artifacts));
    } catch (error) {
      if (error instanceof ArtifactNotReady && isCurrent())
        commit({ ...source, workflow: { ...source.workflow, artifacts: error.artifacts } });
      throw error;
    }
    if (!isCurrent()) throw new Error("Plan completion cancelled because the session changed.");
    const name = await resolveName();
    if (!isCurrent()) throw new Error("Plan completion cancelled.");
    const document = await store.save(plan, {
      artifacts,
      name,
      document: source.workflow.document,
      expectedHash: expectedHash ?? source.workflow.hash,
      signal,
      isCurrent,
    });
    if (!isCurrent())
      throw new Error(`Plan saved at ${document.path}, but the workflow changed before it could become ready.`);
    const workflow = {
      ...source.workflow,
      artifacts,
      storage: store.storage,
      name: document.name,
      document,
      hash: planHash(plan),
    };
    try {
      commit({ kind: "ready", workflow, document });
    } catch (error) {
      state = { kind: "planning", workflow };
      throw new Error(
        `Plan saved at ${document.path}, but ready state could not be persisted. Exit Plan mode, then reopen it through /plan saved. ${errorMessage(error)}`,
      );
    }
    invalidate();
    if (ctx.hasUI) {
      pendingReview = { token: randomUUID(), path: document.path, current: lifecycle(ctx), queued: false };
    }
    updateStatus(ctx);
    return document;
  }

  pi.registerTool({
    name: PLAN_MODE_COMPLETE_TOOL_NAME,
    label: "Complete plan",
    defaultActive: false,
    description:
      "Save the complete Markdown plan to its single mutable file while /plan mode is active. Call alone as the final action. Interactive review opens after completion; initial implementation requires explicit user approval.",
    parameters: PLAN_MODE_COMPLETE_PARAMS,
    executionMode: "sequential",
    renderResult: renderPlanModeCompletion,
    async execute(_id, params, signal, _update, ctx) {
      const operation = planningOperation(ctx, PLAN_MODE_COMPLETE_TOOL_NAME, signal);
      const parsed = normalizePlanModeCompletion(params);
      if (!parsed.ok) throw new Error(parsed.error);
      const store = await storeFor(ctx, operation.source.workflow);
      const document = await publishPlan(ctx, operation, store, parsed.plan);
      return planModeCompleted(parsed.plan, document.path);
    },
  });

  const implementation = registerImplementation(
    pi,
    dependencies,
    (ctx) => state.kind !== "idle" && session === ctx.sessionManager,
    updateStatus,
  );

  pi.registerTool({
    name: PLAN_MODE_EDIT_TOOL_NAME,
    label: "Edit plan",
    defaultActive: false,
    description:
      "Apply targeted edits atomically to the current plan at the same path. In /plan mode call alone as the final action; implementation edits need no approval dialog. Use plan_mode_complete for the initial plan.",
    parameters: PLAN_MODE_EDIT_PARAMS,
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      if (state.kind === "idle") return implementation.edit(ctx, params, signal);
      const operation = planningOperation(ctx, PLAN_MODE_EDIT_TOOL_NAME, signal);
      const { source } = operation;
      const document = source.workflow.document;
      if (!document) throw new Error("No saved plan is active. Use plan_mode_complete for the initial plan.");
      const store = await storeFor(ctx, source.workflow);
      if (!operation.isCurrent()) throw new Error("Plan edit cancelled because the session changed.");
      const plan = await store.read(document);
      if (source.workflow.hash && planHash(plan) !== source.workflow.hash)
        throw new Error("Plan changed on disk. Use /plan to review current contents or /plan open to edit them.");
      const edited = await applyPlanEdits(ctx, params, document, plan, operation.signal);
      const saved = await publishPlan(ctx, operation, store, edited.plan, planHash(plan));
      return planModeEdited(saved, edited, true);
    },
  });

  async function review(ctx: ExtensionCommandContext, document?: PlanDocument, store?: PlanStore) {
    if (!ctx.hasUI) throw new Error("Plan review and implementation require TUI or RPC mode.");
    let source: PlanState = state;
    const selected = document ?? (source.kind === "idle" ? undefined : source.workflow.document);
    if (!selected)
      throw new Error("No current saved plan. Create one with /plan <request> or choose one through /plan saved.");
    let current = lifecycle(ctx);
    const storage = store ?? (await storeFor(ctx, source.kind !== "idle" ? source.workflow : undefined));
    const plan = await storage.read(selected);
    await artifactReadiness(pi, ctx, selected.artifacts);
    if (!current.isCurrent()) return;
    if (state.kind === "idle") {
      const entered = await enter(ctx, { document: selected, hash: planHash(plan), storage: storage.storage });
      if (!entered?.isCurrent()) return;
      current = entered;
      const planning = state as PlanState;
      if (planning.kind === "idle") return;
      commit({ kind: "ready", workflow: planning.workflow, document: selected });
      source = state;
      updateStatus(ctx);
    }
    const ui = await loadUi();
    if (!current.isCurrent()) return;
    if (state.kind !== "idle" && state.workflow.document?.id === selected.id)
      commit({ ...state, workflow: { ...state.workflow, hash: planHash(plan) } });
    const action = await ui.reviewPlan(ctx, plan, selected, current);
    if (!action || !current.isCurrent()) return;
    idle(ctx);
    // Never authorize contents changed while the review was open.
    if (planHash(await storage.read(selected)) !== planHash(plan))
      throw new Error("Plan changed during review. Reopen review before continuing.");
    if (!current.isCurrent()) return;
    if (action === "save") {
      await leave(ctx);
      notify(ctx, `Saved for later: ${selected.path}`);
    } else if (action === "continue") {
      let continued: ReturnType<typeof lifecycle> | undefined;
      if (state.kind === "idle")
        continued = await enter(ctx, {
          document: selected,
          hash: planHash(plan),
          storage: storage.storage,
        });
      else {
        transition(
          {
            kind: "planning",
            workflow: {
              ...state.workflow,
              storage: storage.storage,
              artifacts: selected.artifacts ?? state.workflow.artifacts,
              document: selected,
              name: selected.name,
              hash: planHash(plan),
            },
          },
          ctx,
        );
        continued = lifecycle(ctx);
      }
      if (!continued?.isCurrent()) return;
      pi.sendUserMessage(
        `Continue planning from this saved plan. Do not implement it; ask what should change if unspecified.\n\n${plan}`,
      );
    } else if (action === "fresh") {
      const configuration = source.kind !== "idle" ? source.workflow : await readSettings();
      if (!current.isCurrent()) return;
      const tracked = implementation.prepare(
        ctx,
        selected,
        plan,
        storage,
        configuration.tools,
        source.kind !== "idle" ? source.workflow.previousTools : pi.getActiveTools(),
      );
      const before = state;
      const previousImplementation = implementation.state;
      const manager = ctx.sessionManager;
      await leave(ctx);
      if (session !== manager || state.kind !== "idle") return;
      // Persist the end of ownership before replacement; never write through a disposed source context.
      const handoff = lifecycle(ctx);
      try {
        implementation.detach(ctx);
        const result = await startFreshImplementation(ctx, plan, tracked);
        if (result.cancelled && handoff.isCurrent()) {
          implementation.rollback(previousImplementation, ctx);
          if (before.kind !== "idle") transition(before, ctx);
          notify(ctx, "Fresh implementation cancelled. The saved plan is unchanged.");
        }
      } catch (error) {
        if (handoff.isCurrent()) {
          implementation.rollback(previousImplementation, ctx);
          if (before.kind !== "idle") transition(before, ctx);
        }
        throw error;
      }
    } else {
      const configuration = source.kind !== "idle" ? source.workflow : await readSettings();
      if (!current.isCurrent()) return;
      const tracked = implementation.prepare(
        ctx,
        selected,
        plan,
        storage,
        configuration.tools,
        source.kind !== "idle" ? source.workflow.previousTools : pi.getActiveTools(),
      );
      const before = state;
      const previousImplementation = implementation.state;
      const manager = ctx.sessionManager;
      await leave(ctx);
      if (session !== manager || state.kind !== "idle") return;
      try {
        implementation.begin(tracked, ctx);
        pi.sendUserMessage(implementationPrompt(plan, selected));
      } catch (error) {
        if (session === ctx.sessionManager) implementation.rollback(previousImplementation, ctx);
        if (session === ctx.sessionManager && before.kind !== "idle") transition(before, ctx);
        throw error;
      }
    }
  }

  async function browse(ctx: ExtensionCommandContext) {
    const current = lifecycle(ctx);
    const store = await storeFor(ctx);
    const settings = await readSettings();
    const stores = [store];
    for (const directory of new Set(["plans", ...(settings.plansDirectory ? [settings.plansDirectory] : [])])) {
      try {
        stores.push(
          await makeStore(ctx.cwd, directory, undefined, {
            existingOnly: true,
          }),
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (!current.isCurrent()) return;
    }
    const listings = await Promise.all(
      stores.map(async (storage) => ({
        storage,
        documents: await storage.list(),
      })),
    );
    const documents = listings.flatMap((listing) => listing.documents);
    const ui = await loadUi();
    if (!current.isCurrent()) return;
    const selected = await ui.selectSavedPlan(ctx, documents, current);
    const selectedStore = listings.find((listing) =>
      listing.documents.some((document) => document.path === selected?.path),
    )?.storage;
    if (selected && selectedStore && current.isCurrent()) await review(ctx, selected, selectedStore);
  }

  async function tools(ctx: ExtensionContext, persistent = false) {
    const current = lifecycle(ctx);
    const settings = await readSettings();
    const all = pi.getAllTools();
    const selected =
      (!persistent
        ? state.kind !== "idle"
          ? state.workflow.tools
          : (implementation.state?.tools ?? settings.tools)
        : settings.tools) ?? defaultPlanTools(all);
    const ui = await loadUi();
    if (!current.isCurrent()) return;
    const chosen = await ui.selectPlanTools(ctx, all, selected, current);
    if (!chosen || !current.isCurrent()) return;
    idle(ctx);
    if (persistent) {
      await updatePlanModeSettings({ tools: chosen }, { signal: current.signal });
      if (current.isCurrent()) notify(ctx, "Tool defaults saved for future planning workflows.");
    } else if (state.kind !== "idle") {
      transition({ ...state, workflow: { ...state.workflow, tools: chosen } }, ctx);
    } else {
      await updatePlanModeSettings({ tools: chosen }, { signal: current.signal });
      if (!current.isCurrent()) return;
      if (implementation.state) implementation.setTools(chosen, ctx);
      notify(ctx, "Tool defaults saved for future planning workflows. Parent-agent tools are unchanged.");
    }
  }

  async function editPlanningPrompt(ctx: ExtensionContext) {
    const current = lifecycle(ctx);
    const path = planModePromptPath();
    const original = openPlanModePrompt(path);
    const text = await ctx.ui.editor(`Planning prompt: ${terminalText(path)}`, original);
    if (!current.isCurrent() || text === undefined) return;
    idle(ctx);
    savePlanModePrompt(text, original, path);
    notify(ctx, "Planning prompt saved for new workflows. Existing workflows retain their prompt snapshot.");
  }

  async function settingsMenu(ctx: ExtensionContext) {
    const current = lifecycle(ctx);
    const choice = await ctx.ui.select(
      "Plan settings",
      [
        "Default planning tools",
        "Edit planning prompt",
        "Reset to strict inspection tools",
        "Automatic adherence checks",
        "Adherence checker model",
        "Progress model",
        "Progress reasoning",
        "Naming model",
      ],
      { signal: current.signal },
    );
    if (!choice || !current.isCurrent()) return;
    idle(ctx);
    if (choice === "Default planning tools") return tools(ctx, true);
    if (choice === "Edit planning prompt") return editPlanningPrompt(ctx);
    if (
      [
        "Automatic adherence checks",
        "Adherence checker model",
        "Progress model",
        "Progress reasoning",
        "Naming model",
      ].includes(choice)
    )
      return implementation.settings(ctx, choice, current.signal);
    if (choice === "Reset to strict inspection tools") {
      await updatePlanModeSettings({ tools: null }, { signal: current.signal });
    }
    if (current.isCurrent()) notify(ctx, "Settings saved for future workflows. Existing plan files were not moved.");
  }

  pi.registerCommand("plan", {
    description: "Plan, review saved plans, or choose implementation here or in a fresh session",
    getArgumentCompletions: (prefix) =>
      ["start", "saved", "implement", "open", "tools", "settings", "exit", "verify", "resume", "progress"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const removed = /^(finalize|save|prompt|cancel|import(?:\s+.*)?)$/i.exec(args.trim());
      if (removed) {
        const command = removed[0].toLowerCase().split(/\s/)[0];
        const guidance = {
          finalize: "Use /plan implement to review the saved plan, or continue planning in conversation.",
          save: "Plans are already saved. Use /plan exit or Save for later in review.",
          prompt: "Use /plan settings → Edit planning prompt.",
          import: "Use /plan start and paste the Markdown body text into the planning conversation.",
          cancel: "Cancel a manual check through its existing dialog; automatic checks use tool-run cancellation.",
        };
        const message = `/plan ${command} was removed. ${guidance[command as keyof typeof guidance]}`;
        if (!ctx.hasUI) throw new Error(message);
        notify(ctx, message, "warning");
        return;
      }
      // Observation is allowed during streaming/queued input and never owns the command gate.
      if (args.trim().toLowerCase() === "progress") {
        try {
          implementation.progress(ctx);
        } catch (error) {
          if (!ctx.hasUI) throw error;
          ctx.ui.notify(terminalText(errorMessage(error)), "error");
        }
        return;
      }
      const internal = /^__review(?:\s|$)/i.test(args.trim());
      if (internal) {
        const request = pendingReview;
        if (!request || args.trim() !== `__review ${request.token}`) return;
        pendingReview = undefined;
        if (!request.queued || commandOpen || !canAutoReview(ctx, request)) return;
      } else {
        // Manual commands supersede any not-yet-presented automatic review.
        pendingReview = undefined;
      }
      if (commandOpen) {
        notify(ctx, "A Plan command is already open.", "warning");
        return;
      }
      const commandSession = ctx.sessionManager;
      if (!session) session = commandSession;
      if (session !== commandSession) return;
      commandOpen = true;
      try {
        idle(ctx);
        const input = args.trim();
        const command = input.toLowerCase();
        if (internal) {
          await review(ctx);
          return;
        }
        if (command === "implement") {
          if (state.kind !== "idle") {
            await review(ctx);
          } else {
            const tracked = implementation.state;
            if (!tracked)
              throw new Error(
                "No current saved plan. Create one with /plan <request> or choose one through /plan saved.",
              );
            const current = lifecycle(ctx);
            const store = await makeStore(ctx.cwd, storedPlanStorage(tracked));
            if (!current.isCurrent()) return;
            if (store.projectRoot !== tracked.projectRoot)
              throw new Error("This implementation belongs to a different project.");
            await review(ctx, tracked.document, store);
          }
          return;
        }
        if (command === "open") {
          if (state.kind === "idle") {
            await implementation.command(command, ctx);
            return;
          }
          const source = state;
          const document = source.workflow.document;
          if (!document) throw new Error("No saved plan yet. Complete the initial plan before opening it.");
          const current = lifecycle(ctx);
          const store = await storeFor(ctx, source.workflow);
          if (!current.isCurrent()) return;
          const edited = await editPlanDocument(ctx, store, document, current);
          if (edited && current.isCurrent()) {
            commit({
              ...source,
              workflow: { ...state.workflow, ...edited },
              ...(source.kind === "ready" ? { document: edited.document } : {}),
            });
            invalidate();
            updateStatus(ctx);
          }
          return;
        }
        if (["verify", "resume"].includes(command)) {
          if (state.kind !== "idle") throw new Error("Exit planning before verifying or resuming implementation.");
          await implementation.command(command, ctx);
          return;
        }
        if (command.startsWith("artifacts omit ")) {
          if (state.kind === "idle" || !state.workflow.artifacts) throw new Error("No active artifact workflow.");
          const jobId = input.slice("artifacts omit ".length).trim();
          const reference = state.workflow.artifacts.references.find((r) => r.jobId === jobId);
          if (!reference) throw new Error("Job is not associated with this plan.");
          const current = lifecycle(ctx);
          const [status] = await artifactRequest(pi, ctx, "status", [jobId]);
          if (!current.isCurrent()) return;
          if (!status || ["queued", "running", "succeeded"].includes(status.status))
            throw new Error("Only failed/cancelled/interrupted artifacts may be omitted.");
          commit({
            ...state,
            workflow: {
              ...state.workflow,
              artifacts: {
                ...state.workflow.artifacts,
                omittedJobIds: [...new Set([...(state.workflow.artifacts.omittedJobIds ?? []), jobId])],
              },
            },
          });
          notify(ctx, "Omission recorded by user request. Partial files remain live, not a successful prototype.");
          return;
        }
        if (command === "exit") {
          await leave(ctx);
          implementation.detach(ctx);
          return;
        }
        if (command === "start") {
          await enter(ctx);
          return;
        }
        if (["tools", "settings", "saved", ""].includes(command)) {
          if (!ctx.hasUI)
            throw new Error("This Plan menu requires TUI or RPC mode. Use /plan start or /plan <request>.");
          if (command === "tools") {
            await tools(ctx);
            return;
          }
          if (command === "settings") {
            await settingsMenu(ctx);
            return;
          }
          if (command === "saved") {
            if (state.kind !== "idle") throw new Error("Exit the current workflow before browsing saved plans.");
            await browse(ctx);
            return;
          }
          if (state.kind !== "idle" && state.workflow.document) {
            await review(ctx);
            return;
          }
          const current = lifecycle(ctx);
          const choice = await ctx.ui.select(
            "Plan mode",
            state.kind === "idle"
              ? [
                  "Start planning",
                  "Saved plans",
                  ...(implementation.active(ctx) ? ["Show plan progress"] : []),
                  ...(implementation.state ? ["Verify implementation", "Resume implementation"] : []),
                  "Tools",
                  "Settings",
                ]
              : ["Tools", "Save defaults", "Exit planning"],
            { signal: current.signal },
          );
          if (!current.isCurrent() || !choice) return;
          if (choice === "Show plan progress") {
            implementation.progress(ctx);
            return;
          }
          idle(ctx);
          if (choice === "Start planning") await enter(ctx);
          else if (choice === "Saved plans") await browse(ctx);
          else if (choice === "Verify implementation") await implementation.command("verify", ctx);
          else if (choice === "Resume implementation") await implementation.command("resume", ctx);
          else if (choice === "Tools") await tools(ctx);
          else if (choice === "Settings" || choice === "Save defaults") await settingsMenu(ctx);
          else await leave(ctx);
          return;
        }
        const previous = state;
        const previousImplementation = implementation.state;
        const entered = await enter(ctx);
        if (!entered?.isCurrent()) return;
        try {
          startNaming(ctx, input);
          pi.sendUserMessage(input);
        } catch (error) {
          if (previous.kind === "idle") {
            transition(previous, ctx);
            if (previousImplementation?.phase === "implementing") implementation.rollback(previousImplementation, ctx);
          }
          throw error;
        }
      } catch (error) {
        if (session !== commandSession) return;
        if (!ctx.hasUI) throw error;
        notify(
          ctx,
          internal ? `Automatic plan review failed: ${errorMessage(error)}. Open /plan to retry.` : errorMessage(error),
          "error",
        );
      } finally {
        commandOpen = false;
      }
    },
  });

  // Pi awaits the factory before collecting shortcuts. Never register in session_start,
  // and never fail the whole extension just because its shortcut configuration is invalid.
  try {
    const settings = await readSettings();
    const shortcut =
      settings.shortcuts?.togglePlan === undefined ? DEFAULT_TOGGLE_SHORTCUT : settings.shortcuts.togglePlan;
    if (shortcut !== null) {
      pi.registerShortcut(shortcut, {
        description: "Toggle between planning and normal mode",
        handler: async (ctx) => {
          if (ctx.mode !== "tui" || session !== ctx.sessionManager) return;
          if (commandOpen) {
            notify(ctx, "A Plan command is already open.", "warning");
            return;
          }
          const current = lifecycle(ctx);
          commandOpen = true;
          try {
            idle(ctx);
            if (state.kind === "idle") await enter(ctx);
            else await leave(ctx);
          } catch (error) {
            if (current.isCurrent()) notify(ctx, errorMessage(error), "error");
          } finally {
            commandOpen = false;
          }
        },
      });
    }
  } catch (error) {
    shortcutStartupError = `Plan mode shortcut unavailable: ${errorMessage(error)}. Correct settings and /reload.`;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
