import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readSync, renameSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type PlanArtifacts, validPlanArtifacts } from "./artifacts.js";
import { normalizePlanModeCompletion, PLAN_MODE_MAX_CHARS } from "./completion-tool.js";

export interface PlanDocument {
  id: string;
  name: string;
  path: string;
  title: string;
  artifacts?: PlanArtifacts;
}
export function planHash(plan: string): string {
  return createHash("sha256").update(plan).digest("hex");
}
export type PlanStorage = { kind: "repo" } | { kind: "legacy"; plansDirectory: string };
export function validPlanStorage(value: unknown): value is PlanStorage {
  if (!record(value)) return false;
  if (value.kind === "repo") return true;
  if (value.kind !== "legacy" || typeof value.plansDirectory !== "string") return false;
  try {
    planDirectoryComponents(value.plansDirectory);
    return true;
  } catch {
    return false;
  }
}
export function storedPlanStorage(value: { storage?: PlanStorage; plansDirectory?: string }): PlanStorage {
  return value.storage ?? { kind: "legacy", plansDirectory: value.plansDirectory ?? "plans" };
}
export function validPlanDocument(value: unknown): value is PlanDocument {
  return (
    record(value) &&
    typeof value.id === "string" &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id) &&
    validName(value.name) &&
    typeof value.path === "string" &&
    isAbsolute(value.path) &&
    value.path.length <= 8192 &&
    typeof value.title === "string" &&
    value.title.length <= PLAN_MODE_MAX_CHARS &&
    (value.artifacts === undefined || validPlanArtifacts(value.artifacts))
  );
}
export interface PlanStore {
  storage: PlanStorage;
  directory: string;
  projectRoot: string;
  list(): Promise<PlanDocument[]>;
  read(document: PlanDocument): Promise<string>;
  save(
    plan: string,
    options?: {
      name?: string;
      document?: PlanDocument;
      expectedHash?: string;
      artifacts?: PlanArtifacts;
      isCurrent?: () => boolean;
      signal?: AbortSignal;
    },
  ): Promise<PlanDocument>;
}
const execFileAsync = promisify(execFile);
const MAX_PLAN_BYTES = PLAN_MODE_MAX_CHARS * 3 + 32_768;
const PREFIX = "<!-- pi-plan-document-v3:";
class InvalidPlanFile extends Error {}
interface Envelope {
  version: 3;
  id: string;
  name: string;
  projectRoot: string;
  artifacts?: PlanArtifacts;
}
function validName(name: unknown): name is string {
  return typeof name === "string" && name.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}
