import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { runConfirmation } from "@narumitw/pi-tui-kit/confirmation";
import { runDocumentReview } from "@narumitw/pi-tui-kit/document-review";
import { runMultiSelect } from "@narumitw/pi-tui-kit/multi-select";
import { sanitizeTerminalText as terminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { IMPLEMENTATION_HELPERS } from "./implementation-state.js";
import type { PlanDocument } from "./plan-store.js";
import { defaultPlanTools, PLAN_HELPER_NAMES } from "./tool-policy.js";

export interface MenuLifecycle {
  signal: AbortSignal;
  isCurrent(): boolean;
}
type ReviewAction = "fresh" | "here" | "save" | "continue";
function current(lifecycle: MenuLifecycle) {
  return !lifecycle.signal.aborted && lifecycle.isCurrent();
}
function canPrompt(ctx: ExtensionContext, lifecycle: MenuLifecycle) {
  return ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc") && current(lifecycle);
}
/** Intent only; dismissal never approves implementation. */
export async function reviewPlan(
  ctx: ExtensionContext,
  plan: string,
  document: PlanDocument,
  lifecycle: MenuLifecycle,
): Promise<ReviewAction | undefined> {
  if (!canPrompt(ctx, lifecycle)) return undefined;
  const reviewed = await runDocumentReview(ctx, {
    title: `Review plan: ${terminalText(document.title)}`,
    lines: [
      `Name: ${terminalText(document.name)}`,
      `Path: ${terminalText(document.path)}`,
      ...(document.artifacts?.references.flatMap((reference) => [
        `Live artifact: ${terminalText(reference.artifactId)} · ${reference.status}${document.artifacts?.omittedJobIds?.includes(reference.jobId) ? " (omitted by user agreement)" : ""}`,
        terminalText(reference.directory),
        ...reference.paths.slice(0, 10).map(terminalText),
        "Live files, not a historical snapshot.",
      ]) ?? []),
    ],
    content: plan,
    format: { kind: "markdown" },
    viewportSize: "adaptive",
    enableSearch: true,
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
/** One entry per current document. The store excludes unsupported files. */
export async function selectSavedPlan(
  ctx: ExtensionContext,
  documents: PlanDocument[],
  lifecycle: MenuLifecycle,
): Promise<PlanDocument | undefined> {
  if (!canPrompt(ctx, lifecycle)) return undefined;
  if (!documents.length) {
    ctx.ui.notify("No saved plans found. Import Markdown explicitly to start an independent plan.", "info");
    return undefined;
  }
  let chosen: PlanDocument | undefined;
  const menu = defineMenu<undefined, "plans", "choose", ExtensionContext>({
    start: "plans",
    screens: {
      plans: () => ({
        kind: "choice",
        title: "Saved plans",
        lines: ["Choose a plan to review its current contents."],
        items: documents.map((document) => ({
          id: document.path,
          label: `${terminalText(document.name)} — ${terminalText(document.title)}`,
          description: terminalText(document.path),
          details: [`Path: ${terminalText(document.path)}`],
        })),
        action: "choose",
        enableSearch: true,
        hint: "close",
      }),
    },
    actions: {
      choose: ({ itemId }) => {
        if (current(lifecycle)) chosen = documents.find((document) => document.path === itemId);
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
/** Configuration only: normal-mode callers must not activate planning restrictions. */
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
