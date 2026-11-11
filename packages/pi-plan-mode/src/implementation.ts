import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { artifactGuidance } from "./artifacts.js";
import { normalizePlanModeCompletion, PLAN_MODE_COMPLETE_PARAMS, renderPlanModeCompletion } from "./completion-tool.js";
import { applyPlanEdits, PLAN_MODE_EDIT_TOOL_NAME, type PlanEditInput, planModeEdited } from "./edit-tool.js";
import {
  createImplementation,
  IMPLEMENTATION_ENTRY,
  IMPLEMENTATION_HELPERS,
  type ImplementationState,
  INPUT_ENTRY,
  legacyImplementationState,
  restoreImplementation,
  VERIFICATION_MESSAGE,
} from "./implementation-state.js";
import { implementationTranscript } from "./implementation-transcript.js";
import { editPlanDocument } from "./plan-editor.js";
import { createPlanStore, type PlanDocument, type PlanStore, planHash, storedPlanStorage } from "./plan-store.js";
import { createProgressController, progressSnapshot } from "./progress.js";
import type { ProgressRunner } from "./progress-runner.js";
import {
  DEFAULT_PROGRESS,
  type PlanModeSettings,
  PROGRESS_LEVELS,
  readPlanModeSettings,
  updatePlanModeSettings,
} from "./settings.js";
import { PLAN_HELPER_NAMES, resolvePlanTools, standaloneToolCall } from "./tool-policy.js";
import {
  renderVerificationResult,
  runVerification,
  toolIdentities,
  type VerificationInput,
  type VerificationResult,
  verificationContent,
} from "./verification.js";

export interface ImplementationDependencies {
  readSettings?(): Promise<PlanModeSettings>;
  progressRunner?: ProgressRunner;
  createStore?: typeof createPlanStore;
  verify?(input: VerificationInput): Promise<VerificationResult>;
}
const UPDATE = IMPLEMENTATION_HELPERS[0];
const COMPLETE = IMPLEMENTATION_HELPERS[1];

export function implementationInstructions(state: ImplementationState): string {
  return `# Tracked plan implementation
Implement the approved plan, preserving unchanged requirements. The current plan is ${state.document.path}. It is one mutable file. After compaction, or whenever its contents are uncertain, call plan_mode_implementation_status to read the current file.
When the user requests a plan change, update the plan before implementing the change. Prefer ${PLAN_MODE_EDIT_TOOL_NAME} for localized changes using {path, edits: [{oldText, newText}]}; use ${UPDATE} with the COMPLETE replacement plan for broader changes. Both update the same path without another approval dialog. A clarification without a change needs no edit. Seek user agreement before an agent-discovered material scope change; never invent approval or rewrite the plan just to hide drift.
When implementation and planned verification are finished, call ${COMPLETE} ALONE. Ordinary final prose is not the completion signal. A fresh adherence checker runs by default against the current file contents and branch-scoped implementation transcript. Results apply to inspected contents, not later changes. Its report does not authorize automatic fixes. Do not start a repair loop.${artifactGuidance(state.document.artifacts)}`;
}

