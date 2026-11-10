import { randomUUID } from "node:crypto";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
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
export interface ToolIdentity {
  name: string;
  source: string;
  path: string;
  exposure: ToolInfo["exposure"];
}
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
  previousTools: string[];
  tools?: string[];
  toolIdentities: ToolIdentity[];
  completion?: string;
  lastCheck?: { status: string; timestamp: string; hash: string };
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
    !names(state.previousTools) ||
    (state.tools !== undefined && !names(state.tools)) ||
    (state.completion !== undefined && typeof state.completion !== "string") ||
    (state.lastCheck !== undefined &&
      (!record(state.lastCheck) ||
        !["ok", "minor_issues", "issues", "failed", "cancelled"].includes(String(state.lastCheck.status)) ||
        typeof state.lastCheck.timestamp !== "string" ||
        !hash(state.lastCheck.hash))) ||
    !Array.isArray(state.toolIdentities) ||
    state.toolIdentities.length > 1000 ||
    !state.toolIdentities.every(
      (tool) =>
        record(tool) &&
        typeof tool.name === "string" &&
        typeof tool.source === "string" &&
        typeof tool.path === "string" &&
        ["direct", "model-only", "codemode", "deferred", "hidden"].includes(String(tool.exposure)),
    ) ||
    "revisions" in state ||
    "plan" in state
  )
    throw new Error("Invalid v3 implementation state. No files were changed.");
  return structuredClone(state) as unknown as ImplementationState;
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function names(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 1000 &&
    value.every((name) => typeof name === "string" && name.length > 0 && name.length <= 4096)
  );
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