function body(plan: string) {
  const normalized = normalizePlanModeCompletion({ plan });
  if (!normalized.ok) throw new InvalidPlanFile(normalized.error);
  if (/^<!-- pi-plan-(?:document|revision)-v\d+:/.test(normalized.plan))
    throw new InvalidPlanFile("Reserved metadata cannot be supplied as plan body text.");
  return normalized.plan;
}
function decode(raw: string): { metadata: Envelope; plan: string } {
  if (!raw.startsWith(PREFIX)) throw new InvalidPlanFile("Not a v3 plan document. Import Markdown explicitly.");
  const end = raw.indexOf(" -->\n");
  if (end < 0 || end > 32_768) throw new InvalidPlanFile("Invalid plan metadata.");
  let metadata: unknown;
  try {
    metadata = JSON.parse(Buffer.from(raw.slice(PREFIX.length, end), "base64").toString("utf8"));
  } catch {
    throw new InvalidPlanFile("Invalid plan metadata.");
  }
  if (
    !record(metadata) ||
    metadata.version !== 3 ||
    typeof metadata.projectRoot !== "string" ||
    !isAbsolute(metadata.projectRoot) ||
    !validPlanDocument({ ...metadata, path: "/placeholder.md", title: "" }) ||
    Object.keys(metadata).some((key) => !["version", "id", "name", "projectRoot", "artifacts"].includes(key))
  )
    throw new InvalidPlanFile("Invalid plan identity metadata.");
  return { metadata: metadata as unknown as Envelope, plan: body(raw.slice(end + 5)) };
}

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
  const projectKey = `${slug(basename(projectRoot))}-${planHash(projectRoot)}`;
  if (!options.existingOnly) await mkdir(resolve(agentDir), { recursive: true, mode: 0o700 });
  const anchor = await realpath(resolve(agentDir));
  // Preserve the configured layout: same-basename checkouts share the repo directory.
  // Document IDs and exact store paths prevent unrelated-name replacement.
  const segments = ["pi-plan-mode", ...components, storage.kind === "repo" ? slug(basename(projectRoot)) : projectKey];
  const directory = join(anchor, ...segments);
  const directories = [anchor];
  let cursor = anchor;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    if (!options.existingOnly) {
      try {
        await mkdir(cursor, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
    }
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Plan storage directories must not be symlinks.");
    directories.push(cursor);
  }
  const identities = directories.map((path) => ({ path, stat: lstatSync(path) }));
  function checkDirectory() {
    for (const { path, stat } of identities) {
      const now = lstatSync(path);
      if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== stat.dev || now.ino !== stat.ino)
        throw new Error("Plan storage directory changed or became a symlink.");
    }
  }
  function checkCurrent(saveOptions: NonNullable<Parameters<PlanStore["save"]>[1]>) {
    saveOptions.signal?.throwIfAborted();
    if (saveOptions.isCurrent?.() === false) throw new DOMException("Plan save cancelled", "AbortError");
    saveOptions.signal?.throwIfAborted();
    checkDirectory();
  }
  function checkDocument(document: PlanDocument) {
    if (!validPlanDocument(document) || document.path !== join(directory, `${document.name}.md`))
      throw new Error("Plan document does not belong to this store.");
    checkDirectory();
  }
  function decodedDocument(raw: string, path: string) {
    const decoded = decode(raw);
    const document: PlanDocument = {
      id: decoded.metadata.id,
      name: decoded.metadata.name,
      path,
      title: planTitle(decoded.plan),
      ...(decoded.metadata.artifacts ? { artifacts: decoded.metadata.artifacts } : {}),
    };
    if (path !== join(directory, `${document.name}.md`))
      throw new InvalidPlanFile("Plan filename and identity disagree.");
    return { ...decoded, document };
  }
  async function inspect(document: PlanDocument) {
    checkDocument(document);
    const raw = await readRaw(document.path);
    const decoded = decodedDocument(raw, document.path);
    if (decoded.document.id !== document.id) throw new Error("Plan identity changed.");
    if (JSON.stringify(decoded.document.artifacts) !== JSON.stringify(document.artifacts))
      throw new Error("Plan artifact metadata changed outside the workflow.");
    return { ...decoded, raw };
  }
  async function read(document: PlanDocument) {
    return (await inspect(document)).plan;
  }
  async function list() {
    checkDirectory();
    const documents: PlanDocument[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || !validName(entry.name.slice(0, -3))) continue;
      const path = join(directory, entry.name);
      try {
        documents.push(decodedDocument(await readRaw(path), path).document);
      } catch (error) {
        if (!(error instanceof InvalidPlanFile) && !hasCode(error, "ENOENT") && !hasCode(error, "ELOOP")) throw error;
      }
    }
    return documents.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function save(plan: string, saveOptions: Parameters<PlanStore["save"]>[1] = {}) {
    const content = body(plan);
    const existing = saveOptions.document;
    if (existing) {
      checkDocument(existing);
      if (!/^[a-f0-9]{64}$/.test(saveOptions.expectedHash ?? ""))
        throw new Error("Updating a plan requires the hash of the last read contents.");
      if (saveOptions.name !== undefined && saveOptions.name !== existing.name)
        throw new Error("A mutable plan cannot change its name or path.");
    } else if (saveOptions.name !== undefined && (!validName(saveOptions.name) || saveOptions.name.length > 64)) {
      throw new Error("Invalid short plan name.");
    }
    const artifacts = saveOptions.artifacts ?? existing?.artifacts;
    if (artifacts !== undefined && !validPlanArtifacts(artifacts)) throw new Error("Invalid plan artifact metadata.");
    const publish = async (): Promise<PlanDocument> => {
      checkCurrent(saveOptions);
      const previous = existing ? await inspect(existing) : undefined;
      if (previous && planHash(previous.plan) !== saveOptions.expectedHash)
        throw new Error("Plan changed on disk. Read and reconcile the current file before saving.");
      const id = existing?.id ?? randomUUID();
      const baseName = existing?.name ?? saveOptions.name ?? slug(planTitle(content)).slice(0, 64).replace(/-+$/, "");
      if (!baseName) throw new Error("Missing plan name.");
      for (let suffix = 1; suffix <= 100_000; suffix++) {
        const name = existing || suffix === 1 ? baseName : `${baseName}-${suffix}`;
        const path = join(directory, `${name}.md`);
        const metadata: Envelope = { version: 3, id, name, projectRoot, ...(artifacts ? { artifacts } : {}) };
        const header = `${PREFIX}${Buffer.from(JSON.stringify(metadata)).toString("base64")} -->\n`;
        if (header.length > 32_768) throw new Error("Plan metadata exceeds 32768 bytes.");
        const raw = header + content;
        const temporaryPath = join(directory, `.plan-${randomUUID()}.tmp`);
        checkCurrent(saveOptions);
        const file = await open(temporaryPath, "wx", 0o600);
        try {
          try {
            await file.writeFile(raw, "utf8");
            await file.sync();
          } finally {
            await file.close();
          }
          checkCurrent(saveOptions);
          if (existing) {
            // Compare immediately before atomic publication; no await separates the
            // ownership/content checks and commit. This is not a hostile-process CAS.
            if (readRawSync(path) !== previous?.raw) throw new Error("Plan changed during save; no update published.");
            renameSync(temporaryPath, path);
          } else {
            linkSync(temporaryPath, path);
          }
          return {
            id,
            name,
            path,
            title: planTitle(content),
            ...(artifacts ? { artifacts: structuredClone(artifacts) } : {}),
          };
        } catch (error) {
          if (existing || !hasCode(error, "EEXIST")) throw error;
        } finally {
          await unlink(temporaryPath).catch(() => {});
        }
      }
      throw new Error("Plan filename collision limit reached.");
    };
    return existing ? withFileMutationQueue(existing.path, publish) : publish();
  }
  return { storage, directory, projectRoot, list, read, save };
}

