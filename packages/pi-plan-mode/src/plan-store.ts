import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, linkSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type PlanArtifacts, validPlanArtifacts } from "./artifacts.js";
import { normalizePlanModeCompletion, PLAN_MODE_MAX_CHARS } from "./completion-tool.js";

export interface RevisionHistory {
  version: 1;
  parent: { series: string; revision: number; hash: string };
  reason?: string;
}

export function planHash(plan: string): string {
  return createHash("sha256").update(plan).digest("hex");
}

export interface PlanRevision {
  series: string;
  revision: number;
  path: string;
  title: string;
  history?: RevisionHistory;
  artifacts?: PlanArtifacts;
}

/** Persisted location: legacy paths are scoped to the current canonical project. */
export type PlanStorage = { kind: "repo" } | { kind: "legacy"; plansDirectory: string };

export function validPlanStorage(value: unknown): value is PlanStorage {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  if (value.kind === "repo") return true;
  if (value.kind !== "legacy" || !("plansDirectory" in value) || typeof value.plansDirectory !== "string") return false;
  try {
    planDirectoryComponents(value.plansDirectory);
    return true;
  } catch {
    return false;
  }
}

/** Old session entries predate explicit storage locators. */
export function storedPlanStorage(value: { storage?: PlanStorage; plansDirectory?: string }): PlanStorage {
  return value.storage ?? { kind: "legacy", plansDirectory: value.plansDirectory ?? "plans" };
}

export interface PlanStore {
  storage: PlanStorage;
  directory: string;
  projectRoot: string;
  list(): Promise<PlanRevision[]>;
  read(revision: PlanRevision): Promise<string>;
  save(
    plan: string,
    options?: {
      series?: string;
      parent?: PlanRevision;
      parentPlan?: string;
      reason?: string;
      artifacts?: PlanArtifacts;
      isCurrent?: () => boolean;
      signal?: AbortSignal;
    },
  ): Promise<PlanRevision>;
}

const execFileAsync = promisify(execFile);
const SERIES_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SERIES_LENGTH = 120;
// UTF-8 needs at most three bytes per JavaScript UTF-16 code unit.
const MAX_PLAN_BYTES = PLAN_MODE_MAX_CHARS * 3 + 32_768;
const METADATA_PREFIX = "<!-- pi-plan-revision-v1:";

const ENVELOPE_PREFIX = "<!-- pi-plan-document-v2:";
function decodeDocument(document: string): { plan: string; history?: RevisionHistory; artifacts?: PlanArtifacts } {
  if (document.startsWith(ENVELOPE_PREFIX)) {
    const end = document.indexOf(" -->\n");
    if (end < 0 || end > 32_768) throw new InvalidPlanFile("Invalid document metadata.");
    let value: { version?: unknown; history?: RevisionHistory; artifacts?: PlanArtifacts };
    try {
      value = JSON.parse(Buffer.from(document.slice(ENVELOPE_PREFIX.length, end), "base64").toString("utf8"));
    } catch {
      throw new InvalidPlanFile("Invalid document metadata.");
    }
    if (value?.version !== 2 || (value.artifacts !== undefined && !validPlanArtifacts(value.artifacts)))
      throw new InvalidPlanFile("Invalid artifact metadata.");
    const decoded = value.history
      ? decodeDocument(
          `${METADATA_PREFIX}${Buffer.from(JSON.stringify(value.history)).toString("base64")} -->\n${document.slice(end + 5)}`,
        )
      : { plan: document.slice(end + 5) };
    return { ...decoded, ...(value.artifacts ? { artifacts: value.artifacts } : {}) };
  }
  if (!document.startsWith(METADATA_PREFIX)) return { plan: document };
  const end = document.indexOf(" -->\n");
  if (end < 0 || end > 32_768) throw new InvalidPlanFile("Invalid revision metadata.");
  let history: RevisionHistory;
  try {
    history = JSON.parse(Buffer.from(document.slice(METADATA_PREFIX.length, end), "base64").toString("utf8"));
    if (
      history.version !== 1 ||
      !history.parent ||
      !/^[a-f0-9]{64}$/.test(history.parent.hash) ||
      !Number.isSafeInteger(history.parent.revision) ||
      history.parent.revision < 1 ||
      (history.reason !== undefined &&
        (typeof history.reason !== "string" || !history.reason.trim() || history.reason.length > 8_000))
    )
      throw new Error();
    validateSeries(history.parent.series);
  } catch {
    throw new InvalidPlanFile("Invalid revision metadata.");
  }
  return { plan: document.slice(end + 5), history };
}

class InvalidPlanFile extends Error {}

