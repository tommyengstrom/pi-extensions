import { isAbsolute } from "node:path";
import { stripVTControlCharacters } from "node:util";

export const ARTIFACT_TOOLS = [
  "artifact_create",
  "artifact_update",
  "artifact_status",
  "artifact_wait",
  "artifact_cancel",
] as const;
export const REFERENCE_ENTRY = "pi-artifacts-reference-v1";
export const SERVICE_EVENT = "pi-artifacts-service-v1";
export const STATES = ["queued", "running", "succeeded", "failed", "cancelled", "interrupted"] as const;
export type JobStatus = (typeof STATES)[number];
export interface ArtifactReference {
  version: 1;
  artifactId: string;
  jobId: string;
  directory: string;
  paths: string[];
  status: JobStatus;
}
export function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
export function identifier(v: unknown): v is string {
  return typeof v === "string" && /^[a-f0-9-]{36}$/.test(v);
}
export function validReference(v: unknown): v is ArtifactReference {
  return (
    record(v) &&
    v.version === 1 &&
    identifier(v.artifactId) &&
    identifier(v.jobId) &&
    typeof v.directory === "string" &&
    isAbsolute(v.directory) &&
    v.directory.length <= 4096 &&
    Array.isArray(v.paths) &&
    v.paths.length <= 1024 &&
    v.paths.every((p) => typeof p === "string" && p.length <= 8192 && isAbsolute(p)) &&
    STATES.includes(v.status as JobStatus)
  );
}
export function pending(status: JobStatus): boolean {
  return status === "queued" || status === "running";
}
/** Bound and remove control sequences before any terminal or RPC display. */
export function diagnostic(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return stripVTControlCharacters(text)
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" || character === "\t" ? character : ""))
    .slice(0, 2000);
}