async function findProjectRoot(cwd: string) {
  const canonical = await realpath(resolve(cwd));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    const { stdout } = await execFileAsync("git", ["-C", canonical, "rev-parse", "--show-toplevel"], {
      env,
      timeout: 5000,
    });
    return await realpath(stdout.replace(/\r?\n$/, ""));
  } catch {
    return canonical;
  }
}
export function planDirectoryComponents(value: string): string[] {
  if (!value.trim() || isAbsolute(value) || value.includes("\\") || value.includes("\0"))
    throw new Error("Plans directory must be relative to the extension data directory.");
  const components = value.split("/");
  if (components.some((part) => !part || part === "." || part === ".."))
    throw new Error("Plans directory must not escape the extension data directory.");
  return components;
}
async function readRaw(path: string) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new InvalidPlanFile("Plan must be a regular file, not a symlink.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_PLAN_BYTES) throw new InvalidPlanFile("Invalid or oversized plan file.");
    const buffer = Buffer.alloc(MAX_PLAN_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return decodeUtf8(buffer.subarray(0, length));
  } finally {
    await file.close();
  }
}
function readRawSync(path: string) {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new InvalidPlanFile("Unsafe plan target.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PLAN_BYTES) throw new InvalidPlanFile("Invalid or oversized plan file.");
    const buffer = Buffer.alloc(MAX_PLAN_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    return decodeUtf8(buffer.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}
function decodeUtf8(bytes: Buffer) {
  if (bytes.length > MAX_PLAN_BYTES) throw new InvalidPlanFile("Plan file is too large.");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new InvalidPlanFile("Plan file is not valid UTF-8.");
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
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}