export async function createPlanStore(
  cwd: string,
  location: PlanStorage | string = { kind: "repo" },
  agentDir = getAgentDir(),
  options: { existingOnly?: boolean } = {},
): Promise<PlanStore> {
  const storage: PlanStorage = typeof location === "string" ? { kind: "legacy", plansDirectory: location } : location;
  if (!validPlanStorage(storage)) throw new Error("Invalid plan storage directory location.");
  const components = storage.kind === "legacy" ? planDirectoryComponents(storage.plansDirectory) : [];
  const projectRoot = await findProjectRoot(cwd);
  const projectKey = `${slug(basename(projectRoot))}-${createHash("sha256").update(projectRoot).digest("hex")}`;
  if (!options.existingOnly) await mkdir(resolve(agentDir), { recursive: true, mode: 0o700 });
  // The caller's agent directory is the trusted anchor; symlinks beneath it are not.
  const anchor = await realpath(resolve(agentDir));
  const segments = ["pi-plan-mode", ...components, storage.kind === "repo" ? slug(basename(projectRoot)) : projectKey];
  const directory = join(anchor, ...segments);

  async function checkDirectory(create = false) {
    if ((await realpath(anchor)) !== anchor) throw new Error("Plan storage directory has moved.");
    let path = anchor;
    for (const segment of segments) {
      path = join(path, segment);
      if (create) {
        try {
          await mkdir(path, { mode: 0o700 });
        } catch (error: unknown) {
          if (!hasCode(error, "EEXIST")) throw error;
        }
      }
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Plan storage directories must be real directories, not symlinks.");
      }
    }
  }

  await checkDirectory(!options.existingOnly);

  function revisionPath(series: string, revision: number) {
    validateSeries(series);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid plan revision number.");
    return join(directory, `${series}-${String(revision).padStart(2, "0")}.md`);
  }

  async function read(revision: PlanRevision) {
    const expectedPath = revisionPath(revision.series, revision.revision);
    if (revision.path !== expectedPath) throw new Error("Plan revision does not belong to this store.");
    await checkDirectory();
    const document = await readPlanFile(expectedPath);
    if (JSON.stringify(document.artifacts) !== JSON.stringify(revision.artifacts))
      throw new Error("Plan artifact metadata has changed.");
    if (JSON.stringify(document.history) !== JSON.stringify(revision.history))
      throw new Error("Plan revision metadata has changed.");
    return document.plan;
  }

  async function list() {
    await checkDirectory();
    const revisions: PlanRevision[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const parsed = parseFilename(entry.name);
      if (!parsed || !entry.isFile()) continue;
      const path = join(directory, entry.name);
      try {
        const { plan, history, artifacts } = await readPlanFile(path);
        revisions.push({
          ...parsed,
          path,
          title: planTitle(plan),
          ...(history ? { history } : {}),
          ...(artifacts ? { artifacts } : {}),
        });
      } catch (error: unknown) {
        // A removed, malformed, oversized, or symlinked file is not a saved plan.
        if (!(error instanceof InvalidPlanFile) && !hasCode(error, "ENOENT") && !hasCode(error, "ELOOP")) throw error;
      }
    }
    return revisions.sort((a, b) => a.series.localeCompare(b.series) || b.revision - a.revision);
  }

  async function save(plan: string, options: Parameters<PlanStore["save"]>[1] = {}) {
    const normalized = normalizePlanModeCompletion({ plan });
    if (!normalized.ok) throw new Error(normalized.error);
    const content = normalized.plan;
    if (content.startsWith(METADATA_PREFIX) || content.startsWith(ENVELOPE_PREFIX))
      throw new Error("Plan body must not begin with reserved revision metadata.");
    const title = planTitle(content);
    let history: RevisionHistory | undefined;
    if (options.parent) {
      if (options.series !== options.parent.series) throw new Error("Revision parent must belong to the same series.");
      const parentPlan = options.parentPlan ?? (await read(options.parent));
      if (planHash(await read(options.parent)) !== planHash(parentPlan))
        throw new Error("Parent plan changed on disk.");
      const reason = options.reason?.trim();
      if (reason && reason.length > 8_000) throw new Error("Change reason exceeds 8000 characters.");
      history = {
        version: 1,
        parent: { series: options.parent.series, revision: options.parent.revision, hash: planHash(parentPlan) },
        ...(reason ? { reason } : {}),
      };
    }
    const artifacts = options.artifacts ?? options.parent?.artifacts;
    if (artifacts && !validPlanArtifacts(artifacts)) throw new Error("Invalid plan artifact metadata.");
    const header = artifacts?.references.length
      ? `${ENVELOPE_PREFIX}${Buffer.from(JSON.stringify({ version: 2, history, artifacts })).toString("base64")} -->\n`
      : history
        ? `${METADATA_PREFIX}${Buffer.from(JSON.stringify(history)).toString("base64")} -->\n`
        : "";
    if (header.length > 32_768) throw new Error("Revision metadata exceeds 32768 bytes.");
    const document = header + content;
    // Capture once per new series, not once per publication retry or revision.
    const now = new Date();
    const date = `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    // Reserve room for the date and the existing UUID collision suffix (37 chars).
    const baseSeries = storage.kind === "repo" ? `${date}-${slug(title).slice(0, 72).replace(/-+$/, "")}` : slug(title);
    if (options.series !== undefined) validateSeries(options.series);
    const checkCurrent = () => {
      if (options.signal?.aborted || options.isCurrent?.() === false) {
        throw new DOMException("Plan save cancelled", "AbortError");
      }
    };
    checkCurrent();
    await checkDirectory();
    checkCurrent();

    const temporaryPath = join(directory, `.plan-${randomUUID()}.tmp`);
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      try {
        checkCurrent();
        await file.writeFile(document, "utf8");
        await file.sync();
      } catch (error: unknown) {
        await file.close().catch(() => {});
        throw error;
      }
      await file.close();

      for (;;) {
        checkCurrent();
        await checkDirectory();
        const entries = await readdir(directory, { withFileTypes: true });
        const existing = entries.flatMap((entry) => {
          const parsed = parseFilename(entry.name);
          return parsed ? [{ ...parsed, regular: entry.isFile() }] : [];
        });
        let series = options.series ?? baseSeries;
        let revision = 1;
        if (options.series !== undefined) {
          const matches = existing.filter((entry) => entry.series === series);
          if (!matches.some((entry) => entry.regular)) throw new Error("Plan series does not belong to this store.");
          revision = matches.reduce((highest, entry) => Math.max(highest, entry.revision), 0) + 1;
        } else if (existing.some((entry) => entry.series === series)) {
          series = `${baseSeries}-${randomUUID()}`;
        }
        const path = revisionPath(series, revision);
        checkCurrent();
        try {
          // A hard link publishes the already closed, complete file without replacing
          // anything. The short synchronous syscall leaves no cancellation gap between
          // the ownership check and publication. EEXIST retries work across processes.
          linkSync(temporaryPath, path);
          return {
            series,
            revision,
            path,
            title,
            ...(history ? { history } : {}),
            ...(artifacts?.references.length ? { artifacts } : {}),
          };
        } catch (error: unknown) {
          if (!hasCode(error, "EEXIST")) throw error;
        }
      }
    } finally {
      // Publication is the commit point. Best-effort cleanup must neither hide a
      // published revision from the caller nor replace the original save error.
      await unlink(temporaryPath).catch(() => {});
    }
  }

  return { storage, directory, projectRoot, list, read, save };
}

async function findProjectRoot(cwd: string) {
  const canonicalCwd = await realpath(resolve(cwd));
  try {
    // Ambient Git overrides must not scope a cwd to some unrelated repository.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    const { stdout } = await execFileAsync("git", ["-C", canonicalCwd, "rev-parse", "--show-toplevel"], {
      env,
      timeout: 5_000,
    });
    return await realpath(stdout.replace(/\r?\n$/, ""));
  } catch {
    return canonicalCwd;
  }
}

/** Validate the shared settings/storage relative-directory contract without filesystem writes. */
export function planDirectoryComponents(value: string): string[] {
  if (!value.trim() || isAbsolute(value) || value.includes("\\") || value.includes("\0")) {
    throw new Error("Plans directory must be relative to the extension data directory.");
  }
  const components = value.split("/");
  if (components.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Plans directory must not escape the extension data directory.");
  }
  return components;
}

function validateSeries(series: string) {
  if (series.length > MAX_SERIES_LENGTH || !SERIES_PATTERN.test(series)) throw new Error("Invalid plan series.");
}

function parseFilename(name: string) {
  const match = /^(.*)-(\d{2,})\.md$/.exec(name);
  if (!match) return undefined;
  const [, series, digits] = match;
  const revision = Number(digits);
  if (
    series.length > MAX_SERIES_LENGTH ||
    !SERIES_PATTERN.test(series) ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    String(revision).padStart(2, "0") !== digits
  ) {
    return undefined;
  }
  return { series, revision };
}

async function readPlanFile(path: string) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new InvalidPlanFile("Plan files must be regular files, not symlinks.");
  // NOFOLLOW prevents substituting a symlink after discovery; NONBLOCK avoids
  // hanging on a substituted FIFO before fstat can reject non-regular files.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_PLAN_BYTES) throw new InvalidPlanFile("Invalid or oversized plan file.");
    const buffer = Buffer.alloc(MAX_PLAN_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_PLAN_BYTES) throw new InvalidPlanFile("Plan file is too large.");
    let plan: string;
    try {
      plan = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new InvalidPlanFile("Plan file is not valid UTF-8.");
    }
    const decoded = decodeDocument(plan);
    const normalized = normalizePlanModeCompletion({ plan: decoded.plan });
    if (!normalized.ok) throw new InvalidPlanFile(normalized.error);
    return { ...decoded, plan: normalized.plan };
  } finally {
    await file.close();
  }
}

function planTitle(plan: string) {
  const lines = plan.split(/\r?\n/);
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line)?.[1];
    if (heading) return heading.replace(/\s+#+\s*$/, "").trim();
    if (line.trim() && /^\s{0,3}(?:=+|-+)\s*$/.test(lines[index + 1] ?? "")) return line.trim();
  }
  return lines.find((line) => line.trim())?.trim() || "Untitled plan";
}

function slug(value: string) {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/-+$/, "") || "untitled-plan"
  );
}

function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}
