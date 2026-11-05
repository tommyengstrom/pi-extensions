import { type PlanRevision, type PlanStorage, validPlanStorage } from "./plan-store.js";
import { MAX_PLAN_MODE_INSTRUCTIONS_BYTES } from "./planning-instructions.js";
import { DEFAULT_PLAN_MODE_PROMPT } from "./prompt.js";

export const PLAN_STATE_ENTRY = "pi-plan-state";

export interface PlanWorkflow {
  projectRoot: string;
  /** Legacy session location; new workflows use storage. */
  plansDirectory?: string;
  storage?: PlanStorage;
  instructions: string;
  /** Captured base; absent only in legacy entries, which restore the built-in default. */
  basePrompt?: string;
  previousTools: string[];
  /** Undefined means canonical inspection tools, not arbitrary tools with those names. */
  tools?: string[];
  series?: string;
  parent?: PlanRevision;
}

export type PlanState =
  | { kind: "idle" }
  | { kind: "planning"; workflow: PlanWorkflow }
  | { kind: "ready"; workflow: PlanWorkflow; revision: PlanRevision };

/** Restore explicit state, including legacy storage locators; never infer it from assistant prose. */
export function restorePlanState(entries: readonly unknown[]): PlanState {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!record(entry) || entry.type !== "custom" || entry.customType !== PLAN_STATE_ENTRY) continue;
    const value = entry.data;
    if (!record(value) || value.kind === "idle") return { kind: "idle" };
    if (value.kind !== "planning" && value.kind !== "ready") return { kind: "idle" };
    const workflow = value.workflow;
    if (
      !record(workflow) ||
      !text(workflow.projectRoot) ||
      !validPlanStorage(workflow.storage ?? { kind: "legacy", plansDirectory: workflow.plansDirectory }) ||
      typeof workflow.instructions !== "string" ||
      Buffer.byteLength(workflow.instructions, "utf8") > MAX_PLAN_MODE_INSTRUCTIONS_BYTES ||
      (workflow.basePrompt !== undefined &&
        (typeof workflow.basePrompt !== "string" ||
          !workflow.basePrompt.trim() ||
          Buffer.byteLength(workflow.basePrompt, "utf8") > MAX_PLAN_MODE_INSTRUCTIONS_BYTES)) ||
      !names(workflow.previousTools) ||
      (workflow.tools !== undefined && !names(workflow.tools)) ||
      (workflow.series !== undefined && !text(workflow.series)) ||
      (workflow.parent !== undefined && !validRevision(workflow.parent))
    )
      return { kind: "idle" };
    const restored: PlanWorkflow = {
      projectRoot: workflow.projectRoot,
      ...(typeof workflow.plansDirectory === "string" ? { plansDirectory: workflow.plansDirectory } : {}),
      ...(validPlanStorage(workflow.storage) ? { storage: workflow.storage } : {}),
      instructions: workflow.instructions,
      basePrompt: workflow.basePrompt ?? DEFAULT_PLAN_MODE_PROMPT,
      previousTools: [...workflow.previousTools],
      ...(workflow.tools !== undefined ? { tools: [...workflow.tools] } : {}),
      ...(workflow.series !== undefined ? { series: workflow.series } : {}),
      ...(validRevision(workflow.parent) ? { parent: workflow.parent } : {}),
    };
    if (value.kind === "planning") return { kind: "planning", workflow: restored };
    const revision = value.revision;
    if (
      !validRevision(revision) ||
      !text(revision.series) ||
      !text(revision.path) ||
      typeof revision.title !== "string" ||
      revision.title.length > 50_000 ||
      typeof revision.revision !== "number" ||
      !Number.isSafeInteger(revision.revision) ||
      revision.revision < 1 ||
      restored.series !== revision.series
    )
      return { kind: "idle" };
    return {
      kind: "ready",
      workflow: restored,
      revision: {
        series: revision.series,
        revision: revision.revision,
        path: revision.path,
        title: revision.title,
        ...(validRevision(revision) && revision.history ? { history: revision.history } : {}),
      },
    };
  }
  return { kind: "idle" };
}

export function validRevision(value: unknown): value is PlanRevision {
  if (
    !record(value) ||
    !text(value.series) ||
    !text(value.path) ||
    typeof value.title !== "string" ||
    value.title.length > 50_000 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1
  )
    return false;
  if (value.history !== undefined) {
    const h = value.history;
    if (
      !record(h) ||
      h.version !== 1 ||
      !record(h.parent) ||
      !text(h.parent.series) ||
      !Number.isSafeInteger(h.parent.revision) ||
      (h.parent.revision as number) < 1 ||
      typeof h.parent.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(h.parent.hash) ||
      (h.reason !== undefined && (typeof h.reason !== "string" || !h.reason.trim() || h.reason.length > 8000))
    )
      return false;
  }
  return true;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}
function names(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 1000 && value.every(text);
}
