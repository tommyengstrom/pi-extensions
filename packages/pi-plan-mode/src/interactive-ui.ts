import { dirname, join } from "node:path";
import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { runConfirmation } from "@narumitw/pi-tui-kit/confirmation";
import { runDocumentReview } from "@narumitw/pi-tui-kit/document-review";
import { runMultiSelect } from "@narumitw/pi-tui-kit/multi-select";
import { sanitizeTerminalText as terminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { IMPLEMENTATION_HELPERS } from "./implementation-state.js";
import type { PlanRevision } from "./plan-store.js";
import { defaultPlanTools, PLAN_HELPER_NAMES } from "./tool-policy.js";

/** The caller aborts this signal on session replacement, reload, and shutdown. */
export interface MenuLifecycle {
  signal: AbortSignal;
  isCurrent(): boolean;
}

type ReviewAction = "fresh" | "here" | "save" | "continue";

function current(lifecycle: MenuLifecycle): boolean {
  return !lifecycle.signal.aborted && lifecycle.isCurrent();
}

function canPrompt(ctx: ExtensionContext, lifecycle: MenuLifecycle): boolean {
  return ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc") && current(lifecycle);
}

/** Collect intent only: opening or dismissing this UI never launches implementation. */
export async function reviewPlan(
  ctx: ExtensionContext,
  plan: string,
  revision: PlanRevision,
  lifecycle: MenuLifecycle,
): Promise<"fresh" | "here" | "save" | "continue" | undefined> {
  if (!canPrompt(ctx, lifecycle)) return undefined;
  const reviewed = await runDocumentReview(ctx, {
    title: `Review plan: ${terminalText(revision.title)}`,
    lines: [
      `Path: ${terminalText(revision.path)}`,
      `Revision: ${revision.revision}`,
      ...(revision.history?.reason ? [`Change reason: ${terminalText(revision.history.reason)}`] : []),
    ],
    content: plan,
    format: { kind: "markdown" },
    viewportSize: "adaptive",
    enableSearch: true,
    // Never remember a previous launch choice: fresh is always first/default.
    actions: [
      { id: "fresh", label: "Implement in fresh session" },
      { id: "here", label: "Implement here" },
      { id: "save", label: "Save for later" },
      { id: "continue", label: "Continue planning" },
    ],
    hint: "close",
    signal: lifecycle.signal,
    isCurrent: () => lifecycle.isCurrent(),
  });
  return current(lifecycle) && reviewed.kind === "selected" ? (reviewed.actionId as ReviewAction) : undefined;
}

/** Browse a supplied filesystem snapshot; no index or selection is persisted. */
export async function selectSavedPlan(
  ctx: ExtensionContext,
  revisions: PlanRevision[],
  lifecycle: MenuLifecycle,
): Promise<PlanRevision | undefined> {
  if (!canPrompt(ctx, lifecycle)) return undefined;
  if (revisions.length === 0) {
    ctx.ui.notify("No saved plans found.", "info");
    return undefined;
  }
  const groups = new Map<string, PlanRevision[]>();
  for (const revision of revisions) {
    const key = join(dirname(revision.path), revision.series);
    const group = groups.get(key) ?? [];
    group.push(revision);
    groups.set(key, group);
  }
  const locationsPerSeries = new Map<string, number>();
  for (const group of groups.values()) {
    group.sort((a, b) => b.revision - a.revision);
    const series = group[0].series;
    locationsPerSeries.set(series, (locationsPerSeries.get(series) ?? 0) + 1);
  }
  let activeGroup: PlanRevision[] = [];
  let chosen: PlanRevision | undefined;
  const menu = defineMenu<undefined, "series" | "revisions", "open" | "choose", ExtensionContext>({
    start: "series",
    screens: {
      series: () => ({
        kind: "choice",
        title: "Saved plans",
        lines: ["Choose a plan series, then its latest or an older revision."],
        items: [...groups].map(([series, group]) => ({
          id: series,
          label: `${terminalText(group[0].title || group[0].series)} — ${terminalText(group[0].series)}${(locationsPerSeries.get(group[0].series) ?? 0) > 1 ? ` · ${terminalText(dirname(group[0].path))}` : ""}`,
          description: `Latest revision: ${group[0]?.revision} · ${group.length} revision(s)`,
          details: [`Path: ${terminalText(group[0]?.path ?? "")}`],
        })),
        action: "open",
        enableSearch: true,
        hint: "close",
      }),
      revisions: () => ({
        kind: "choice",
        title: `Revisions: ${terminalText(activeGroup[0]?.series ?? "")}`,
        lines: ["Latest is selected by default. Choose an older revision if needed."],
        items: activeGroup.map((revision, index) => ({
          id: revision.path,
          label: `Revision ${revision.revision}${index === 0 ? " (latest)" : ""} — ${terminalText(revision.title)}`,
          description: terminalText(revision.path),
          details: [`Path: ${terminalText(revision.path)}`],
        })),
        initialItemId: activeGroup[0]?.path,
        action: "choose",
        enableSearch: true,
      }),
    },
    actions: {
      open: ({ itemId }) => {
        if (!current(lifecycle)) return { kind: "close" };
        activeGroup = groups.get(itemId) ?? [];
        return activeGroup.length ? { kind: "to", screen: "revisions" } : { kind: "stay" };
      },
      choose: ({ itemId }) => {
        if (current(lifecycle)) chosen = activeGroup.find((revision) => revision.path === itemId);
        return { kind: "close" };
      },
    },
  });
  const result = await runMenu(ctx, menu, {
    getState: () => undefined,
    signal: lifecycle.signal,
    isCurrent: () => lifecycle.isCurrent(),
  });
  return current(lifecycle) && result.kind === "closed" ? chosen : undefined;
}

const FIXED_HELPERS = new Set<string>([...PLAN_HELPER_NAMES, ...IMPLEMENTATION_HELPERS]);

/** Return a proposed configuration; activation and persistence belong to the caller. */
export async function selectPlanTools(
  ctx: ExtensionContext,
  tools: ToolInfo[],
  selected: string[],
  lifecycle: MenuLifecycle,
): Promise<string[] | undefined> {
  if (!canPrompt(ctx, lifecycle)) return undefined;
  const canonical = new Set(defaultPlanTools(tools));
  const available = new Map(
    tools
      .filter((tool) => !FIXED_HELPERS.has(tool.name) && tool.exposure !== "hidden")
      .map((tool) => [tool.name, tool]),
  );
  const configured = new Set(selected.filter((name) => !FIXED_HELPERS.has(name)));
  const unavailable = [...configured].filter((name) => !available.has(name));
  const result = await runMultiSelect(ctx, {
    title: "Planning tools",
    lines: [
      "Defaults: canonical core read, grep, find, ls. Planning helpers are fixed and excluded.",
      "Other tools, including shells and core-name overrides, are trusted and may mutate files.",
      ...(unavailable.length
        ? ["Unavailable configured tools are retained unchanged; edit configuration to remove them."]
        : []),
    ],
    items: [
      ...[...available.values()].map((tool) => ({
        id: tool.name,
        label: terminalText(tool.name),
        description: `${canonical.has(tool.name) ? "Core default" : "Trusted nondefault"} — ${terminalText(tool.description)}`,
        selected: configured.has(tool.name),
        searchText: `${tool.description} ${tool.sourceInfo.path}`,
      })),
      ...unavailable.map((name) => ({
        id: name,
        label: terminalText(name),
        description: "Configured but unavailable; retained unchanged",
        selected: true,
        disabled: true,
        disabledReason: "Not currently available",
      })),
    ],
    enableSearch: true,
    completionLabel: "Apply tool selection",
    hint: "close",
    signal: lifecycle.signal,
    isCurrent: () => lifecycle.isCurrent(),
  });
  if (!current(lifecycle) || result.kind !== "completed") return undefined;
  const names = result.selectedItemIds;
  const nondefault = names.filter((name) => !canonical.has(name));
  if (nondefault.length) {
    const confirmation = await runConfirmation(ctx, {
      title: "Trust nondefault planning tools?",
      message: [
        `Selected nondefault tools: ${nondefault.map(terminalText).join(", ")}`,
        "These tools are trusted and may mutate files or external state during planning.",
        "This includes shell tools and overrides of core tools. Plan mode is not a sandbox.",
        "Unavailable configured tools remain selected and may become available later.",
      ].join("\n"),
      confirmLabel: "Trust selected tools",
      cancelLabel: "Cancel changes",
      signal: lifecycle.signal,
      isCurrent: () => lifecycle.isCurrent(),
    });
    if (!current(lifecycle) || confirmation.kind !== "confirmed") return undefined;
  }
  return current(lifecycle) ? names : undefined;
}
