import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText as terminalText } from "@narumitw/pi-tui-kit/terminal-text";
import {
  normalizePlanModeCompletion,
  PLAN_MODE_COMPLETE_PARAMS,
  PLAN_MODE_COMPLETE_TOOL_NAME,
  planModeCompleted,
  renderPlanModeCompletion,
} from "./completion-tool.js";
import { implementationPrompt, startFreshImplementation } from "./fresh-implementation.js";
import { type ImplementationDependencies, registerImplementation } from "./implementation.js";
import {
  createPlanStore,
  type PlanRevision,
  type PlanStorage,
  type PlanStore,
  storedPlanStorage,
} from "./plan-store.js";
import { readPlanModeInstructions } from "./planning-instructions.js";
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
import { PLAN_STATE_ENTRY, type PlanState, type PlanWorkflow, restorePlanState } from "./state.js";
import { defaultPlanTools, PLAN_HELPER_NAMES, resolvePlanTools } from "./tool-policy.js";

type InteractiveUi = typeof import("./interactive-ui.js");
interface PlanModeDependencies extends ImplementationDependencies {
  readSettings?(): Promise<PlanModeSettings>;
  readInstructions?(): string;
  createStore?: typeof createPlanStore;
  loadUi?(): Promise<InteractiveUi>;
}

const FINALIZE_REQUEST =
  "Finish the planning discussion: ask a material remaining question with plan_mode_question, or submit the complete plan with plan_mode_complete alone.";

