import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Versioned wire contract, deliberately not an import from another extension.
export const ARTIFACT_TOOLS = [
  "artifact_create",
  "artifact_update",
  "artifact_status",
  "artifact_wait",
  "artifact_cancel",
];
export const ARTIFACT_ENTRY = "pi-artifacts-reference-v1";
export interface ArtifactReference {
  version: 1;
  artifactId: string;
  jobId: string;
  directory: string;
  paths: string[];
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
}
export interface PlanArtifacts {
  version: 1;
  workspace: { id: string; directory: string };
  references: ArtifactReference[];
  omittedJobIds?: string[];
}
function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function id(v: unknown): v is string {
  return typeof v === "string" && /^[a-f0-9-]{36}$/.test(v);
}
export function validArtifactReference(v: unknown): v is ArtifactReference {
  return (
    record(v) &&
    v.version === 1 &&
    id(v.artifactId) &&
    id(v.jobId) &&
    typeof v.directory === "string" &&
    isAbsolute(v.directory) &&
    v.directory.length <= 4096 &&
    Array.isArray(v.paths) &&
    v.paths.length <= 1024 &&
    v.paths.every((p) => typeof p === "string" && isAbsolute(p) && p.length <= 8192) &&
    ["queued", "running", "succeeded", "failed", "cancelled", "interrupted"].includes(String(v.status))
  );
}
export function validPlanArtifacts(v: unknown): v is PlanArtifacts {
  return (
    record(v) &&
    v.version === 1 &&
    record(v.workspace) &&
    id(v.workspace.id) &&
    typeof v.workspace.directory === "string" &&
    isAbsolute(v.workspace.directory) &&
    Array.isArray(v.references) &&
    v.references.length <= 100 &&
    v.references.every(validArtifactReference) &&
    (v.omittedJobIds === undefined || (Array.isArray(v.omittedJobIds) && v.omittedJobIds.every(id)))
  );
}
function projectedCanonical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) throw new Error("Artifact destination cannot be resolved.");
  return join(projectedCanonical(parent), basename(absolute));
}
export function artifactScope(
  artifacts: PlanArtifacts | undefined,
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): string | undefined {
  if (!ARTIFACT_TOOLS.includes(name)) return;
  if (!artifacts) return "This workflow has no artifact workspace. Exit and re-enter Plan mode.";
  if (name === "artifact_create") {
    if (artifacts.references.length >= 100) return "This workflow has reached its 100-artifact limit.";
    if (typeof input.directory !== "string") return "Invalid artifact directory.";
    const suffix = relative(
      projectedCanonical(artifacts.workspace.directory),
      projectedCanonical(resolve(cwd, input.directory)),
    );
    if (!suffix || isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`))
      return "Plan artifacts must be created in a new/empty child directory of the current artifact workspace.";
  } else if (name === "artifact_update") {
    if (!artifacts.references.some((r) => r.artifactId === input.artifactId))
      return "Artifact is not associated with this plan.";
  } else {
    const ids = name === "artifact_wait" ? input.jobIds : [input.jobId];
    if (!Array.isArray(ids) || !ids.length || !ids.every((id) => artifacts.references.some((r) => r.jobId === id)))
      return "Job is not associated with this plan.";
  }
}
export function associate(artifacts: PlanArtifacts, reference: ArtifactReference): PlanArtifacts {
  const known = artifacts.references.find((r) => r.artifactId === reference.artifactId);
  if (!known && artifactScope(artifacts, "artifact_create", { directory: reference.directory }, "/")) return artifacts;
  if (known && known.directory !== reference.directory) throw new Error("Artifact reference directory changed.");
  const { version, artifactId, jobId, directory, paths, status } = reference;
  return {
    ...artifacts,
    references: [
      ...artifacts.references.filter((r) => r.artifactId !== reference.artifactId),
      { version, artifactId, jobId, directory, paths, status },
    ],
  };
}
export function artifactGuidance(artifacts?: PlanArtifacts): string {
  if (!artifacts) return "";
  return `\n\nArtifact workspace: ${JSON.stringify(artifacts.workspace.directory)}. Create in a new or empty child directory, not the workspace itself.\nLive artifacts (references point to current files, not snapshots):\n${artifacts.references.map((r) => `${r.artifactId} · job ${r.jobId} · ${r.status} · ${JSON.stringify(r.directory)}\n${r.paths.map((p) => JSON.stringify(p)).join("\n")}`).join("\n")}`;
}
export function artifactRequest(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  action: "status" | "cancel",
  jobIds: string[],
): Promise<ArtifactReference[]> {
  if (!jobIds.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error("Artifact extension unavailable. Load pi-artifacts alongside Plan mode; no ready plan was saved."),
        ),
      2000,
    );
    pi.events.emit("pi-artifacts-service-v1", {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      action,
      jobIds,
      respond(value: unknown) {
        clearTimeout(timeout);
        if (!record(value) || value.error)
          reject(new Error(record(value) ? String(value.error) : "Invalid artifact service response."));
        else if (action === "cancel") resolve([]);
        else if (Array.isArray(value.jobs) && value.jobs.every(validArtifactReference))
          resolve(
            value.jobs.map(({ version, artifactId, jobId, directory, paths, status }) => ({
              version,
              artifactId,
              jobId,
              directory,
              paths: [...paths],
              status,
            })),
          );
        else reject(new Error("Invalid artifact status response."));
      },
    });
  });
}
export function collectArtifactReferences(ctx: ExtensionContext, artifacts?: PlanArtifacts): PlanArtifacts | undefined {
  if (!artifacts) return artifacts;
  let result = artifacts;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === ARTIFACT_ENTRY && validArtifactReference(entry.data))
      result = associate(result, entry.data);
  }
  return result;
}
export class ArtifactNotReady extends Error {
  constructor(
    message: string,
    readonly artifacts: PlanArtifacts,
  ) {
    super(message);
  }
}
export async function artifactReadiness(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  artifacts?: PlanArtifacts,
): Promise<PlanArtifacts | undefined> {
  if (!artifacts?.references.length) return artifacts;
  const references = await artifactRequest(
    pi,
    ctx,
    "status",
    artifacts.references.map((r) => r.jobId),
  );
  const pending = references.filter((r) => r.status === "queued" || r.status === "running");
  if (pending.length)
    throw new ArtifactNotReady(
      `Artifact jobs still pending: ${pending.map((r) => r.jobId).join(", ")}. Continue independent planning, then use artifact_wait before completing the plan. No plan was saved.`,
      { ...artifacts, references },
    );
  const unresolved = references.filter((r) => r.status !== "succeeded" && !artifacts.omittedJobIds?.includes(r.jobId));
  if (unresolved.length)
    throw new ArtifactNotReady(
      `Artifact jobs did not succeed: ${unresolved.map((r) => `${r.jobId} (${r.status})`).join(", ")}. Retry with artifact_update, or ask the user to run /plan artifacts omit <jobId> to agree to omission. Partial output is not a successful prototype.`,
      { ...artifacts, references },
    );
  return { ...artifacts, references };
}
