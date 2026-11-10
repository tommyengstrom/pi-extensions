import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Usage } from "@earendil-works/pi-ai";
import { type DirectoryIdentity, directoryIdentity } from "./confined-tools.js";
import { type ArtifactReference, diagnostic, identifier, pending, record, validReference } from "./contract.js";

export interface Artifact {
  version: 1;
  id: string;
  root: DirectoryIdentity;
  source: string;
  history: string;
}
export interface Job extends ArtifactReference {
  owner: string;
  pid: number;
  host: string;
  token: string;
  summary: string;
  usage?: Usage;
  staging?: DirectoryIdentity;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
}
export function inside(root: string, path: string): boolean {
  const r = relative(root, path);
  return !isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`);
}
function canonicalDestination(path: string): string {
  let ancestor = resolve(path);
  const tail: string[] = [];
  while (!existsSync(ancestor)) {
    tail.unshift(ancestor.slice(dirname(ancestor).length + (dirname(ancestor) === sep ? 0 : 1)));
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Cannot resolve output directory.");
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...tail);
}
function live(job: Job): boolean {
  if (job.host !== hostname()) return true; // Shared storage: never guess remote process liveness.
  try {
    process.kill(job.pid, 0);
    return true;
  } catch (error) {
    return !(record(error) && error.code === "ESRCH");
  }
}
function artifact(value: unknown): Artifact {
  if (
    !record(value) ||
    value.version !== 1 ||
    !identifier(value.id) ||
    !record(value.root) ||
    typeof value.root.path !== "string" ||
    !isAbsolute(value.root.path) ||
    typeof value.root.device !== "string" ||
    typeof value.root.inode !== "string" ||
    typeof value.source !== "string" ||
    !isAbsolute(value.source) ||
    typeof value.history !== "string" ||
    !isAbsolute(value.history)
  )
    throw new Error("Invalid artifact manifest; it was not replaced.");
  return value as unknown as Artifact;
}
function job(value: unknown): Job {
  if (
    !validReference(value) ||
    !record(value) ||
    typeof value.owner !== "string" ||
    !identifier(value.token) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 0 ||
    typeof value.host !== "string" ||
    typeof value.summary !== "string" ||
    value.summary.length > 2000
  )
    throw new Error("Invalid job manifest; it was not replaced.");
  if (
    value.usage !== undefined &&
    (!record(value.usage) ||
      !record(value.usage.cost) ||
      !["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(
        (k) => typeof (value.usage as Record<string, unknown>)[k] === "number",
      ))
  )
    throw new Error("Invalid job usage.");
  if (
    value.staging !== undefined &&
    (!record(value.staging) ||
      typeof value.staging.path !== "string" ||
      dirname(value.staging.path) !== value.directory ||
      !value.staging.path.startsWith(join(value.directory, ".pi-artifact-staging-")) ||
      typeof value.staging.device !== "string" ||
      typeof value.staging.inode !== "string")
  )
    throw new Error("Invalid staging manifest.");
  return value as unknown as Job;
}
/** SQLite transactions provide cross-process compare-and-set ownership, not expiring leases. */
export class ArtifactStore {
  readonly directory: string;
  private readonly db: DatabaseSync;
  private readonly identity: DirectoryIdentity;
  constructor(agentDir: string) {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const anchor = realpathSync(agentDir);
    this.directory = join(anchor, "pi-artifacts");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error("Artifact control storage must not be a symlink.");
    this.identity = directoryIdentity(this.directory);
    const file = join(this.directory, "state.sqlite");
    if (
      existsSync(file) &&
      (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || lstatSync(file).nlink !== 1)
    )
      throw new Error("Invalid artifact database target.");
    const existed = existsSync(file);
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL;");
    const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
    if ((existed && version !== 1) || (version !== 0 && version !== 1)) {
      this.db.close();
      throw new Error("Unsupported artifact database version.");
    }
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, directory TEXT UNIQUE NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, artifact TEXT NOT NULL, data TEXT NOT NULL); PRAGMA user_version=1;",
    );
  }
  close() {
    this.db.close();
  }
  private check() {
    const now = directoryIdentity(this.directory);
    if (JSON.stringify(now) !== JSON.stringify(this.identity)) throw new Error("Artifact control storage changed.");
  }
  private transaction<T>(fn: () => T): T {
    this.check();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  getArtifact(id: string): Artifact {
    this.check();
    if (!identifier(id)) throw new Error("Unknown artifact identifier.");
    const row = this.db.prepare("SELECT data FROM artifacts WHERE id=?").get(id);
    if (!row || typeof row.data !== "string") throw new Error("Unknown artifact identifier.");
    const result = artifact(JSON.parse(row.data));
    if (result.id !== id || result.history !== join(this.directory, `${id}.jsonl`))
      throw new Error("Artifact manifest identity mismatch.");
    return result;
  }
  private loadJob(id: string): Job {
    if (!identifier(id)) throw new Error("Unknown job identifier.");
    const row = this.db.prepare("SELECT data FROM jobs WHERE id=?").get(id);
    if (!row || typeof row.data !== "string") throw new Error("Unknown job identifier.");
    const result = job(JSON.parse(row.data));
    if (result.jobId !== id) throw new Error("Job identity mismatch.");
    return result;
  }
  private saveJob(value: Job) {
    job(value);
    this.db
      .prepare("INSERT OR REPLACE INTO jobs(id,artifact,data) VALUES(?,?,?)")
      .run(value.jobId, value.artifactId, JSON.stringify(value));
  }
  private jobsFor(id: string): Job[] {
    return this.db
      .prepare("SELECT data FROM jobs WHERE artifact=? ORDER BY rowid DESC")
      .all(id)
      .map((row) => job(JSON.parse(String(row.data))));
  }
  private reconcile(value: Job): Job {
    if (pending(value.status) && !live(value)) {
      value = {
        ...value,
        status: "interrupted",
        summary: "Owning process stopped. Partial output and history retained; use artifact_update explicitly.",
      };
      this.saveJob(value);
    }
    return value;
  }
  status(id: string): Job {
    return this.transaction(() => this.reconcile(this.loadJob(id)));
  }
  references(ids: string[]): Job[] {
    return ids.map((id) => this.status(id));
  }
  current(id: string): Job {
    return this.transaction(() => {
      const reference = this.loadJob(id);
      const latest = this.jobsFor(reference.artifactId)[0];
      if (!latest) throw new Error("Artifact has no registered jobs.");
      return this.reconcile(latest);
    });
  }
  create(directory: string, source: string, owner: string): { artifact: Artifact; job: Job } {
    const destination = canonicalDestination(resolve(source, directory));
    if (inside(this.directory, destination) || inside(destination, this.directory))
      throw new Error("Output overlaps artifact control storage.");
    return this.transaction(() => {
      for (const row of this.db.prepare("SELECT directory FROM artifacts").all()) {
        if (typeof row.directory !== "string") throw new Error("Invalid artifact directory manifest.");
        if (inside(row.directory, destination) || inside(destination, row.directory))
          throw new Error("Directory is already claimed or overlaps a claim; use its artifact identifier.");
      }
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      if (lstatSync(destination).isSymbolicLink() || readdirSync(destination).length)
        throw new Error("Artifact creation requires a new or genuinely empty directory, including hidden entries.");
      const id = randomUUID();
      const value: Artifact = {
        version: 1,
        id,
        root: directoryIdentity(destination),
        source: realpathSync(source),
        history: join(this.directory, `${id}.jsonl`),
      };
      writeFileSync(
        value.history,
        `${JSON.stringify({ type: "session", version: 3, id, cwd: destination, timestamp: new Date().toISOString() })}\n`,
        { flag: "wx", mode: 0o600, flush: true },
      );
      this.db
        .prepare("INSERT INTO artifacts(id,directory,data) VALUES(?,?,?)")
        .run(id, destination, JSON.stringify(value));
      return { artifact: value, job: this.accept(value, owner) };
    });
  }
  update(id: string, owner: string): { artifact: Artifact; job: Job } {
    return this.transaction(() => {
      const value = this.getArtifact(id);
      if (JSON.stringify(directoryIdentity(value.root.path)) !== JSON.stringify(value.root))
        throw new Error("Artifact directory was replaced or redirected.");
      for (const old of this.jobsFor(id)) {
        if (pending(this.reconcile(old).status))
          throw new Error("Artifact already has queued/running work. Wait or cancel that job first.");
        if (old.staging && existsSync(old.staging.path)) {
          if (JSON.stringify(directoryIdentity(old.staging.path)) !== JSON.stringify(old.staging))
            throw new Error("Retained artifact staging was redirected; refusing cleanup.");
          rmSync(old.staging.path, { recursive: true });
        }
      }
      return { artifact: value, job: this.accept(value, owner) };
    });
  }
  private accept(value: Artifact, owner: string): Job {
    const result: Job = {
      version: 1,
      artifactId: value.id,
      jobId: randomUUID(),
      directory: value.root.path,
      paths: [],
      status: "queued",
      owner,
      pid: process.pid,
      host: hostname(),
      token: randomUUID(),
      summary: "Accepted background job; generation has not completed.",
    };
    this.saveJob(result);
    return result;
  }
  assertOwned(expected: Job) {
    this.check();
    const value = this.loadJob(expected.jobId);
    if (value.token !== expected.token || value.pid !== process.pid || !pending(value.status))
      throw new Error("Artifact job ownership lost.");
  }
  change(
    expected: Job,
    changes: Partial<Pick<Job, "status" | "summary" | "paths" | "usage" | "staging" | "model" | "thinkingLevel">>,
  ): Job {
    return this.transaction(() => {
      this.assertOwned(expected);
      const value = { ...this.loadJob(expected.jobId), ...changes };
      this.saveJob(value);
      return value;
    });
  }
  failAccepted(expected: Job, error: unknown) {
    return this.change(expected, { status: "failed", summary: diagnostic(error) });
  }
}