export default async function planMode(pi: ExtensionAPI, dependencies: PlanModeDependencies = {}) {
  let state: PlanState = { kind: "idle" };
  let session: ExtensionContext["sessionManager"] | undefined;
  let generation = 0;
  let interaction = new AbortController();
  // Commands and keyboard toggles share this gate across asynchronous transitions.
  let commandOpen = false;
  let shortcutStartupError: string | undefined;
  let pendingReview:
    | { token: string; path: string; current: ReturnType<typeof lifecycle>; queued: boolean }
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
    ctx.ui.setStatus(
      "plan-mode",
      state.kind === "idle" ? undefined : `plan ${state.kind === "ready" ? "ready · /plan" : "active"}`,
    );
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
      throw new Error("The Plan question and completion helpers must be registered and available.");
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
    invalidate();
    updateStatus(ctx);
  }

  async function storeFor(ctx: ExtensionContext, workflow?: PlanWorkflow): Promise<PlanStore> {
    // A restored unfinished draft without a series starts in the new layout too.
    const location = workflow?.series ? storedPlanStorage(workflow) : { kind: "repo" as const };
    const store = await makeStore(ctx.cwd, location);
    if (workflow && store.projectRoot !== workflow.projectRoot)
      throw new Error("This Plan workflow belongs to a different project.");
    return store;
  }

  async function enter(
    ctx: ExtensionContext,
    options: { tools?: string[]; series?: string; parent?: PlanRevision; storage?: PlanStorage } = {},
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
    const previousImplementation = implementation.state;
    let workflow: PlanWorkflow;
    try {
      if (previousImplementation?.phase === "implementing") implementation.detach(ctx);
      workflow = {
        projectRoot: store.projectRoot,
        storage: store.storage,
        instructions,
        previousTools: pi.getActiveTools(),
        ...((options.tools ?? settings.tools) ? { tools: options.tools ?? settings.tools } : {}),
        ...(options.series ? { series: options.series } : {}),
        ...(options.parent ? { parent: options.parent } : {}),
      };
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

  function leave(ctx: ExtensionContext) {
    idle(ctx);
    if (state.kind !== "idle") transition({ kind: "idle" }, ctx);
  }

  async function restore(ctx: ExtensionContext) {
    const previous = state;
    invalidate();
    // Tree navigation does not replace the extension instance. Release its previous loadout first.
    if (session === ctx.sessionManager && previous.kind !== "idle") pi.setActiveTools(previous.workflow.previousTools);
    session = ctx.sessionManager;
    state = restorePlanState(ctx.sessionManager.getBranch());
    const current = lifecycle(ctx);
    try {
      if (state.kind !== "idle") {
        const candidate = state;
        await storeFor(ctx, candidate.workflow);
        if (!current.isCurrent()) return;
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
    invalidate();
    try {
      if (state.kind !== "idle") pi.setActiveTools(state.workflow.previousTools);
    } finally {
      if (ctx.hasUI) ctx.ui.setStatus("plan-mode", undefined);
      session = undefined;
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    invalidate();
    if (state.kind !== "idle" && session === ctx.sessionManager) {
      // Set guidance even if persisting the ready-to-planning transition subsequently fails.
      // Native sections survive compaction and use Pi's ordinary prompt/tool deltas.
      event.systemPromptOptions.sections.pi_plan_mode = buildPlanModePrompt(state.workflow.instructions);
      event.systemPromptOptions.selectedTools = planTools(state.workflow).active;
      if (state.kind === "ready" && event.messageType !== "custom") {
        commit({ kind: "planning", workflow: { ...state.workflow, parent: state.revision } });
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
      pi.sendUserMessage(`/${command.name} __review ${request.token}`, { expandPromptTemplates: true });
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
      state.revision.path === request.path
    );
  }

  pi.on("tool_call", (event, ctx) => {
    const helper = PLAN_HELPER_NAMES.some((name) => name === event.toolName);
    if (state.kind === "idle") {
      if (helper) return { block: true, reason: "Plan helpers require active /plan mode." };
      return;
    }
    if (session !== ctx.sessionManager || !planTools(state.workflow).allowed.includes(event.toolName)) {
      return {
        block: true,
        reason: `Plan mode blocks '${event.toolName}'. The user can change trusted tools with /plan tools while idle. Each nested call needs its own permission.`,
      };
    }
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

  pi.registerTool({
    name: PLAN_MODE_COMPLETE_TOOL_NAME,
    label: "Complete plan",
    defaultActive: false,
    description:
      "Save a complete Markdown plan as a numbered revision while /plan mode is active. Call alone as the final action. Interactive review opens after completion; implementation requires explicit user approval.",
    parameters: PLAN_MODE_COMPLETE_PARAMS,
    executionMode: "sequential",
    renderResult: renderPlanModeCompletion,
    async execute(_id, params, signal, _update, ctx) {
      if (state.kind === "idle" || session !== ctx.sessionManager) throw new Error("Plan mode is not active.");
      const parsed = normalizePlanModeCompletion(params);
      if (!parsed.ok) throw new Error(parsed.error);
      const source = state;
      const current = lifecycle(ctx);
      const store = await storeFor(ctx, source.workflow);
      if (!current.isCurrent()) throw new Error("Plan completion cancelled because the session changed.");
      const revision = await store.save(parsed.plan, {
        series: source.workflow.series,
        parent: source.kind === "ready" ? source.revision : source.workflow.parent,
        reason: parsed.reason,
        signal,
        isCurrent: current.isCurrent,
      });
      if (!current.isCurrent())
        throw new Error(`Plan saved at ${revision.path}, but the workflow changed before it could become ready.`);
      try {
        commit({
          kind: "ready",
          workflow: { ...source.workflow, storage: store.storage, series: revision.series, parent: revision },
          revision,
        });
      } catch (error) {
        // Retain the published series for a retry, without claiming that readiness was persisted.
        state = { ...source, workflow: { ...source.workflow, storage: store.storage, series: revision.series } };
        throw new Error(
          `Plan saved at ${revision.path}, but ready state could not be persisted. Exit Plan mode, then reopen it through /plan saved. ${errorMessage(error)}`,
        );
      }
      invalidate();
      if (ctx.hasUI && !signal?.aborted) {
        pendingReview = { token: randomUUID(), path: revision.path, current: lifecycle(ctx), queued: false };
      }
      updateStatus(ctx);
      return planModeCompleted(parsed.plan, revision.path);
    },
  });

  const implementation = registerImplementation(pi, dependencies);

  async function review(ctx: ExtensionCommandContext, revision?: PlanRevision, store?: PlanStore) {
    if (!ctx.hasUI) throw new Error("Plan review and implementation require TUI or RPC mode.");
    const source = state;
    const selected = revision ?? (source.kind === "ready" ? source.revision : undefined);
    if (!selected) throw new Error("No completed plan is ready. Use /plan saved to browse saved plans.");
    const current = lifecycle(ctx);
    const storage = store ?? (await storeFor(ctx, source.kind !== "idle" ? source.workflow : undefined));
    const plan = await storage.read(selected);
    const ui = await loadUi();
    if (!current.isCurrent()) return;
    const action = await ui.reviewPlan(ctx, plan, selected, current);
    if (!action || !current.isCurrent()) return;
    idle(ctx);
    // Act on exactly the reviewed bytes, not a later file read.
    if (action === "save") {
      leave(ctx);
      notify(ctx, `Saved for later: ${selected.path}`);
    } else if (action === "continue") {
      let continued: ReturnType<typeof lifecycle> | undefined;
      if (state.kind === "idle")
        continued = await enter(ctx, { series: selected.series, parent: selected, storage: storage.storage });
      else {
        transition(
          {
            kind: "planning",
            workflow: { ...state.workflow, storage: storage.storage, series: selected.series, parent: selected },
          },
          ctx,
        );
        continued = lifecycle(ctx);
      }
      if (!continued?.isCurrent()) return;
      pi.sendUserMessage(
        `Continue planning from this saved revision. Do not implement it; ask what should change if the user has not specified revisions.\n\n${plan}`,
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
      leave(ctx);
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
      leave(ctx);
      try {
        implementation.begin(tracked, ctx);
        pi.sendUserMessage(implementationPrompt(plan));
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
        stores.push(await makeStore(ctx.cwd, directory, undefined, { existingOnly: true }));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (!current.isCurrent()) return;
    }
    const listings = await Promise.all(stores.map(async (storage) => ({ storage, revisions: await storage.list() })));
    const revisions = listings.flatMap((listing) => listing.revisions);
    const ui = await loadUi();
    if (!current.isCurrent()) return;
    const selected = await ui.selectSavedPlan(ctx, revisions, current);
    const selectedStore = listings.find((listing) =>
      listing.revisions.some((revision) => revision.path === selected?.path),
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
    } else if (implementation.state) {
      implementation.setTools(chosen, ctx);
    } else {
      await enter(ctx, { tools: chosen });
    }
  }

  async function settingsMenu(ctx: ExtensionContext) {
    const current = lifecycle(ctx);
    const choice = await ctx.ui.select(
      "Plan settings",
      [
        "Default planning tools",
        "Reset to strict inspection tools",
        "Automatic adherence checks",
        "Adherence checker model",
      ],
      { signal: current.signal },
    );
    if (!choice || !current.isCurrent()) return;
    idle(ctx);
    if (choice === "Default planning tools") return tools(ctx, true);
    if (choice === "Automatic adherence checks" || choice === "Adherence checker model")
      return implementation.settings(ctx, choice, current.signal);
    if (choice === "Reset to strict inspection tools") {
      await updatePlanModeSettings({ tools: null }, { signal: current.signal });
    }
    if (current.isCurrent()) notify(ctx, "Settings saved for future workflows. Existing plan files were not moved.");
  }

  pi.registerCommand("plan", {
    description: "Plan, review numbered revisions, or implement in a fresh session",
    getArgumentCompletions: (prefix) =>
      ["start", "saved", "tools", "settings", "finalize", "save", "exit", "verify", "resume", "cancel"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
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
      if (args.trim().toLowerCase() === "cancel") {
        implementation.cancel();
        return;
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
        if (["verify", "resume"].includes(command)) {
          if (state.kind !== "idle") throw new Error("Exit planning before verifying or resuming implementation.");
          await implementation.command(command, ctx);
          return;
        }
        if (command === "exit") {
          leave(ctx);
          implementation.detach(ctx);
          return;
        }
        if (command === "save") {
          if (state.kind !== "ready") throw new Error("Complete a plan before saving it for later.");
          const path = state.revision.path;
          leave(ctx);
          notify(ctx, `Saved for later: ${path}`);
          return;
        }
        if (command === "finalize") {
          if (state.kind === "idle") throw new Error("Start Plan mode before requesting finalization.");
          pi.sendUserMessage(FINALIZE_REQUEST);
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
          if (state.kind === "ready") {
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
                  ...(implementation.state ? ["Verify implementation", "Resume implementation"] : []),
                  "Tools",
                  "Settings",
                ]
              : ["Finalize plan", "Tools", "Save defaults", "Exit planning"],
            { signal: current.signal },
          );
          if (!current.isCurrent() || !choice) return;
          idle(ctx);
          if (choice === "Start planning") await enter(ctx);
          else if (choice === "Saved plans") await browse(ctx);
          else if (choice === "Verify implementation") await implementation.command("verify", ctx);
          else if (choice === "Resume implementation") await implementation.command("resume", ctx);
          else if (choice === "Tools") await tools(ctx);
          else if (choice === "Settings" || choice === "Save defaults") await settingsMenu(ctx);
          else if (choice === "Finalize plan") pi.sendUserMessage(FINALIZE_REQUEST);
          else leave(ctx);
          return;
        }
        const previous = state;
        const previousImplementation = implementation.state;
        const entered = await enter(ctx);
        if (!entered?.isCurrent()) return;
        try {
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
            else leave(ctx);
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