/** Separate lifetime from restricted planning: implementation never gets planning's tool gate. */
export function registerImplementation(
  pi: ExtensionAPI,
  dependencies: ImplementationDependencies = {},
  planningActive: (ctx: ExtensionContext) => boolean = () => false,
  onStatus: (ctx: ExtensionContext) => void = () => {},
) {
  let state: ImplementationState | undefined;
  let owner: ExtensionContext["sessionManager"] | undefined;
  let generation = 0;
  let operation: AbortController | undefined;
  const readSettings = dependencies.readSettings ?? readPlanModeSettings;
  const makeStore = dependencies.createStore ?? createPlanStore;
  const verify = dependencies.verify ?? runVerification;
  const progress = createProgressController({
    readSettings,
    runner: dependencies.progressRunner,
    createStore: makeStore,
    snapshot: (ctx) =>
      owner === ctx.sessionManager && state && !planningActive(ctx) ? progressSnapshot(ctx, state) : undefined,
  });
  // Defer snapshots until persisted message/boundary updates are visible.
  pi.on("turn_end", () => {
    progress.mark();
  });
  pi.on("agent_settled", () => {
    progress.mark();
  });
  pi.on("session_compact", () => {
    progress.mark();
  });
  pi.on("message_end", () => {
    progress.mark();
  });

  function cancel(ctx?: ExtensionContext) {
    generation++;
    const checking = operation;
    operation = undefined;
    checking?.abort();
    if (checking && ctx && owner === ctx.sessionManager && state) {
      commit({ ...state, phase: "completed" });
      progress.close();
      activate(ctx);
      status(ctx);
    }
  }
  function status(ctx: ExtensionContext) {
    if (owner === ctx.sessionManager) onStatus(ctx);
  }
  function commit(next: ImplementationState) {
    pi.appendEntry(IMPLEMENTATION_ENTRY, next);
    state = next;
    progress.mark();
  }
  function active(ctx: ExtensionContext) {
    return owner === ctx.sessionManager && state?.phase === "implementing" && !planningActive(ctx);
  }
  function activate(ctx: ExtensionContext) {
    // The shared editor remains planning-owned when implementation is detached/restored.
    const tools = pi
      .getActiveTools()
      .filter(
        (name) =>
          !IMPLEMENTATION_HELPERS.includes(name as (typeof IMPLEMENTATION_HELPERS)[number]) ||
          (name === PLAN_MODE_EDIT_TOOL_NAME && planningActive(ctx)),
      );
    pi.setActiveTools(active(ctx) ? [...tools, ...IMPLEMENTATION_HELPERS] : tools);
  }
  function detach(ctx: ExtensionContext) {
    progress.close();
    cancel();
    if (state && state.phase !== "detached") commit({ ...state, phase: "detached" });
    activate(ctx);
    status(ctx);
  }
  function begin(next: ImplementationState, ctx: ExtensionContext) {
    progress.close();
    cancel();
    owner = ctx.sessionManager;
    commit(next);
    activate(ctx);
    status(ctx);
  }
  function rollback(previous: ImplementationState | undefined, ctx: ExtensionContext) {
    progress.close();
    cancel();
    pi.appendEntry(IMPLEMENTATION_ENTRY, previous ?? null);
    state = previous;
    activate(ctx);
    status(ctx);
  }
  async function restore(ctx: ExtensionContext, fresh = false) {
    progress.close();
    cancel();
    const manager = ctx.sessionManager;
    owner = manager;
    try {
      state = restoreImplementation(manager.getBranch());
    } catch (error) {
      state = undefined;
      if (ctx.hasUI)
        ctx.ui.notify(
          sanitizeTerminalText(
            `${legacyImplementationState(manager.getBranch()) ? "Legacy implementation tracking is not restored." : errorMessage(error)} Start fresh with /plan start and paste the Markdown body text.`,
          ),
          "warning",
        );
    }
    const version = generation;
    try {
      if (state) {
        const store = await ownedStore(ctx, state);
        await store.read(state.document);
      }
    } catch (error) {
      if (generation !== version || owner !== manager) return;
      if (state) state = { ...state, phase: "detached" };
      if (ctx.hasUI)
        ctx.ui.notify(
          sanitizeTerminalText(`Implementation tracking could not be restored: ${errorMessage(error)}`),
          "error",
        );
    }
    if (generation !== version || owner !== manager) return;
    if (fresh && state?.phase === "implementing" && !planningActive(ctx)) pi.setActiveTools(state.previousTools);
    activate(ctx);
    status(ctx);
  }
  pi.on("session_start", (event, ctx) => restore(ctx, event.reason === "new"));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    const disposed = progress.dispose();
    if (owner === ctx.sessionManager) {
      cancel(ctx);
      pi.setActiveTools(
        pi.getActiveTools().filter((name) => !IMPLEMENTATION_HELPERS.includes(name as typeof COMPLETE)),
      );
      owner = undefined;
    }
    await disposed;
  });
  pi.on("before_agent_start", (event, ctx) => {
    cancel(ctx);
    if (active(ctx) && state) {
      if (state.lastCheck) commit({ ...state, lastCheck: undefined });
      status(ctx);
      event.systemPromptOptions.sections.pi_plan_implementation = implementationInstructions(state);
    } else delete event.systemPromptOptions.sections.pi_plan_implementation;
  });
  pi.on("input", (event, ctx) => {
    if (!active(ctx) || !state) return;
    // Persist provenance before queuing; the exporter matches delivered user messages in order.
    pi.appendEntry(INPUT_ENTRY, {
      implementationId: state.id,
      source: event.source,
      fingerprint: planHash(event.text),
    });
    if (operation) cancel(ctx);
  });
  pi.on("tool_call", (event, ctx) => {
    if (!IMPLEMENTATION_HELPERS.includes(event.toolName as (typeof IMPLEMENTATION_HELPERS)[number])) return;
    if (event.toolName === PLAN_MODE_EDIT_TOOL_NAME && planningActive(ctx)) return;
    if (!active(ctx))
      return {
        block: true,
        reason: "This helper requires tracked implementation. Use /plan resume after completion or exit.",
      };
    if (event.toolName === COMPLETE && !standaloneToolCall(ctx, COMPLETE))
      return { block: true, reason: "Call plan_mode_implementation_complete alone, without sibling tool calls." };
  });

  function requireImplementation(ctx: ExtensionContext) {
    if (!active(ctx) || !state) throw new Error("Tracked implementation is not active. Use /plan resume.");
    return state;
  }
  async function ownedStore(ctx: ExtensionContext, source: ImplementationState): Promise<PlanStore> {
    const store = await makeStore(ctx.cwd, storedPlanStorage(source));
    if (store.projectRoot !== source.projectRoot) throw new Error("Implementation belongs to a different project.");
    return store;
  }

  async function check(ctx: ExtensionContext, signal?: AbortSignal): Promise<VerificationResult> {
    if (!state || owner !== ctx.sessionManager)
      throw new Error("No tracked implementation. Resume its session or implement a reviewed plan first.");
    if (operation) throw new Error("A plan adherence check is already running.");
    const source = structuredClone(state);
    const manager = ctx.sessionManager;
    const controller = new AbortController();
    operation = controller;
    const version = generation;
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const current = () => owner === manager && generation === version && !combined.aborted && state?.id === source.id;
    const assertCurrent = () => {
      if (!current()) throw new Error("Plan adherence check cancelled because ownership changed.");
    };
    // Snapshot branch now, before awaiting settings, providers or files.
    const transcript = implementationTranscript(manager.getBranch(), source.id);
    const dialog = new AbortController();
    let cancellation: Promise<unknown> | undefined;
    try {
      // Verification owns its own activity; persist inactivity before any await so
      // tree restoration/reload cannot resurrect the checked implementation.
      commit({ ...source, phase: "completed", lastCheck: undefined });
      activate(ctx);
      status(ctx);
      progress.close();
      const store = await ownedStore(ctx, source);
      const plan = await store.read(source.document);
      const target = { document: source.document, plan, hash: planHash(plan) };
      assertCurrent();
      const settings = await readSettings();
      assertCurrent();
      const resolved = resolvePlanTools(pi.getAllTools(), source.tools);
      if (resolved.unavailable.length)
        throw new Error(`Selected planning tools are unavailable: ${resolved.unavailable.join(", ")}`);
      const names = resolved.allowed.filter(
        (name) =>
          !PLAN_HELPER_NAMES.includes(name as (typeof PLAN_HELPER_NAMES)[number]) &&
          !IMPLEMENTATION_HELPERS.includes(name as typeof COMPLETE),
      );
      const identities = toolIdentities(pi.getAllTools(), names);
      if (JSON.stringify(identities) !== JSON.stringify(source.toolIdentities))
        throw new Error(
          "Planning tools changed or are unavailable. Review the selection with /plan tools before checking.",
        );
      if (ctx.hasUI && !signal) {
        cancellation = ctx.ui
          .select("Checking plan adherence — close to cancel", ["Cancel check"], { signal: dialog.signal })
          .then(() => {
            if (!dialog.signal.aborted) controller.abort();
          });
      }
      const result = await verify({
        ctx,
        implementation: source,
        target,
        transcript,
        settings: settings.verification ?? { automatic: true },
        signal: combined,
        onProgress: () => {},
      });
      assertCurrent();
      const timestamp = new Date().toISOString();
      pi.appendEntry("pi-plan-check", {
        implementationId: source.id,
        planHash: target.hash,
        transcriptHash: transcript.hash,
        transcriptEndpoint: transcript.endpoint,
        timestamp,
        ...result,
      });
      commit({
        ...source,
        phase: "completed",
        lastCheck: { status: result.report.status, timestamp, hash: target.hash },
      });
      return result;
    } catch (error) {
      if (current()) {
        const timestamp = new Date().toISOString();
        pi.appendEntry("pi-plan-check", {
          implementationId: source.id,
          planId: source.document.id,
          transcriptHash: transcript.hash,
          transcriptEndpoint: transcript.endpoint,
          timestamp,
          outcome: "failed",
          error: errorMessage(error),
        });
        commit({ ...source, phase: "completed", lastCheck: { status: "failed", timestamp, hash: source.hash } });
      }
      throw error;
    } finally {
      dialog.abort();
      await cancellation?.catch(() => {});
      if (operation === controller) {
        operation = undefined;
        if (owner === manager && state?.id === source.id) {
          commit({ ...state, phase: "completed" });
          activate(ctx);
          status(ctx);
        }
      }
    }
  }

  pi.registerMessageRenderer(VERIFICATION_MESSAGE, (message, _options, theme) =>
    renderVerificationResult(
      {
        content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
        details: message.details,
      },
      theme,
    ),
  );

  function planOperation(ctx: ExtensionContext, signal?: AbortSignal) {
    const source = requireImplementation(ctx);
    const manager = ctx.sessionManager;
    const version = generation;
    const combined = AbortSignal.any([signal, ctx.signal].filter((value): value is AbortSignal => !!value));
    return {
      source,
      signal: combined,
      isCurrent: () => owner === manager && state === source && generation === version && !combined.aborted,
    };
  }

  async function publishPlan(
    ctx: ExtensionContext,
    operation: ReturnType<typeof planOperation>,
    store: PlanStore,
    plan: string,
  ) {
    const { source, signal, isCurrent } = operation;
    if (!isCurrent()) throw new Error("Plan update cancelled.");
    const document = await store.save(plan, {
      document: source.document,
      expectedHash: source.hash,
      signal,
      isCurrent,
    });
    if (!isCurrent()) throw new Error(`Plan saved at ${document.path}, but implementation ownership changed.`);
    try {
      commit({
        ...source,
        document,
        hash: planHash(plan),
        lastCheck: undefined,
        completion: undefined,
      });
    } catch (error) {
      throw new Error(
        `Plan saved at ${document.path}, but tracking could not be persisted. Read plan_mode_implementation_status before continuing. ${errorMessage(error)}`,
      );
    }
    status(ctx);
    return document;
  }

  pi.registerTool({
    name: UPDATE,
    label: "Update implementation plan",
    defaultActive: false,
    executionMode: "sequential",
    description:
      "Update the current single-file implementation plan with a COMPLETE replacement. Prefer plan_mode_edit for localized changes. Does not require another approval dialog.",
    parameters: PLAN_MODE_COMPLETE_PARAMS,
    renderResult: renderPlanModeCompletion,
    async execute(_id, params, signal, _update, ctx) {
      const operation = planOperation(ctx, signal);
      const parsed = normalizePlanModeCompletion(params);
      if (!parsed.ok) throw new Error(parsed.error);
      const store = await ownedStore(ctx, operation.source);
      const document = await publishPlan(ctx, operation, store, parsed.plan);
      return {
        content: [
          {
            type: "text",
            text: `## Implementation plan updated\n\n${parsed.plan}\n\nSaved to: ${document.path}\nContinue implementation; no additional approval dialog is required.`,
          },
        ],
        details: { document },
      };
    },
  });
  pi.registerTool({
    name: "plan_mode_implementation_status",
    label: "Current implementation plan",
    defaultActive: false,
    description:
      "Read the current tracked plan file after compaction or whenever its contents are uncertain. Does not modify the file.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    renderResult: renderPlanModeCompletion,
    async execute(_id, _params, signal, _update, ctx) {
      const source = requireImplementation(ctx);
      const op = planOperation(ctx, signal);
      const store = await ownedStore(ctx, source);
      const plan = await store.read(source.document);
      if (!op.isCurrent()) throw new Error("Plan read cancelled.");
      const hash = planHash(plan);
      commit({ ...source, hash });
      return {
        content: [
          {
            type: "text",
            text: `## Current implementation plan\n\nImplementation: ${source.id}\nPath: ${source.document.path}\nSHA-256: ${hash}\n\n${plan}`,
          },
        ],
        details: { document: source.document, hash },
      };
    },
  });
  pi.registerTool({
    name: COMPLETE,
    label: "Complete implementation",
    defaultActive: false,
    executionMode: "sequential",
    description:
      "Signal that tracked implementation and planned verification are finished. Call ALONE. Runs a fresh adherence check unless disabled in settings; does not automatically fix findings.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    renderResult: (result, _options, theme) => renderVerificationResult(result, theme),
    async execute(_id, _params, signal, _update, ctx) {
      const source = requireImplementation(ctx);
      const manager = ctx.sessionManager;
      if (!standaloneToolCall(ctx, COMPLETE)) throw new Error("Implementation completion must be called alone.");
      const version = generation;
      const settings = await readSettings();
      if (version !== generation || owner !== manager || signal?.aborted)
        throw new Error("Implementation completion cancelled.");
      commit({ ...source, phase: "completed", completion: randomUUID(), lastCheck: undefined });
      activate(ctx);
      status(ctx);
      if (settings.verification?.automatic === false)
        return {
          content: [
            {
              type: "text",
              text: "Implementation completed — not checked. Run /plan verify to check adherence; /plan resume to continue implementation.",
            },
          ],
          details: {},
          terminate: true,
        };
      try {
        const result = await check(ctx, signal);
        return {
          content: [{ type: "text", text: verificationContent(result) }],
          details: result,
          usage: result.usage,
          terminate: true,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Implementation completed, but adherence was not verified: ${errorMessage(error)}\nRun /plan verify to retry; /plan resume to continue implementation.`,
            },
          ],
          details: { error: errorMessage(error) },
          isError: true,
          terminate: true,
        };
      }
    },
  });

  return {
    get state() {
      return state;
    },
    checking(ctx: ExtensionContext) {
      return owner === ctx.sessionManager && !!operation;
    },
    active,
    progress: progress.toggle,
    async edit(ctx: ExtensionToolContext, input: PlanEditInput, signal?: AbortSignal) {
      const operation = planOperation(ctx, signal);
      const store = await ownedStore(ctx, operation.source);
      if (!operation.isCurrent()) throw new Error("Plan update cancelled.");
      const previous = operation.source.document;
      const plan = await store.read(previous);
      if (planHash(plan) !== operation.source.hash)
        throw new Error("Current plan changed on disk. Read plan_mode_implementation_status before editing.");
      const edited = await applyPlanEdits(ctx, input, previous, plan, operation.signal);
      const document = await publishPlan(ctx, operation, store, edited.plan);
      return planModeEdited(document, edited, false);
    },
    begin,
    rollback,
    detach,
    cancel,
    prepare(
      _ctx: ExtensionContext,
      document: PlanDocument,
      plan: string,
      store: PlanStore,
      tools?: string[],
      previousTools = pi.getActiveTools(),
    ): ImplementationState {
      const selected = resolvePlanTools(pi.getAllTools(), tools);
      const names = selected.allowed.filter(
        (name) =>
          !PLAN_HELPER_NAMES.includes(name as (typeof PLAN_HELPER_NAMES)[number]) &&
          !IMPLEMENTATION_HELPERS.includes(name as typeof COMPLETE),
      );
      if (selected.unavailable.some((name) => !PLAN_HELPER_NAMES.includes(name as (typeof PLAN_HELPER_NAMES)[number])))
        throw new Error("Some planning tools are unavailable. Review /plan tools before implementation.");
      return createImplementation(
        {
          projectRoot: store.projectRoot,
          storage: store.storage,
          previousTools,
          tools,
          toolIdentities: toolIdentities(pi.getAllTools(), names),
        },
        document,
        plan,
      );
    },
    async command(command: string, ctx: ExtensionContext): Promise<boolean> {
      if (command === "open") {
        if (!state || owner !== ctx.sessionManager) throw new Error("No current plan to open.");
        const source = state;
        const manager = ctx.sessionManager;
        const version = generation;
        const current = {
          isCurrent: () => owner === manager && generation === version && state === source,
        };
        const store = await ownedStore(ctx, source);
        if (!current.isCurrent()) return true;
        const edited = await editPlanDocument(ctx, store, source.document, current);
        if (edited && current.isCurrent()) {
          commit({ ...source, ...edited, lastCheck: undefined, completion: undefined });
          status(ctx);
        }
        return true;
      }
      if (command === "verify") {
        const manager = ctx.sessionManager;
        const result = await check(ctx);
        if (owner === manager)
          pi.sendMessage(
            {
              customType: VERIFICATION_MESSAGE,
              content: verificationContent(result),
              display: true,
              details: result,
            },
            { triggerTurn: false },
          );
        return true;
      }
      if (command === "resume") {
        if (!state) throw new Error("No tracked implementation to resume.");
        const source = state;
        const manager = ctx.sessionManager;
        const version = generation;
        const store = await ownedStore(ctx, source);
        const plan = await store.read(source.document);
        if (generation !== version || owner !== manager) return true;
        begin(
          { ...source, hash: planHash(plan), phase: "implementing", completion: undefined, lastCheck: undefined },
          ctx,
        );
        if (ctx.hasUI)
          ctx.ui.notify("Implementation tracking resumed. Send the requested fixes or changes now.", "info");
        return true;
      }
      if (command === "cancel") {
        cancel(ctx);
        status(ctx);
        return true;
      }
      return false;
    },
    setTools(tools: string[], ctx: ExtensionContext) {
      if (!state) return;
      const names = resolvePlanTools(pi.getAllTools(), tools).allowed.filter(
        (name) =>
          !PLAN_HELPER_NAMES.includes(name as (typeof PLAN_HELPER_NAMES)[number]) &&
          !IMPLEMENTATION_HELPERS.includes(name as typeof COMPLETE),
      );
      commit({ ...state, tools, toolIdentities: toolIdentities(pi.getAllTools(), names), lastCheck: undefined });
      status(ctx);
    },
    async settings(ctx: ExtensionContext, choice: string, signal: AbortSignal) {
      const settings = await readSettings();
      signal.throwIfAborted();
      if (choice === "Progress reasoning") {
        const answer = await ctx.ui.select(
          "Progress reasoning (constrained to model capabilities)",
          ["Default (low)", ...PROGRESS_LEVELS],
          { signal },
        );
        if (answer && !signal.aborted)
          await updatePlanModeSettings(
            {
              progress: {
                thinkingLevel: answer === "Default (low)" ? null : (answer as (typeof PROGRESS_LEVELS)[number]),
              },
            },
            { signal },
          );
      } else if (choice === "Naming model") {
        const available = ctx.modelRegistry.getAvailable();
        const options = [
          "Progress model (default)",
          ...available.map((model, index) => `${index + 1}. ${sanitizeTerminalText(`${model.provider}/${model.id}`)}`),
        ];
        const answer = await ctx.ui.select(
          "Naming model — receives initial task only (additional provider request)",
          options,
          { signal },
        );
        if (!answer || signal.aborted) return;
        const selected = available[options.indexOf(answer) - 1];
        await updatePlanModeSettings(
          { naming: { model: selected ? { provider: selected.provider, id: selected.id } : null } },
          { signal },
        );
      } else if (choice === "Progress model") {
        const available = ctx.modelRegistry.getAvailable();
        const options = [
          `Default (${DEFAULT_PROGRESS.model.provider}/${DEFAULT_PROGRESS.model.id})`,
          ...available.map((model, index) => `${index + 1}. ${sanitizeTerminalText(`${model.provider}/${model.id}`)}`),
        ];
        const answer = await ctx.ui.select("Progress observer model", options, { signal });
        if (!answer || signal.aborted) return;
        const selected = available[options.indexOf(answer) - 1];
        await updatePlanModeSettings(
          { progress: { model: selected ? { provider: selected.provider, id: selected.id } : null } },
          { signal },
        );
      } else if (choice === "Automatic adherence checks") {
        const answer = await ctx.ui.select("Automatic adherence checking", ["On (default)", "Off"], { signal });
        if (answer && !signal.aborted)
          await updatePlanModeSettings({ verification: { automatic: answer === "On (default)" } }, { signal });
      } else {
        const available = ctx.modelRegistry.getAvailable();
        const current = settings.verification?.model;
        const options = [
          "Current model (default)",
          ...available.map((model, index) => `${index + 1}. ${sanitizeTerminalText(`${model.provider}/${model.id}`)}`),
        ];
        const answer = await ctx.ui.select(
          sanitizeTerminalText(`Adherence checker model${current ? ` — ${current.provider}/${current.id}` : ""}`),
          options,
          { signal },
        );
        if (!answer || signal.aborted) return;
        const selected = available[options.indexOf(answer) - 1];
        await updatePlanModeSettings(
          { verification: { model: selected ? { provider: selected.provider, id: selected.id } : null } },
          { signal },
        );
      }
    },
  };
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
