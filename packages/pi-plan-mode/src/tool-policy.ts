import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";

export const PLAN_HELPER_NAMES = ["plan_mode_question", "plan_mode_complete", "plan_mode_edit"] as const;
const DEFAULT_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

/** Pi only honors terminate when every result in the top-level batch terminates. */
export function standaloneToolCall(ctx: ExtensionContext, name: string): boolean {
  const message = [...ctx.sessionManager.getBranch()]
    .reverse()
    .find((entry) => entry.type === "message" && entry.message.role === "assistant");
  if (message?.type !== "message" || message.message.role !== "assistant") return true;
  const calls = message.message.content.filter((block) => block.type === "toolCall");
  return calls.length === 1 && calls[0].name === name;
}

/** Only Pi's canonical core implementations are trusted without an explicit selection. */
export function defaultPlanTools(tools: readonly ToolInfo[]): string[] {
  return DEFAULT_TOOL_NAMES.filter((name) =>
    tools.some(
      (tool) =>
        tool.name === name &&
        tool.sourceInfo?.source === "builtin" &&
        tool.sourceInfo.path === `builtin:${name}` &&
        tool.exposure !== "hidden",
    ),
  );
}

/**
 * Resolve exact allowed names separately from the direct model loadout. Core
 * gates every host-mediated call (including nested calls) against `allowed`.
 * Selecting an orchestrator never implicitly allows any tools it can reach.
 */
export function resolvePlanTools(
  tools: readonly ToolInfo[],
  selected?: readonly string[],
): { allowed: string[]; active: string[]; unavailable: string[] } {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const requested = new Set([...(selected ?? defaultPlanTools(tools)), ...PLAN_HELPER_NAMES]);
  const allowed: string[] = [];
  const active: string[] = [];
  const unavailable: string[] = [];
  for (const name of requested) {
    const tool = byName.get(name);
    // Helpers must be registered just like every other tool; their names alone
    // do not establish availability or bypass the current host loadout.
    if (!tool || tool.exposure === "hidden") {
      unavailable.push(name);
      continue;
    }
    allowed.push(name);
    if (tool.exposure === "direct" || tool.exposure === "model-only") active.push(name);
  }
  return { allowed, active, unavailable };
}
