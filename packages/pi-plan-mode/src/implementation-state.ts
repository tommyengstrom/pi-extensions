import { randomUUID } from "node:crypto";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { type PlanRevision, type PlanStorage, planHash, validPlanStorage } from "./plan-store.js";
import { validRevision } from "./state.js";

export const IMPLEMENTATION_ENTRY = "pi-plan-implementation";
export const INPUT_ENTRY = "pi-plan-input";
export const VERIFICATION_MESSAGE = "pi-plan-verification";
export const IMPLEMENTATION_HELPERS = [
  "plan_mode_update",
  "plan_mode_implementation_complete",
  "plan_mode_implementation_status",
] as const;
export interface PlanSnapshot {
  revision: PlanRevision;
  plan: string;
  hash: string;
}
export interface ToolIdentity {
  name: string;
  source: string;
  path: string;
  exposure: ToolInfo["exposure"];
}
export interface ImplementationState {
  version: 1;
  id: string;
  phase: "implementing" | "completed" | "detached";
  projectRoot: string;
  plansDirectory?: string;
  storage?: PlanStorage;
  previousTools: string[];
  tools?: string[];
  toolIdentities: ToolIdentity[];
  revisions: PlanSnapshot[];
  completion?: string;
  lastCheck?: { status: string; timestamp: string; revisionHash: string };
}
export function snapshot(revision: PlanRevision, plan: string): PlanSnapshot {
  return { revision, plan, hash: planHash(plan) };
}
export function createImplementation(
  input: Omit<ImplementationState, "version" | "id" | "phase" | "revisions">,
  baseline: PlanSnapshot,
): ImplementationState {
  return { ...input, version: 1, id: randomUUID(), phase: "implementing", revisions: [baseline] };
}
export function restoreImplementation(entries: readonly unknown[]): ImplementationState | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!record(entry) || entry.type !== "custom" || entry.customType !== IMPLEMENTATION_ENTRY) continue;
    const state = entry.data;
    if (
      !record(state) ||
      state.version !== 1 ||
      typeof state.id !== "string" ||
      !["implementing", "completed", "detached"].includes(String(state.phase)) ||
      typeof state.projectRoot !== "string" ||
      !validPlanStorage(state.storage ?? { kind: "legacy", plansDirectory: state.plansDirectory }) ||
      !names(state.previousTools) ||
      (state.completion !== undefined && typeof state.completion !== "string") ||
      (state.lastCheck !== undefined &&
        (!record(state.lastCheck) ||
          !["adherent", "deviations_found", "inconclusive", "failed"].includes(String(state.lastCheck.status)) ||
          typeof state.lastCheck.timestamp !== "string" ||
          typeof state.lastCheck.revisionHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(state.lastCheck.revisionHash))) ||
      (state.tools !== undefined && !names(state.tools)) ||
      !Array.isArray(state.toolIdentities) ||
      !state.toolIdentities.every(
        (tool) =>
          record(tool) &&
          typeof tool.name === "string" &&
          typeof tool.source === "string" &&
          typeof tool.path === "string" &&
          ["direct", "model-only", "codemode", "deferred", "hidden"].includes(String(tool.exposure)),
      ) ||
      !Array.isArray(state.revisions) ||
      !state.revisions.length ||
      !state.revisions.every(
        (item) =>
          record(item) &&
          validRevision(item.revision) &&
          typeof item.plan === "string" &&
          item.plan.trim().length > 0 &&
          item.plan.length <= 50_000 &&
          typeof item.hash === "string" &&
          planHash(item.plan) === item.hash,
      )
    )
      return undefined;
    return structuredClone(state) as unknown as ImplementationState;
  }
  return undefined;
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function names(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((name) => typeof name === "string");
}
