import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { planDirectoryComponents } from "./plan-store.js";

export interface PlanModeSettings {
  /** Relative paths are resolved from getAgentDir()/pi-plan-mode by plan storage. */
  plansDirectory: string;
  /** Omitted means canonical read-only built-ins; an empty list means helpers only. */
  tools?: string[];
}

const MAX_SETTINGS_BYTES = 64 * 1024;
const mutationQueues = new Map<string, Promise<void>>();
type SettingsDocument = Record<string, unknown>;

export function planModeSettingsPath(): string {
  return join(getAgentDir(), "pi-plan-mode.json");
}

export async function readPlanModeSettings(path = planModeSettingsPath()): Promise<PlanModeSettings> {
  const settingsPath = resolve(path);
  await mutationQueues.get(settingsPath);
  return parseSettings(await readDocument(settingsPath));
}

export async function updatePlanModeSettings(
  patch: { plansDirectory?: string; tools?: readonly string[] | null },
  options: { settingsPath?: string; signal?: AbortSignal } = {},
): Promise<PlanModeSettings> {
  const settingsPath = resolve(options.settingsPath ?? planModeSettingsPath());
  const { signal } = options;
  // Capture inputs before waiting behind another editor's update.
  const plansDirectory = patch.plansDirectory;
  const tools =
    patch.tools === undefined || patch.tools === null ? patch.tools : parseSettings({ tools: patch.tools }).tools;
  return enqueueMutation(settingsPath, async () => {
    signal?.throwIfAborted();
    const document = await readDocument(settingsPath);
    if (plansDirectory !== undefined) document.plansDirectory = plansDirectory;
    if (tools === null) delete document.tools;
    else if (tools !== undefined) document.tools = tools;
    const settings = parseSettings(document);
    // Persist normalized owned fields without dropping unrelated settings.
    document.plansDirectory = settings.plansDirectory;
    if (settings.tools !== undefined) document.tools = settings.tools;
    await publishSettings(settingsPath, document, signal);
    return settings;
  });
}

function parseSettings(value: unknown): PlanModeSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid pi-plan-mode settings: expected an object");
  }
  const document = value as SettingsDocument;
  const plansDirectory = Object.hasOwn(document, "plansDirectory") ? document.plansDirectory : "plans";
  if (typeof plansDirectory !== "string") {
    throw new Error("Invalid pi-plan-mode settings: plansDirectory must be a string");
  }
  try {
    planDirectoryComponents(plansDirectory);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid pi-plan-mode settings: plansDirectory: ${detail}`);
  }
  const settings: PlanModeSettings = { plansDirectory };
  if (Object.hasOwn(document, "tools")) {
    const tools = document.tools;
    if (!Array.isArray(tools) || !tools.every((name) => typeof name === "string" && name.trim().length > 0)) {
      throw new Error("Invalid pi-plan-mode settings: tools must be an array of nonempty names");
    }
    // Names are exact identifiers, not patterns or shell policy fragments.
    settings.tools = [...new Set(tools)];
  }
  return settings;
}

function enqueueMutation<T>(path: string, mutation: () => Promise<T>): Promise<T> {
  const result = (mutationQueues.get(path) ?? Promise.resolve()).then(mutation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  mutationQueues.set(path, settled);
  void settled.then(() => {
    if (mutationQueues.get(path) === settled) mutationQueues.delete(path);
  });
  return result;
}

async function readDocument(path: string): Promise<SettingsDocument> {
  let contents: string;
  try {
    contents = await readContents(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  let document: unknown;
  try {
    document = JSON.parse(contents);
  } catch {
    throw new Error(`Invalid pi-plan-mode settings at ${path}: invalid JSON`);
  }
  // Validate before applying any patch: never repair an invalid file implicitly.
  parseSettings(document);
  return document as SettingsDocument;
}

async function readContents(path: string): Promise<string> {
  // lstat rejects symlinks even on platforms without O_NOFOLLOW. The open flag
  // also protects against a final-component symlink swap on supported systems.
  const stats = await lstat(path);
  if (!stats.isFile()) throw new Error("Settings path must be a regular file, not a directory or symlink");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) throw new Error("Settings path must be a regular file");
    if (openedStats.size > MAX_SETTINGS_BYTES) throw new Error("Settings file exceeds 65536 bytes");
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_SETTINGS_BYTES) throw new Error("Settings file exceeds 65536 bytes");
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new Error("Settings file is not valid UTF-8");
    }
  } finally {
    await handle.close();
  }
}

async function publishSettings(path: string, document: SettingsDocument, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_SETTINGS_BYTES) throw new Error("Settings file exceeds 65536 bytes");
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  signal?.throwIfAborted();
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600, signal });
    signal?.throwIfAborted();
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
