import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PLAN_MODE_PROMPT } from "./prompt.js";

export const MAX_PLAN_MODE_INSTRUCTIONS_BYTES = 64 * 1024;

export function planModeInstructionsPath(): string {
  return join(getAgentDir(), "pi-plan-mode.md");
}

export function planModePromptPath(): string {
  return join(getAgentDir(), "pi-plan-mode-prompt.md");
}

/** Select a complete base prompt without retaining any built-in sections in a replacement. */
export function readPlanModeBasePrompt(path = planModePromptPath()): string {
  return readOptionalMarkdown(path, "prompt") || DEFAULT_PLAN_MODE_PROMPT;
}

/** Read optional user guidance without creating files or expanding Markdown content. */
export function readPlanModeInstructions(path = planModeInstructionsPath()): string {
  return readOptionalMarkdown(path, "instructions");
}

/** Explicit editing creates only missing files; even existing blank files are preserved. */
export function openPlanModePrompt(path = planModePromptPath()): string {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, DEFAULT_PLAN_MODE_PROMPT, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readOptionalMarkdown(path, "prompt", false);
}

/** Validate before atomic replacement, and refuse edits made while the dialog was open. */
export function savePlanModePrompt(text: string, original: string, path = planModePromptPath()): void {
  if (Buffer.byteLength(text, "utf8") > MAX_PLAN_MODE_INSTRUCTIONS_BYTES)
    throw new Error("Planning prompt exceeds the 64 KiB limit.");
  if (readOptionalMarkdown(path, "prompt", false) !== original)
    throw new Error("Planning prompt changed on disk. Reopen /plan settings → Edit planning prompt before saving.");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readOptionalMarkdown(path: string, role: string, trim = true): string {
  let descriptor: number | undefined;
  try {
    // Nonblocking open lets fstat reject FIFOs without waiting for a writer.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("expected a regular file");
    if (stat.size > MAX_PLAN_MODE_INSTRUCTIONS_BYTES) {
      throw new Error(`file exceeds the ${MAX_PLAN_MODE_INSTRUCTIONS_BYTES}-byte (64 KiB) limit`);
    }

    // Read one extra byte to detect growth after fstat, with bounded allocation and I/O.
    const buffer = Buffer.alloc(MAX_PLAN_MODE_INSTRUCTIONS_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_PLAN_MODE_INSTRUCTIONS_BYTES) {
      throw new Error(`file exceeds the ${MAX_PLAN_MODE_INSTRUCTIONS_BYTES}-byte (64 KiB) limit`);
    }

    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      return trim ? text.trim() : text;
    } catch (error) {
      throw new Error("file must contain valid UTF-8", { cause: error });
    }
  } catch (error) {
    if (descriptor === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return "";
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read Plan-mode ${role} at ${JSON.stringify(path)}: ${reason}`, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
