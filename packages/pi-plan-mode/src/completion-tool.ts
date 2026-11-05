import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";
import { sanitizeTerminalText as terminalText } from "@narumitw/pi-tui-kit/terminal-text";

export const PLAN_MODE_COMPLETE_TOOL_NAME = "plan_mode_complete";
export const PLAN_MODE_COMPLETE_VERSION = 1;
export const PLAN_MODE_MAX_CHARS = 50_000;

export type PlanModeCompletionDetails = {
  version: typeof PLAN_MODE_COMPLETE_VERSION;
  source: typeof PLAN_MODE_COMPLETE_TOOL_NAME;
  plan: string;
  path: string;
};

export const PLAN_MODE_COMPLETE_PARAMS = {
  type: "object",
  additionalProperties: false,
  required: ["plan"],
  properties: {
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 8000,
      description: "What changed and why; required when revising a saved plan.",
    },
    plan: {
      type: "string",
      minLength: 1,
      maxLength: PLAN_MODE_MAX_CHARS,
      description:
        "The complete implementation decision brief in Markdown: resolve material decisions, start with the intended change and main affected code paths, include non-obvious required changes, and delegate routine mechanics.",
    },
  },
} as const;

type NormalizePlanModeCompletionResult = { ok: true; plan: string; reason?: string } | { ok: false; error: string };

export function normalizePlanModeCompletion(input: unknown): NormalizePlanModeCompletionResult {
  if (!isRecord(input) || typeof input.plan !== "string") {
    return { ok: false, error: "plan must be a string" };
  }
  const plan = input.plan.trim();
  if (!plan) return { ok: false, error: "plan must not be empty" };
  if (plan.length > PLAN_MODE_MAX_CHARS) {
    return {
      ok: false,
      error: `plan must not exceed ${PLAN_MODE_MAX_CHARS} characters`,
    };
  }
  if (
    input.reason !== undefined &&
    (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 8000)
  )
    return { ok: false, error: "reason must be nonempty and at most 8000 characters" };
  return { ok: true, plan, ...(typeof input.reason === "string" ? { reason: input.reason.trim() } : {}) };
}

export function planFromCompletionDetails(value: unknown) {
  if (!isRecord(value)) return undefined;
  if (value.version !== PLAN_MODE_COMPLETE_VERSION || value.source !== PLAN_MODE_COMPLETE_TOOL_NAME) {
    return undefined;
  }
  const normalized = normalizePlanModeCompletion({ plan: value.plan });
  return normalized.ok ? normalized.plan : undefined;
}

export function planModeCompleted(plan: string, path: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `**Plan ready**\n\n${plan}\n\nSaved to: ${terminalText(path)}\nIn TUI or RPC, review opens automatically after this turn settles. Implementation requires your explicit choice. Open /plan to reopen review or if it does not appear; in print/JSON, resume interactively first.`,
      },
    ],
    details: {
      version: PLAN_MODE_COMPLETE_VERSION,
      source: PLAN_MODE_COMPLETE_TOOL_NAME,
      plan,
      path,
    } satisfies PlanModeCompletionDetails,
    terminate: true,
  };
}

type PlanModeCompletionRenderResult = {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
};

export function planModeCompletionMarkdown(result: PlanModeCompletionRenderResult) {
  const content = result.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (content) return content;
  const plan = planFromCompletionDetails(result.details);
  return plan ? `**Proposed Plan**\n\n${plan}` : "";
}

export function renderPlanModeCompletion(result: PlanModeCompletionRenderResult) {
  return new Markdown(sanitizeTerminalDocument(planModeCompletionMarkdown(result)), 0, 0, getMarkdownTheme());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
