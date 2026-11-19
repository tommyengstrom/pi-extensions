import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { canonicalizeConfiguredKey } from "@narumitw/pi-tui-kit/key-matching";
import { planDirectoryComponents } from "./plan-store.js";
import { validTemplateName } from "./templates.js";

export const PROGRESS_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export interface ProgressSettings {
  model: { provider: string; id: string };
  thinkingLevel: (typeof PROGRESS_LEVELS)[number];
}
export const DEFAULT_PROGRESS: ProgressSettings = {
  model: { provider: "openai", id: "gpt-6-luna" },
  thinkingLevel: "low",
};

export const DEFAULT_TOGGLE_SHORTCUT: KeyId = "alt+m";
export const DEFAULT_TEMPLATE_SHORTCUT: KeyId = "shift+alt+m";

export interface PlanModeSettings {
  /** Omission uses the default binding; null disables it. Loaded once per extension instance. */
  shortcuts?: { togglePlan?: KeyId | null; selectTemplate?: KeyId | null };
  progress?: Partial<ProgressSettings>;
  /** Independent naming request; omission follows the configured progress model. */
  naming?: { model?: ProgressSettings["model"] };
  /** Retained only to discover legacy plans; never redirects new series. */
  plansDirectory?: string;
  /** Omitted means canonical read-only built-ins; an empty list means helpers only. */
  tools?: string[];
  /** Omitted uses the built-in decision-brief template. */
  template?: string;
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
  patch: {
    progress?: { model?: ProgressSettings["model"] | null; thinkingLevel?: ProgressSettings["thinkingLevel"] | null };
    naming?: { model?: ProgressSettings["model"] | null };
    plansDirectory?: string;
    tools?: readonly string[] | null;
    template?: string | null;
  },
  options: { settingsPath?: string; signal?: AbortSignal } = {},
): Promise<PlanModeSettings> {
  const settingsPath = resolve(options.settingsPath ?? planModeSettingsPath());
  const { signal } = options;
  // Capture inputs before waiting behind another editor's update.
  const plansDirectory = patch.plansDirectory;
  const progress = patch.progress ? structuredClone(patch.progress) : undefined;
  const naming = patch.naming ? structuredClone(patch.naming) : undefined;
  const tools =
    patch.tools === undefined || patch.tools === null ? patch.tools : parseSettings({ tools: patch.tools }).tools;
  const template =
    patch.template === undefined || patch.template === null
      ? patch.template
      : parseSettings({ template: patch.template }).template;
  return enqueueMutation(settingsPath, async () => {
    signal?.throwIfAborted();
    const document = await readDocument(settingsPath);
    if (plansDirectory !== undefined) document.plansDirectory = plansDirectory;
    if (tools === null) delete document.tools;
    else if (tools !== undefined) document.tools = tools;
    if (template === null) delete document.template;
    else if (template !== undefined) document.template = template;
    if (progress) {
      const next = { ...(document.progress as SettingsDocument | undefined), ...progress };
      for (const key of ["model", "thinkingLevel"] as const) if (next[key] === null) delete next[key];
      document.progress = next;
    }
    if (naming) {
      const next = { ...(document.naming as SettingsDocument | undefined), ...naming };
      if (next.model === null) delete next.model;
      document.naming = next;
    }
    const settings = parseSettings(document);
    // Persist normalized owned fields without dropping unrelated settings.
    if (settings.plansDirectory !== undefined) document.plansDirectory = settings.plansDirectory;
    if (settings.tools !== undefined) document.tools = settings.tools;
    if (settings.template !== undefined) document.template = settings.template;
    for (const name of ["togglePlan", "selectTemplate"] as const) {
      if (settings.shortcuts?.[name] !== undefined) {
        (document.shortcuts as SettingsDocument)[name] = settings.shortcuts[name];
      }
    }
    await publishSettings(settingsPath, document, signal);
    return settings;
  });
}

function parseModel(value: unknown): ProgressSettings["model"] {
  const fields = value as Partial<ProgressSettings["model"]> | null;
  if (
    typeof fields?.provider !== "string" ||
    !fields.provider.trim() ||
    typeof fields.id !== "string" ||
    !fields.id.trim()
  )
    throw new Error("Invalid model: provider and id are required");
  return { provider: fields.provider, id: fields.id };
}

function parseSettings(value: unknown): PlanModeSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid pi-plan-mode settings: expected an object");
  }
  const document = value as SettingsDocument;
  const plansDirectory = document.plansDirectory;
  if (Object.hasOwn(document, "plansDirectory") && typeof plansDirectory !== "string") {
    throw new Error("Invalid pi-plan-mode settings: plansDirectory must be a string");
  }
  try {
    if (typeof plansDirectory === "string") planDirectoryComponents(plansDirectory);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid pi-plan-mode settings: plansDirectory: ${detail}`);
  }
  const settings: PlanModeSettings = typeof plansDirectory === "string" ? { plansDirectory } : {};
  if (Object.hasOwn(document, "shortcuts")) {
    const value = document.shortcuts;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("Invalid shortcuts settings: expected an object");
    const shortcuts = value as SettingsDocument;
    settings.shortcuts = {};
    for (const name of ["togglePlan", "selectTemplate"] as const) {
      if (!Object.hasOwn(shortcuts, name)) continue;
      const key = shortcuts[name] === null ? null : canonicalizeConfiguredKey(shortcuts[name]);
      if (key === undefined) throw new Error(`Invalid shortcuts.${name}: expected a Pi key binding or null`);
      if (key === "ctrl+m")
        throw new Error(`Invalid shortcuts.${name}: Ctrl+M aliases Enter and would intercept prompt submission`);
      settings.shortcuts[name] = key;
    }
  }
  if (Object.hasOwn(document, "progress")) {
    const value = document.progress;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("Invalid progress settings: expected an object");
    const fields = value as SettingsDocument;
    settings.progress = {};
    if (Object.hasOwn(fields, "model")) {
      // Reuse the exact model identifier validation without coupling defaults.
      settings.progress.model = parseModel(fields.model);
    }
    if (Object.hasOwn(fields, "thinkingLevel")) {
      if (!PROGRESS_LEVELS.includes(fields.thinkingLevel as ProgressSettings["thinkingLevel"]))
        throw new Error("Invalid progress.thinkingLevel");
      settings.progress.thinkingLevel = fields.thinkingLevel as ProgressSettings["thinkingLevel"];
    }
  }
  if (Object.hasOwn(document, "naming")) {
    const value = document.naming;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("Invalid naming settings: expected an object");
    const fields = value as SettingsDocument;
    settings.naming = {};
    if (Object.hasOwn(fields, "model")) settings.naming.model = parseModel(fields.model);
  }
  if (Object.hasOwn(document, "tools")) {
    const tools = document.tools;
    if (!Array.isArray(tools) || !tools.every((name) => typeof name === "string" && name.trim().length > 0)) {
      throw new Error("Invalid pi-plan-mode settings: tools must be an array of nonempty names");
    }
    // Names are exact identifiers, not patterns or shell policy fragments.
    settings.tools = [...new Set(tools)];
  }
  if (Object.hasOwn(document, "template")) {
    const template = document.template;
    if (!validTemplateName(template)) {
      throw new Error("Invalid pi-plan-mode settings: template must be a lowercase kebab-case name");
    }
    settings.template = template;
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
