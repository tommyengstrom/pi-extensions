import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { backgroundRuntime, backgroundStatus, type WorkflowContext, WorkflowScope } from "@narumitw/pi-background";
import { ARTIFACT_TOOLS } from "./artifacts.js";
import { IMPLEMENTATION_HELPERS } from "./implementation-state.js";
import planMode from "./plan-mode.js";
import { buildPlanModePrompt } from "./prompt.js";
import { isPlanning, isRestricted, PLAN_STATE_ENTRY, type PlanState, restorePlanState } from "./state.js";
import { defaultPlanTools, legacyDefaultCatalogue, PLAN_HELPER_NAMES, resolvePlanTools } from "./tool-policy.js";

/** Plan-owned adapter. Herdr never imports Plan or interprets its persisted state. */
export default async function planWithBackground(
  pi: ExtensionAPI,
  dependencies?: Parameters<typeof planMode>[1],
): Promise<void> {
  const background = backgroundRuntime(pi);
  const scope = new WorkflowScope(pi.events);
  let state: PlanState = { kind: "idle" };
  let ctx: ExtensionContext | undefined;
  let current: WorkflowContext | undefined;
  let signature = "";
  const legacyImplicit = new Set<string>();
  function restrictedIdentity(value: PlanState): string | undefined {
    return isPlanning(value) ? value.workflow.id : value.kind === "explain" ? value.restriction.id : undefined;
  }
  function catalogue() {
    const identity = restrictedIdentity(state);
    const selected = isPlanning(state)
      ? state.workflow.tools
      : state.kind === "explain"
        ? state.restriction.tools
        : undefined;
    const tools = pi.getAllTools();
    return identity && legacyImplicit.has(identity) && selected === undefined ? legacyDefaultCatalogue(tools) : tools;
  }
  function readRestored(context: ExtensionContext) {
    try {
      state = restorePlanState(context.sessionManager.getBranch());
    } catch {
      state = { kind: "idle" };
    }
    const identity = restrictedIdentity(state);
    const selected = isPlanning(state)
      ? state.workflow.tools
      : state.kind === "explain"
        ? state.restriction.tools
        : undefined;
    if (identity && selected === undefined) legacyImplicit.add(identity);
  }
  const parentOnly = [...PLAN_HELPER_NAMES, ...IMPLEMENTATION_HELPERS, ...ARTIFACT_TOOLS];
  function publish(force = false): void {
    if (!ctx) return;
    const selected = isPlanning(state)
      ? state.workflow.tools
      : state.kind === "explain"
        ? state.restriction.tools
        : undefined;
    const mode = state.kind === "explain" ? "explain" : "plan";
    const restriction = isRestricted(state)
      ? {
          allowedTools: resolvePlanTools(catalogue(), selected, mode).allowed,
          parentOnly,
          guidance:
            (isPlanning(state)
              ? buildPlanModePrompt(state.workflow.instructions, { content: state.workflow.templatePrompt })
              : state.restriction.prompt) +
            "\nThis is a delegated task. Do not save or approve a plan, change workflow mode, or start implementation. Controlled delegation and terminal/control-record bookkeeping are allowed; code mutation is not. Parent-only workflow and artifact tools are excluded.",
        }
      : {
          // Workflow authority stays parent-only even during Normal/implementation.
          allowedTools: pi
            .getAllTools()
            .filter(
              (tool) =>
                tool.exposure !== "hidden" &&
                (pi.getActiveTools().includes(tool.name) ||
                  tool.exposure === "codemode" ||
                  tool.exposure === "deferred"),
            )
            .map((tool) => tool.name),
          parentOnly,
          guidance:
            "Follow the delegated task and trusted project instructions. Parent-only workflow approval, plan saving, implementation helpers and artifact orchestration are excluded. A child cannot approve or transition its parent's workflow.",
        };
    const identity = isPlanning(state) ? state.workflow.id : state.kind === "explain" ? state.restriction.id : "normal";
    const next = JSON.stringify({ identity, restriction });
    if (force || next !== signature) {
      current = scope.replace(ctx.sessionManager.getSessionId(), restriction);
      signature = next;
    }
    scope.hold(state.kind === "ready");
  }
  function readiness(): void {
    if (!current) return;
    const status = backgroundStatus(pi, current.scope);
    if (status.active || status.pending)
      throw new Error(
        `Associated background work is not ready for review (${status.active} active/unconfirmed, ${status.pending} pending results). Wait/cancel subagents and retrieve completion results before publishing a ready plan.`,
      );
  }
  // Register ownership hooks before Plan's own asynchronous restoration hooks.
  pi.on("session_start", (_event, context) => {
    ctx = context;
    signature = "";
    readRestored(context);
  });
  pi.on("session_tree", (_event, context) => {
    scope.revoke("tree navigation");
    ctx = context;
    signature = "";
    readRestored(context);
  });
  pi.on("session_shutdown", () => {
    scope.dispose();
    ctx = undefined;
    current = undefined;
  });
  const wrapped: ExtensionAPI = {
    ...pi,
    getAllTools: catalogue,
    appendEntry(type, data) {
      if (type === PLAN_STATE_ENTRY) {
        const next = data as PlanState;
        if (next.kind === "ready") readiness();
        const selection = isPlanning(next) ? next.workflow : next.kind === "explain" ? next.restriction : undefined;
        const captured = selection && selection.tools === undefined;
        if (captured)
          selection.tools = defaultPlanTools(
            legacyImplicit.has(selection.id) ? legacyDefaultCatalogue(pi.getAllTools()) : pi.getAllTools(),
          );
        pi.appendEntry(type, data);
        state = next;
        publish();
      } else pi.appendEntry(type, data);
    },
    registerTool(definition) {
      if (definition.name !== "plan_mode_complete" && definition.name !== "plan_mode_edit") {
        pi.registerTool(definition);
        return;
      }
      const execute = definition.execute;
      pi.registerTool({
        ...definition,
        async execute(...args) {
          if (!isPlanning(state)) return execute(...args);
          readiness();
          // Freeze launch/steer and automatic delivery before asynchronous save/review work.
          scope.hold(true);
          background.hold("plan-publish", true);
          try {
            return await execute(...args);
          } finally {
            background.hold("plan-publish", false);
            scope.hold(state.kind === "ready");
          }
        },
      });
    },
  };
  await planMode(wrapped, dependencies);
  const restored = (context: ExtensionContext) => {
    ctx = context;
    readRestored(context);
    publish(true);
  };
  pi.on("session_start", (_event, context) => restored(context));
  pi.on("session_tree", (_event, context) => restored(context));
  pi.on("before_agent_start", () => publish());
  pi.on("agent_settled", (event) => {
    if (event.aborted) publish(true);
  });
}
