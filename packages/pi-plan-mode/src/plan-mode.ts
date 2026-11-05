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
import { createPlanStore, type PlanRevision, type PlanStore } from "./plan-store.js";
import { readPlanModeInstructions } from "./planning-instructions.js";
import { buildPlanModePrompt } from "./prompt.js";
import {
  answerPlanModeQuestions,
  normalizePlanModeQuestionParams,
  PLAN_MODE_QUESTION_PARAMS,
  PLAN_MODE_QUESTION_TOOL_NAME,
  planModeQuestionCancelled,
} from "./question-tool.js";
import { type PlanModeSettings, readPlanModeSettings, updatePlanModeSettings } from "./settings.js";
import { PLAN_STATE_ENTRY, type PlanState, type PlanWorkflow, restorePlanState } from "./state.js";
import { defaultPlanTools, PLAN_HELPER_NAMES, resolvePlanTools } from "./tool-policy.js";

type InteractiveUi = typeof import("./interactive-ui.js");
interface PlanModeDependencies {
  readSettings?(): Promise<PlanModeSettings>;
  readInstructions?(): string;
  createStore?: typeof createPlanStore;
  loadUi?(): Promise<InteractiveUi>;
}

const FINALIZE_REQUEST =
  "Finish the planning discussion: ask a material remaining question with plan_mode_question, or submit the complete plan with plan_mode_complete alone.";

