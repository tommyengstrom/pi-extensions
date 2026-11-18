import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilitySnapshot } from "./capabilities.js";
import type { CoreTerminal } from "./core.js";
import { terminalText } from "./terminal-text.js";
import { type JobRecord, terminalState } from "./tree.js";

export interface StoredJob extends JobRecord {
  ownerSession: string;
  model: { provider: string; id: string };
  thinking: string;
  capabilities: CapabilitySnapshot;
  allocation?: CoreTerminal;
  diagnostic?: string;
  transcript?: string;
  outcome?: "success" | "error" | "aborted" | "missing-result";
  stopConfirmed?: boolean;
}
export interface JobResult {
  version: 1;
  job: string;
  attempt: string;
  outcome: "success" | "error" | "aborted" | "missing-result";
  summary: string;
  transcript: string;
  usage?: unknown;
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export function diagnostic(value: unknown): string {
  return terminalText(value instanceof Error ? value.message : String(value))
    .replaceAll("\n", " ")
    .replaceAll("\t", " ")
    .slice(0, 2000);
}
function id(value: string): string {
  if (!/^[a-f0-9-]{36}$/.test(value) || value.length !== 36) throw new Error("Invalid job/attempt ID.");
  return value;
}
async function readJson(path: string, bound: number): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > bound) throw new Error("Invalid or oversized control record.");
    const bytes = Buffer.alloc(bound + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > bound) throw new Error("Control record grew beyond limit.");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
}
function stored(value: unknown): value is StoredJob {
  return (
    object(value) &&
    value.version === 1 &&
    typeof value.id === "string" &&
    typeof value.attempt === "string" &&
    typeof value.root === "string" &&
    typeof value.parent === "string" &&
    typeof value.scope === "string" &&
    typeof value.group === "string" &&
    typeof value.task === "string" &&
    typeof value.ownerSession === "string" &&
    typeof value.state === "string" &&
    [
      "intent",
      "allocated",
      "running",
      "waiting",
      "cancelling",
      "uncertain",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(value.state) &&
    Number.isFinite(value.created) &&
    Number.isFinite(value.deadline) &&
    Number.isSafeInteger(value.depth) &&
    Number.isSafeInteger(value.turns) &&
    Number.isSafeInteger(value.calls) &&
    object(value.capabilities) &&
    object(value.model) &&
    typeof value.model.id === "string" &&
    typeof value.model.provider === "string" &&
    typeof value.thinking === "string"
  );
}

/** Lazy, atomic, single-supervisor storage. Historical reads never grant control. */
export class JobStore {
  readonly directory: string;
  private serial: Promise<void> = Promise.resolve();
  constructor(agentDir: string) {
    this.directory = join(agentDir, "pi-herdr-core", "jobs");
  }
  jobDirectory(job: string): string {
    return join(this.directory, id(job));
  }
  private async privateDirectory(path: string): Promise<void> {
    await mkdir(path, { mode: 0o700, recursive: true });
    const stat = await lstat(path);
    if (!stat.isDirectory() || !process.getuid || stat.uid !== process.getuid() || stat.mode & 0o077)
      throw new Error("Herdr control directory must be private and owned by the current user.");
  }
  private async atomic(path: string, value: unknown, bound: number): Promise<void> {
    const bytes = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(bytes) > bound) throw new Error("Herdr record exceeds storage bound.");
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(bytes, "utf8");
      await file.sync();
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  save(job: StoredJob): Promise<void> {
    const snapshot = structuredClone(job);
    id(snapshot.id);
    id(snapshot.attempt);
    const operation = this.serial.then(async () => {
      await this.privateDirectory(this.directory);
      await this.privateDirectory(this.jobDirectory(snapshot.id));
      await this.atomic(join(this.jobDirectory(snapshot.id), "job.json"), snapshot, 256 * 1024);
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
  async result(result: JobResult): Promise<string> {
    id(result.job);
    id(result.attempt);
    if (
      result.version !== 1 ||
      !["success", "error", "aborted", "missing-result"].includes(result.outcome) ||
      typeof result.summary !== "string" ||
      Buffer.byteLength(result.summary) > 48 * 1024 ||
      typeof result.transcript !== "string" ||
      result.transcript.length > 4096
    )
      throw new Error("Invalid child result.");
    const path = join(this.jobDirectory(result.job), `${result.attempt}.result.json`);
    // A repeated identical result is harmless; conflicting publication is never silently replaced.
    try {
      const previous = await readJson(path, 128 * 1024);
      if (JSON.stringify(previous) !== JSON.stringify(result)) throw new Error("Conflicting attempt result.");
      return path;
    } catch (error) {
      if (!(object(error) && error.code === "ENOENT")) throw error;
    }
    await this.privateDirectory(this.jobDirectory(result.job));
    await this.atomic(path, result, 128 * 1024);
    return path;
  }
  async read(job: string): Promise<StoredJob> {
    const value = await readJson(join(this.jobDirectory(job), "job.json"), 256 * 1024);
    if (!stored(value) || value.id !== job) throw new Error("Invalid historical job record.");
    id(value.attempt);
    return value;
  }
  async readResult(job: string, attempt: string): Promise<JobResult> {
    const value = await readJson(join(this.jobDirectory(job), `${id(attempt)}.result.json`), 128 * 1024);
    if (
      !object(value) ||
      value.version !== 1 ||
      value.job !== job ||
      value.attempt !== attempt ||
      !["success", "error", "aborted", "missing-result"].includes(String(value.outcome)) ||
      typeof value.summary !== "string" ||
      typeof value.transcript !== "string"
    )
      throw new Error("Invalid result record.");
    return value as unknown as JobResult;
  }
  async history(limit = 200): Promise<StoredJob[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (object(error) && error.code === "ENOENT") return [];
      throw error;
    }
    const results: StoredJob[] = [];
    for (const name of names.sort().slice(0, Math.min(limit, 1000))) {
      try {
        const job = await this.read(name);
        // Display projection only: no owner is reclaimed and no notification is replayed.
        if (!terminalState(job.state)) {
          job.state = job.state === "intent" || job.state === "uncertain" ? "uncertain" : "interrupted";
          job.stopConfirmed = false;
          job.diagnostic =
            "Previous supervisor is unavailable; process termination is unverified. No task was resumed.";
        }
        results.push(job);
      } catch {
        /* Invalid/unowned entries are not usable for control or cleanup. */
      }
    }
    return results;
  }
}
