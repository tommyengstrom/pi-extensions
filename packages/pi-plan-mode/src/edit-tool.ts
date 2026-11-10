import { resolve } from "node:path";
import {
  createEditToolDefinition,
  type EditToolDetails,
  type EditToolInput,
  type ExtensionToolContext,
  generateDiffString,
  generateUnifiedPatch,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { normalizePlanModeCompletion, PLAN_MODE_MAX_CHARS } from "./completion-tool.js";
import type { PlanDocument } from "./plan-store.js";

export const PLAN_MODE_EDIT_TOOL_NAME = "plan_mode_edit";
export const PLAN_MODE_EDIT_PARAMS = createEditToolDefinition("/").parameters;
export type PlanEditInput = EditToolInput;
export type PlanEditResult = EditToolDetails & { plan: string };

/** Apply Pi's matcher to the supplied current-file snapshot, without writing any files. */
export async function applyPlanEdits(
  ctx: ExtensionToolContext,
  input: PlanEditInput,
  document: PlanDocument,
  plan: string,
  signal: AbortSignal | undefined = ctx.signal,
): Promise<PlanEditResult> {
  const basePath = resolve(ctx.cwd, document.path);
  let edited: string | undefined;
  const checkPath = (absolutePath: string) => {
    signal?.throwIfAborted();
    if (absolutePath !== basePath) throw new Error("Only the current plan document may be edited.");
  };
  const tool = createEditToolDefinition(ctx.cwd, {
    operations: {
      access: async (absolutePath) => checkPath(absolutePath),
      readFile: async (absolutePath) => {
        checkPath(absolutePath);
        return Buffer.from(plan, "utf8");
      },
      writeFile: async (absolutePath, content) => {
        checkPath(absolutePath);
        if (content.length > PLAN_MODE_MAX_CHARS)
          throw new Error(`Edited plan must not exceed ${PLAN_MODE_MAX_CHARS} characters, including whitespace.`);
        const normalized = normalizePlanModeCompletion({ plan: content });
        if (!normalized.ok) throw new Error(normalized.error);
        if (normalized.plan === plan.trim()) throw new Error("Plan edit makes no changes after normalization.");
        edited = normalized.plan;
      },
    },
  });
  signal?.throwIfAborted();
  await tool.execute(PLAN_MODE_EDIT_TOOL_NAME, input, signal, undefined, ctx);
  signal?.throwIfAborted();
  if (edited === undefined) throw new Error("Plan edit produced no result.");
  return {
    plan: edited,
    ...generateDiffString(plan, edited),
    patch: generateUnifiedPatch(document.path, plan, edited),
  };
}

/** Call only after the atomic same-path save succeeds. */
export function planModeEdited(document: PlanDocument, result: PlanEditResult, terminate: boolean) {
  const diff = truncateHead(sanitizeTerminalDocument(result.diff));
  return {
    content: [
      {
        type: "text" as const,
        text: `Plan updated: ${sanitizeTerminalText(document.path)}\n\n${diff.content}${diff.truncated ? "\n[Diff truncated; full diff is available in tool details.]" : ""}`,
      },
    ],
    details: {
      document,
      diff: result.diff,
      patch: result.patch,
      ...(result.firstChangedLine !== undefined ? { firstChangedLine: result.firstChangedLine } : {}),
    },
    terminate,
  };
}
