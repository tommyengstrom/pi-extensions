import { type PlanArtifacts, validPlanArtifacts } from "./artifacts.js";
import { type PlanDocument, type PlanStorage, validPlanDocument, validPlanStorage } from "./plan-store.js";
import { MAX_PLAN_MODE_INSTRUCTIONS_BYTES } from "./planning-instructions.js";
import { DEFAULT_PLAN_MODE_PROMPT } from "./prompt.js";

export const PLAN_STATE_ENTRY = "pi-plan-state";
export interface PlanWorkflow {
  version: 3;
  id: string;
  name?: string;
  /** Initial task only; naming must never derive input from subsequent history. */
  task?: string;
  document?: PlanDocument;
  hash?: string;
  projectRoot: string;
  plansDirectory?: string;
  storage?: PlanStorage;
  instructions: string;
  basePrompt?: string;
  previousTools: string[];
  tools?: string[];
  artifacts?: PlanArtifacts;
}
export type PlanState =
  | { kind: "idle" }
  | { kind: "planning"; workflow: PlanWorkflow }
  | { kind: "ready"; workflow: PlanWorkflow; document: PlanDocument };

function latest(entries: readonly unknown[]) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (record(entry) && entry.type === "custom" && entry.customType === PLAN_STATE_ENTRY) return entry.data;
  }
  return undefined;
}
/** Inspect the latest branch-local state only. This function never mutates entries or files. */
export function legacyPlanState(entries: readonly unknown[]): boolean {
  const value = latest(entries);
  return (
    record(value) &&
    value.kind !== "idle" &&
    (!record(value.workflow) ||
      value.workflow.version !== 3 ||
      "revision" in value ||
      "series" in value.workflow ||
      "parent" in value.workflow)
  );
}
export function restorePlanState(entries: readonly unknown[]): PlanState {
  if (legacyPlanState(entries))
    throw new Error(
      "Legacy Plan workflow is unsupported. Import its Markdown explicitly into a new workflow; no files were changed.",
    );
  const value = latest(entries);
  if (value === undefined || (record(value) && value.kind === "idle")) return { kind: "idle" };
  if (!record(value) || !["planning", "ready"].includes(String(value.kind)) || !validWorkflow(value.workflow))
    throw new Error("Invalid v3 Plan workflow state. No files were changed.");
  const workflow: PlanWorkflow = structuredClone(value.workflow);
  workflow.basePrompt ??= DEFAULT_PLAN_MODE_PROMPT;
  if (value.kind === "planning") return { kind: "planning", workflow };
  if (
    !validPlanDocument(value.document) ||
    !workflow.document ||
    value.document.id !== workflow.document.id ||
    value.document.path !== workflow.document.path ||
    value.document.name !== workflow.name ||
    JSON.stringify(value.document) !== JSON.stringify(workflow.document) ||
    !workflow.hash
  )
    throw new Error("Invalid ready Plan document state. No files were changed.");
  return { kind: "ready", workflow, document: structuredClone(value.document) };
}
export { validPlanDocument };

function validWorkflow(value: unknown): value is PlanWorkflow {
  if (
    !record(value) ||
    value.version !== 3 ||
    !text(value.id) ||
    !text(value.projectRoot) ||
    !validPlanStorage(value.storage ?? { kind: "legacy", plansDirectory: value.plansDirectory }) ||
    typeof value.instructions !== "string" ||
    Buffer.byteLength(value.instructions) > MAX_PLAN_MODE_INSTRUCTIONS_BYTES ||
    (value.basePrompt !== undefined &&
      (typeof value.basePrompt !== "string" ||
        !value.basePrompt.trim() ||
        Buffer.byteLength(value.basePrompt) > MAX_PLAN_MODE_INSTRUCTIONS_BYTES)) ||
    !names(value.previousTools) ||
    (value.tools !== undefined && !names(value.tools)) ||
    (value.name !== undefined && !name(value.name)) ||
    (value.task !== undefined && (typeof value.task !== "string" || !value.task.trim() || value.task.length > 4000)) ||
    (value.hash !== undefined && (typeof value.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.hash))) ||
    (value.artifacts !== undefined && !validPlanArtifacts(value.artifacts)) ||
    "series" in value ||
    "parent" in value
  )
    return false;
  if (
    value.document !== undefined &&
    (!validPlanDocument(value.document) || value.name !== value.document.name || typeof value.hash !== "string")
  )
    return false;
  return value.document !== undefined || value.hash === undefined;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}
function name(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
function names(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 1000 && value.every(text);
}
