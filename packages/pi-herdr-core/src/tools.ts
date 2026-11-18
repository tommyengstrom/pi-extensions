import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const SUBAGENT_TOOLS = [
  "subagent",
  "subagent_query",
  "subagent_wait",
  "subagent_cancel",
  "subagent_steer",
] as const;
export type Operation = "launch" | "query" | "wait" | "cancel" | "steer";
export type OperationHandler = (
  operation: Operation,
  input: Record<string, unknown>,
  ctx: ExtensionContext,
  signal?: AbortSignal,
) => Promise<unknown>;
export function toolResult(value: unknown) {
  const text = JSON.stringify(value);
  return {
    content: [
      {
        type: "text" as const,
        text:
          text.length > 48_000 ? `${text.slice(0, 48_000)}\n[Truncated; inspect the retained result reference.]` : text,
      },
    ],
    details: value,
  };
}
/** The model cannot supply cwd/model/policy/parent IDs or choose a different authority. */
export function registerSubagentTools(pi: ExtensionAPI, perform: OperationHandler): void {
  const id = Type.String({ minLength: 36, maxLength: 36 });
  pi.registerTool({
    name: "subagent",
    label: "Delegate task",
    description:
      "Launch a bounded Core-backed task with inherited capabilities and exact parent model. Returns acknowledgement, not completion. Continue independent work, then use subagent_wait at a dependency. Additional provider usage applies.",
    parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 32000 }) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      return toolResult(await perform("launch", params, ctx, signal));
    },
  });
  pi.registerTool({
    name: "subagent_query",
    label: "Query subagents",
    description:
      "Read the descendant tree, job status, or a retained result. Never launches, steers, cancels or resumes work. Status/list does not consume pending results.",
    parameters: Type.Object(
      {
        action: Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("result")]),
        id: Type.Optional(id),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      return toolResult(await perform("query", params, ctx, signal));
    },
  });
  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for subagent",
    description:
      "Wait at a real dependency for one descendant result, up to the bounded timeout. Does not restart or retry. A cancelled wait does not grant a new job budget.",
    parameters: Type.Object(
      { id, timeout: Type.Optional(Type.Integer({ minimum: 0, maximum: 600000 })) },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      return toolResult(await perform("wait", params, ctx, signal));
    },
  });
  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel subagent subtree",
    description:
      "Request cancellation of an owned descendant and its entire subtree. Distinguishes confirmed termination from uncertainty; retains transcripts and terminal history.",
    parameters: Type.Object({ id }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      return toolResult(await perform("cancel", params, ctx, signal));
    },
  });
  pi.registerTool({
    name: "subagent_steer",
    label: "Steer subagent",
    description:
      "Queue plain task guidance at a safe boundary. Cannot execute slash commands, change policy, imply approval, reset budgets or resume a finished job.",
    parameters: Type.Object(
      { id, text: Type.String({ minLength: 1, maxLength: 16000 }) },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      return toolResult(await perform("steer", params, ctx, signal));
    },
  });
}
