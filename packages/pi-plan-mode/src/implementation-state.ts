import { randomUUID } from "node:crypto";
import { type CompletionCheck, restoreChecks } from "./completion-checks.js";
import { type PlanDocument, type PlanStorage, planHash, validPlanDocument, validPlanStorage } from "./plan-store.js";

export const IMPLEMENTATION_ENTRY = "pi-plan-implementation";
export const INPUT_ENTRY = "pi-plan-input";
export const VERIFICATION_MESSAGE = "pi-plan-verification";
export const IMPLEMENTATION_HELPERS = [
  "plan_mode_update",
  "plan_mode_implementation_complete",
  "plan_mode_implementation_status",
  "plan_mode_edit",
] as const;
export interface ImplementationState {
  version: 3;
  id: string;
  phase: "implementing" | "completed" | "detached";
  document: PlanDocument;
  /** Last read/saved content fingerprint; never a cached plan or approval baseline. */
  hash: string;
  projectRoot: string;
  plansDirectory?: string;
  storage?: PlanStorage;
  completionChecks?: CompletionCheck[];
  completion?: string;
}
export function createImplementation(
  input: Omit<ImplementationState, "version" | "id" | "phase" | "document" | "hash">,
  document: PlanDocument,
  plan: string,
): ImplementationState {
  if (!validPlanDocument(document) || !plan.trim() || plan.length > 50_000 || !plan.isWellFormed())
    throw new Error("Implementation requires a valid saved plan and its reviewed contents.");
  return {
    ...structuredClone(input),
    version: 3,
    id: randomUUID(),
    phase: "implementing",
    document: structuredClone(document),
    hash: planHash(plan),
  };
}
function latest(entries: readonly unknown[]) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (record(entry) && entry.type === "custom" && entry.customType === IMPLEMENTATION_ENTRY) return entry.data;
  }
  return undefined;
}
export function legacyImplementationState(entries: readonly unknown[]): boolean {
  const value = latest(entries);
  return value !== null && value !== undefined && (!record(value) || value.version !== 3 || "revisions" in value);
}
export function restoreImplementation(entries: readonly unknown[]): ImplementationState | undefined {
  if (legacyImplementationState(entries))
    throw new Error(
      "Legacy implementation workflow is unsupported. Explicitly import its Markdown and review a new independent plan; no files were changed.",
    );
  const state = latest(entries);
  if (state === null || state === undefined) return undefined;
  if (
    !record(state) ||
    state.version !== 3 ||
    typeof state.id !== "string" ||
    !state.id ||
    !["implementing", "completed", "detached"].includes(String(state.phase)) ||
    typeof state.projectRoot !== "string" ||
    !state.projectRoot ||
    !validPlanStorage(state.storage ?? { kind: "legacy", plansDirectory: state.plansDirectory }) ||
    !validPlanDocument(state.document) ||
    !hash(state.hash) ||
    (state.completion !== undefined && typeof state.completion !== "string") ||
    "revisions" in state ||
    "plan" in state
  )
    throw new Error("Invalid v3 implementation state. No files were changed.");
  const restored = structuredClone(state);
  restoreChecks(restored);
  delete restored.previousTools;
  delete restored.lastCheck;
  delete restored.toolIdentities;
  delete restored.tools;
  return restored as unknown as ImplementationState;
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
