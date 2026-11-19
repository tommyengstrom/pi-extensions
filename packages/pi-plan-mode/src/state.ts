import { type PlanArtifacts, validPlanArtifacts } from "./artifacts.js";
import { type PlanDocument, type PlanStorage, validPlanDocument, validPlanStorage } from "./plan-store.js";
import { MAX_PLAN_MODE_INSTRUCTIONS_BYTES } from "./planning-instructions.js";
import { BUILTIN_PLAN_TEMPLATES, DEFAULT_PLAN_TEMPLATE, validTemplateName } from "./templates.js";

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
  template: string;
  templatePrompt: string;
  tools?: string[];
  artifacts?: PlanArtifacts;
}
export interface ExplainSession {
  version: 1;
  id: string;
  tools?: string[];
  prompt: string;
}
export type PlanState =
  | { kind: "idle" }
  | { kind: "explain"; restriction: ExplainSession }
  | { kind: "planning"; workflow: PlanWorkflow }
  | { kind: "ready"; workflow: PlanWorkflow; document: PlanDocument };

export function isPlanning(state: PlanState): state is Extract<PlanState, { workflow: PlanWorkflow }> {
  return state.kind === "planning" || state.kind === "ready";
}
export function isRestricted(state: PlanState): state is Exclude<PlanState, { kind: "idle" }> {
  return state.kind !== "idle";
}
export function restrictedSession(state: Exclude<PlanState, { kind: "idle" }>): PlanWorkflow | ExplainSession {
  return state.kind === "explain" ? state.restriction : state.workflow;
}

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
    value.kind !== "explain" &&
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
  if (record(value) && value.kind === "explain") {
    const restriction = value.restriction;
    if (
      !record(restriction) ||
      restriction.version !== 1 ||
      !text(restriction.id) ||
      (restriction.tools !== undefined && !names(restriction.tools)) ||
      typeof restriction.prompt !== "string" ||
      !restriction.prompt.trim() ||
      Buffer.byteLength(restriction.prompt) > MAX_PLAN_MODE_INSTRUCTIONS_BYTES
    )
      throw new Error("Invalid Explain session state. No files were changed.");
    return {
      kind: "explain",
      restriction: {
        version: 1,
        id: restriction.id,
        ...(restriction.tools !== undefined ? { tools: [...restriction.tools] } : {}),
        prompt: restriction.prompt,
      },
    };
  }
  if (!record(value) || !["planning", "ready"].includes(String(value.kind)) || !validWorkflow(value.workflow))
    throw new Error("Invalid v3 Plan workflow state. No files were changed.");
  const workflow: PlanWorkflow & { basePrompt?: unknown; previousTools?: unknown } = structuredClone(value.workflow);
  delete workflow.basePrompt;
  delete workflow.previousTools;
  workflow.template ??= DEFAULT_PLAN_TEMPLATE.id;
  workflow.templatePrompt ??=
    BUILTIN_PLAN_TEMPLATES.find((candidate) => candidate.id === workflow.template)?.content ??
    DEFAULT_PLAN_TEMPLATE.content;
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
    (value.template !== undefined && !validTemplateName(value.template)) ||
    (value.templatePrompt !== undefined &&
      (typeof value.templatePrompt !== "string" ||
        !value.templatePrompt.trim() ||
        Buffer.byteLength(value.templatePrompt) > MAX_PLAN_MODE_INSTRUCTIONS_BYTES)) ||
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
