import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MAX_PLAN_MODE_INSTRUCTIONS_BYTES = 64 * 1024;

export function planModeInstructionsPath(): string {
  return join(getAgentDir(), "pi-plan-mode.md");
}

/** Read optional user guidance without creating files or expanding Markdown content. */
export function readPlanModeInstructions(path = planModeInstructionsPath()): string {
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
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)).trim();
    } catch (error) {
      throw new Error("file must contain valid UTF-8", { cause: error });
    }
  } catch (error) {
    if (descriptor === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return "";
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read Plan-mode instructions at ${JSON.stringify(path)}: ${reason}`, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