export default function planMode(pi: ExtensionAPI, dependencies: PlanModeDependencies = {}) {
  let state: PlanState = { kind: "idle" };
  let session: ExtensionContext["sessionManager"] | undefined;
  let generation = 0;
  let interaction = new AbortController();
  let commandOpen = false;
  const readSettings = dependencies.readSettings ?? readPlanModeSettings;
  const makeStore = dependencies.createStore ?? createPlanStore;
  const loadUi = dependencies.loadUi ?? (() => import("./interactive-ui.js"));

  function invalidate() {
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
    const directory = workflow?.plansDirectory ?? (await readSettings()).plansDirectory;
    const store = await makeStore(ctx.cwd, directory);
    if (workflow && store.projectRoot !== workflow.projectRoot)
      throw new Error("This Plan workflow belongs to a different project.");
    return store;
  }

  async function enter(ctx: ExtensionContext, options: { tools?: string[]; series?: string } = {}) {
    idle(ctx);
    if (state.kind !== "idle") return lifecycle(ctx);
    const current = lifecycle(ctx);
    const settings = await readSettings();
    const store = await makeStore(ctx.cwd, settings.plansDirectory);
    if (!current.isCurrent()) return;
    idle(ctx);
    const workflow: PlanWorkflow = {
      projectRoot: store.projectRoot,
      plansDirectory: settings.plansDirectory,
      instructions: (dependencies.readInstructions ?? readPlanModeInstructions)(),
      previousTools: pi.getActiveTools(),
      ...((options.tools ?? settings.tools) ? { tools: options.tools ?? settings.tools } : {}),
      ...(options.series ? { series: options.series } : {}),
    };
    transition({ kind: "planning", workflow }, ctx);
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

  pi.on("session_start", (_event, ctx) => restore(ctx));
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
        commit({ kind: "planning", workflow: state.workflow });
        updateStatus(ctx);
      }
    } else {
      delete event.systemPromptOptions.sections.pi_plan_mode;
    }
  });

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
      "Save a complete Markdown plan as a numbered revision while /plan mode is active. Call alone as the final action; saving does not start implementation.",
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
        signal,
        isCurrent: current.isCurrent,
      });
      if (!current.isCurrent())
        throw new Error(`Plan saved at ${revision.path}, but the workflow changed before it could become ready.`);
      try {
        commit({ kind: "ready", workflow: { ...source.workflow, series: revision.series }, revision });
      } catch (error) {
        // Retain the published series for a retry, without claiming that readiness was persisted.
        state = { ...source, workflow: { ...source.workflow, series: revision.series } };
        throw new Error(
          `Plan saved at ${revision.path}, but ready state could not be persisted. Exit Plan mode, then reopen it through /plan saved. ${errorMessage(error)}`,
        );
      }
      invalidate();
      updateStatus(ctx);
      return planModeCompleted(parsed.plan, revision.path);
    },
  });

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
      if (state.kind === "idle") continued = await enter(ctx, { series: selected.series });
      else {
        transition({ kind: "planning", workflow: { ...state.workflow, series: selected.series } }, ctx);
        continued = lifecycle(ctx);
      }
      if (!continued?.isCurrent()) return;
      pi.sendUserMessage(
        `Continue planning from this saved revision. Do not implement it; ask what should change if the user has not specified revisions.\n\n${plan}`,
      );
    } else if (action === "fresh") {
      const before = state;
      leave(ctx);
      // Persist the end of ownership before replacement; never write through a disposed source context.
      const handoff = lifecycle(ctx);
      try {
        const result = await startFreshImplementation(ctx, plan);
        if (result.cancelled && handoff.isCurrent()) {
          if (before.kind !== "idle") transition(before, ctx);
          notify(ctx, "Fresh implementation cancelled. The saved plan is unchanged.");
        }
      } catch (error) {
        if (handoff.isCurrent() && before.kind !== "idle") transition(before, ctx);
        throw error;
      }
    } else {
      const before = state;
      leave(ctx);
      try {
        pi.sendUserMessage(implementationPrompt(plan));
      } catch (error) {
        if (session === ctx.sessionManager && before.kind !== "idle") transition(before, ctx);
        throw error;
      }
    }
  }

  async function browse(ctx: ExtensionCommandContext) {
    const current = lifecycle(ctx);
    const store = await storeFor(ctx);
    const revisions = await store.list();
    const ui = await loadUi();
    if (!current.isCurrent()) return;
    const selected = await ui.selectSavedPlan(ctx, revisions, current);
    if (selected && current.isCurrent()) await review(ctx, selected, store);
  }

  async function tools(ctx: ExtensionContext, persistent = false) {
    const current = lifecycle(ctx);
    const settings = await readSettings();
    const all = pi.getAllTools();
    const selected =
      (!persistent && state.kind !== "idle" ? state.workflow.tools : settings.tools) ?? defaultPlanTools(all);
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
      await enter(ctx, { tools: chosen });
    }
  }

  async function settingsMenu(ctx: ExtensionContext) {
    const current = lifecycle(ctx);
    const choice = await ctx.ui.select(
      "Plan settings",
      ["Default planning tools", "Reset to strict inspection tools", "Plans subdirectory"],
      { signal: current.signal },
    );
    if (!choice || !current.isCurrent()) return;
    idle(ctx);
    if (choice === "Default planning tools") return tools(ctx, true);
    if (choice === "Reset to strict inspection tools") {
      await updatePlanModeSettings({ tools: null }, { signal: current.signal });
    } else {
      const settings = await readSettings();
      if (!current.isCurrent()) return;
      const directory = await ctx.ui.input(
        "Plans subdirectory under <agent-dir>/pi-plan-mode",
        settings.plansDirectory,
        { signal: current.signal },
      );
      if (directory === undefined || !current.isCurrent()) return;
      idle(ctx);
      await updatePlanModeSettings({ plansDirectory: directory }, { signal: current.signal });
    }
    if (current.isCurrent()) notify(ctx, "Settings saved for future workflows. Existing plan files were not moved.");
  }

  pi.registerCommand("plan", {
    description: "Plan, review numbered revisions, or implement in a fresh session",
    getArgumentCompletions: (prefix) =>
      ["start", "saved", "tools", "settings", "finalize", "save", "exit"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
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
        if (command === "exit") {
          leave(ctx);
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
              ? ["Start planning", "Saved plans", "Tools", "Settings"]
              : ["Finalize plan", "Tools", "Save defaults", "Exit planning"],
            { signal: current.signal },
          );
          if (!current.isCurrent() || !choice) return;
          idle(ctx);
          if (choice === "Start planning") await enter(ctx);
          else if (choice === "Saved plans") await browse(ctx);
          else if (choice === "Tools") await tools(ctx);
          else if (choice === "Settings" || choice === "Save defaults") await settingsMenu(ctx);
          else if (choice === "Finalize plan") pi.sendUserMessage(FINALIZE_REQUEST);
          else leave(ctx);
          return;
        }
        const previous = state;
        const entered = await enter(ctx);
        if (!entered?.isCurrent()) return;
        try {
          pi.sendUserMessage(input);
        } catch (error) {
          if (previous.kind === "idle") transition(previous, ctx);
          throw error;
        }
      } catch (error) {
        if (session !== commandSession) return;
        if (!ctx.hasUI) throw error;
        notify(ctx, errorMessage(error), "error");
      } finally {
        commandOpen = false;
      }
    },
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
