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
import type { PlanRevision } from "./plan-store.js";

export const PLAN_MODE_EDIT_TOOL_NAME = "plan_mode_edit";
// Use the host's actual schema, not a parallel approximation of it.
export const PLAN_MODE_EDIT_PARAMS = createEditToolDefinition("/").parameters;
export type PlanEditInput = EditToolInput;
export type PlanEditResult = EditToolDetails & { plan: string };

/** Run Pi's matcher on a supplied snapshot; none of these operations writes to disk. */
export async function applyPlanEdits(
  ctx: ExtensionToolContext,
  input: PlanEditInput,
  revision: PlanRevision,
  plan: string,
  signal: AbortSignal | undefined = ctx.signal,
): Promise<PlanEditResult> {
  const basePath = resolve(ctx.cwd, revision.path);
  let edited: string | undefined;
  const checkPath = (absolutePath: string) => {
    signal?.throwIfAborted();
    if (absolutePath !== basePath) throw new Error("Only the selected plan revision may be edited.");
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
        // Like the complete-plan schema, bound the raw body too: the SDK diffs
        // this untrimmed candidate after writeFile, not our normalized copy.
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
  // Diff the actual bodies, not the SDK's intermediate line-ending/fuzzy view
  // or the pre-trim candidate. Reserved headers are rejected by the store.
  return {
    plan: edited,
    ...generateDiffString(plan, edited),
    patch: generateUnifiedPatch(input.path, plan, edited),
  };
}

/** Call only after publishing the new revision. The model receives a diff, not the full plan. */
export function planModeEdited(revision: PlanRevision, sourcePath: string, result: PlanEditResult, terminate: boolean) {
  const diff = truncateHead(sanitizeTerminalDocument(result.diff));
  return {
    content: [
      {
        type: "text" as const,
        text: `Plan edited. Saved new revision to: ${sanitizeTerminalText(revision.path)}\nSource preserved: ${sanitizeTerminalText(sourcePath)}\n\n${diff.content}${diff.truncated ? "\n[Diff truncated; full diff is available in tool details.]" : ""}`,
      },
    ],
    details: {
      revision,
      sourcePath,
      diff: result.diff,
      patch: result.patch,
      ...(result.firstChangedLine !== undefined ? { firstChangedLine: result.firstChangedLine } : {}),
    },
    terminate,
  };
}
