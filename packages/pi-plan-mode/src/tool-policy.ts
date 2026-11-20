import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { verifiedSubagentTools } from "@narumitw/pi-background";
import { IMPLEMENTATION_HELPERS } from "./implementation-state.js";

export const IMPORT_VISUAL = "plan_mode_import_visual";
export const EXPLAIN_DENIED_HELPERS: readonly string[] = [
  "plan_mode_complete",
  IMPORT_VISUAL,
  ...IMPLEMENTATION_HELPERS,
];
export const PLAN_HELPER_NAMES = ["plan_mode_question", "plan_mode_complete", "plan_mode_edit"] as const;
export const ALL_PLAN_HELPERS = [...PLAN_HELPER_NAMES, IMPORT_VISUAL] as const;
/** Change only workflow-owned declarations, using Pi's live selection even during rollback. */
export function setWorkflowHelpers(pi: ExtensionAPI, owned: readonly string[], wanted: readonly string[]) {
  const active = pi.getActiveTools();
  const next = [...active.filter((name) => !owned.includes(name)), ...wanted];
  if (next.length !== active.length || next.some((name) => !active.includes(name))) pi.setActiveTools(next);
}
const DEFAULT_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
const legacyDefaultCatalogues = new WeakSet<readonly ToolInfo[]>();
/** Preserve pre-delegation implicit defaults on restored workflows without hiding
 * tools from explicit selection UIs or changing any saved explicit selection. */
export function legacyDefaultCatalogue(tools: readonly ToolInfo[]): ToolInfo[] {
  const copy = [...tools];
  legacyDefaultCatalogues.add(copy);
  return copy;
}

/** Pi only honors terminate when every result in the top-level batch terminates. */
export function standaloneToolCall(ctx: ExtensionContext, name: string): boolean {
  const message = [...ctx.sessionManager.getBranch()]
    .reverse()
    .find((entry) => entry.type === "message" && entry.message.role === "assistant");
  if (message?.type !== "message" || message.message.role !== "assistant") return true;
  const calls = message.message.content.filter((block) => block.type === "toolCall");
  return calls.length === 1 && calls[0].name === name;
}

/** Canonical native tools plus verified Herdr implementations; names alone grant nothing. */
export function defaultPlanTools(tools: readonly ToolInfo[]): string[] {
  return [
    ...DEFAULT_TOOL_NAMES.filter((name) =>
      tools.some(
        (tool) =>
          tool.name === name &&
          tool.sourceInfo?.source === "builtin" &&
          tool.sourceInfo.path === `builtin:${name}` &&
          tool.exposure !== "hidden",
      ),
    ),
    ...(legacyDefaultCatalogues.has(tools) ? [] : verifiedSubagentTools(tools)),
  ];
}

/** Exact allowed names and direct declarations are distinct. Each nested call needs permission. */
export function resolvePlanTools(
  tools: readonly ToolInfo[],
  selected?: readonly string[],
  mode: "plan" | "ui" | "explain" = "plan",
): { allowed: string[]; active: string[]; unavailable: string[] } {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const helpers = mode === "explain" ? ["plan_mode_question"] : mode === "ui" ? ALL_PLAN_HELPERS : PLAN_HELPER_NAMES;
  const requested = new Set([...(selected ?? defaultPlanTools(tools)), ...helpers]);
  const allowed: string[] = [];
  const active: string[] = [];
  const unavailable: string[] = [];
  for (const name of requested) {
    if (name === IMPORT_VISUAL && mode !== "ui") continue;
    if (mode === "explain" && EXPLAIN_DENIED_HELPERS.includes(name)) continue;
    const tool = byName.get(name);
    if (!tool || tool.exposure === "hidden") {
      unavailable.push(name);
      continue;
    }
    allowed.push(name);
    if (tool.exposure === "direct" || tool.exposure === "model-only") active.push(name);
  }
  return { allowed, active, unavailable };
}
