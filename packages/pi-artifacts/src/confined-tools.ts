import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";

export interface DirectoryIdentity {
  path: string;
  device: string;
  inode: string;
}

export interface MutationLimits {
  fileBytes: number;
  totalBytes: number;
  entries: number;
  depth: number;
}

export const DEFAULT_MUTATION_LIMITS: Readonly<MutationLimits> = Object.freeze({
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  entries: 1024,
  depth: 32,
});

/** Capture only after the job manager has exclusively claimed the destination. */
export function directoryIdentity(path: string): DirectoryIdentity {
  const canonical = realpathSync(resolve(path));
  const stat = lstatSync(canonical, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Artifact root must be a real directory.");
  return { path: canonical, device: String(stat.dev), inode: String(stat.ino) };
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validateIdentity(identity: DirectoryIdentity): void {
  if (!isAbsolute(identity.path) || resolve(identity.path) !== identity.path)
    throw new Error("Invalid directory identity.");
  const stat = lstatSync(identity.path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    String(stat.dev) !== identity.device ||
    String(stat.ino) !== identity.inode ||
    realpathSync(identity.path) !== identity.path
  )
    throw new Error("Artifact directory has been removed, replaced, or redirected.");
}

interface Snapshot {
  fingerprint: string;
  bytes: Buffer;
}

/**
 * A native-tool backend, not an OS sandbox. The caller must hold an exclusive
 * artifact lease for the entire lifetime and drain outstanding executions before
 * releasing it. Synchronous validation + publication closes our own event-loop
 * cancellation gap; hostile external filesystem races remain outside this boundary.
 */
export class ConfinedMutations {
  readonly root: DirectoryIdentity;
  readonly staging: DirectoryIdentity;
  readonly limits: Readonly<MutationLimits>;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: {
    root: DirectoryIdentity;
    staging: DirectoryIdentity;
    assertOwned(): void;
    limits?: Partial<MutationLimits>;
    /** Only extension-owned temporary staging may be nested, never metadata/history. */
    containedStaging?: boolean;
  }) {
    this.root = Object.freeze({ ...options.root });
    this.staging = Object.freeze({ ...options.staging });
    this.assertOwned = options.assertOwned;
    this.limits = Object.freeze({ ...DEFAULT_MUTATION_LIMITS, ...options.limits });
    for (const limit of Object.values(this.limits)) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid artifact mutation limit.");
    }
    this.check();
    if (
      (!options.containedStaging && within(this.root.path, this.staging.path)) ||
      within(this.staging.path, this.root.path)
    ) {
      throw new Error("Artifact output and control staging must not overlap.");
    }
    // rename is the commit point: never fall back to a non-atomic copy on EXDEV.
    if (this.root.device !== this.staging.device)
      throw new Error("Atomic artifact staging requires the same filesystem as output.");
  }

  private readonly assertOwned: () => void;

  private check(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    this.assertOwned();
    validateIdentity(this.root);
    validateIdentity(this.staging);
    signal?.throwIfAborted();
  }

  private target(path: string): string {
    if (path.includes("\0")) throw new Error("Invalid artifact path.");
    const target = resolve(this.root.path, path);
    if (!within(this.root.path, target)) throw new Error("Artifact mutation escapes the claimed directory.");
    if (within(this.staging.path, target)) throw new Error("Artifact mutation cannot access controlled staging.");
    return target;
  }

  /** Check every component; recursive mkdir would follow symlinks. */
  private directory(path: string, create: boolean, signal?: AbortSignal): void {
    this.check(signal);
    const target = this.target(path);
    const suffix = relative(this.root.path, target);
    const components = suffix ? suffix.split(sep) : [];
    if (components.length > this.limits.depth) throw new Error("Artifact directory depth limit exceeded.");
    let current = this.root.path;
    for (const component of components) {
      current = join(current, component);
      this.check(signal);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(current);
      } catch (error) {
        if (!create || !missing(error)) throw error;
        if (this.inventory().entries >= this.limits.entries) throw new Error("Artifact entry limit exceeded.");
        this.check(signal);
        mkdirSync(current, { mode: 0o700 });
        stat = lstatSync(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Artifact directory components must not be symlinks or non-directories.");
    }
    this.check(signal);
  }

  private snapshot(path: string, signal?: AbortSignal): Snapshot | undefined {
    this.directory(dirname(path), false, signal);
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.size > BigInt(this.limits.fileBytes))
        throw new Error("Artifact target is not a bounded regular file.");
      const bytes = Buffer.alloc(Number(stat.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length !== Number(stat.size)) throw new Error("Artifact changed while reading.");
      const after = fstatSync(fd, { bigint: true });
      if (stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs || stat.size !== after.size)
        throw new Error("Artifact changed while reading.");
      const content = bytes.subarray(0, length);
      // Edits must not silently decode malformed input into replacement characters.
      new TextDecoder("utf-8", { fatal: true }).decode(content);
      this.check(signal);
      return {
        bytes: content,
        fingerprint: [
          stat.dev,
          stat.ino,
          stat.size,
          stat.mtimeNs,
          stat.ctimeNs,
          createHash("sha256").update(content).digest("hex"),
        ].join(":"),
      };
    } finally {
      closeSync(fd);
    }
  }

  private inventory(): { entries: number; bytes: number; files: string[] } {
    this.check();
    let entries = 0;
    let bytes = 0;
    const files: string[] = [];
    const walk = (directory: string, depth: number) => {
      if (depth > this.limits.depth) throw new Error("Artifact directory depth limit exceeded.");
      for (const name of readdirSync(directory)) {
        if (++entries > this.limits.entries) throw new Error("Artifact entry limit exceeded.");
        const path = join(directory, name);
        if (path === this.staging.path) {
          validateIdentity(this.staging);
          continue;
        }
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error("Artifact output contains a symlink.");
        if (stat.isDirectory()) walk(path, depth + 1);
        else if (stat.isFile()) {
          if (stat.size > this.limits.fileBytes) throw new Error("Artifact file size limit exceeded.");
          bytes += stat.size;
          if (bytes > this.limits.totalBytes) throw new Error("Artifact total size limit exceeded.");
          files.push(path);
        } else throw new Error("Artifact output contains a nonregular target.");
      }
    };
    walk(this.root.path, 0);
    this.check();
    return { entries, bytes, files: files.sort() };
  }

  /** Real files only; the child summary is never authoritative for output paths. */
  outputPaths(): string[] {
    return this.inventory().files;
  }

  /** Wait for I/O to settle even when a tool's caller has been cancelled. */
  async drain(): Promise<void> {
    await this.tail;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  private async publish(
    path: string,
    content: string,
    expected: Snapshot | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    this.check(signal);
    const target = this.target(path);
    if (target === this.root.path) throw new Error("Cannot overwrite the artifact root.");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.limits.fileBytes) throw new Error("Artifact file size limit exceeded.");
    this.directory(dirname(target), false, signal);
    const temporary = join(this.staging.path, `.artifact-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        this.check(signal);
        await handle.writeFile(content, "utf8");
        this.check(signal);
        await handle.sync();
        this.check(signal);
      } finally {
        await handle.close();
      }
      this.check(signal);
      const current = this.snapshot(target, signal);
      if (current?.fingerprint !== expected?.fingerprint)
        throw new Error("Artifact changed during read/modify/write; retry against current contents.");
      const inventory = this.inventory();
      if (inventory.bytes - (current?.bytes.length ?? 0) + bytes > this.limits.totalBytes)
        throw new Error("Artifact total size limit exceeded.");
      if (!current && inventory.entries >= this.limits.entries) throw new Error("Artifact entry limit exceeded.");
      this.directory(dirname(target), false, signal);
      this.check(signal);
      // Replace the directory entry, never write through an existing hard link.
      renameSync(temporary, target);
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        // Publication is already committed, or an earlier failure is authoritative.
        // Do not mask either outcome with best-effort staging cleanup errors.
      }
    }
  }

  /** Native schemas, matching, guidance and diff rendering remain untouched. */
  tools(): [ReturnType<typeof createWriteToolDefinition>, ReturnType<typeof createEditToolDefinition>] {
    const write = createWriteToolDefinition(this.root.path);
    const edit = createEditToolDefinition(this.root.path);
    return [
      {
        ...write,
        execute: (id, args, signal, update, ctx) =>
          this.exclusive(async () => {
            this.check(signal);
            const native = createWriteToolDefinition(this.root.path, {
              operations: {
                mkdir: async (path) => this.directory(path, true, signal),
                writeFile: async (path, content) => {
                  const target = this.target(path);
                  const before = this.snapshot(target, signal);
                  await this.publish(target, content, before, signal);
                },
              },
            });
            return native.execute(id, args, signal, update, ctx);
          }),
      },
      {
        ...edit,
        execute: (id, args, signal, update, ctx) =>
          this.exclusive(async () => {
            this.check(signal);
            const snapshots = new Map<string, Snapshot>();
            const native = createEditToolDefinition(this.root.path, {
              operations: {
                access: async (path) => {
                  const target = this.target(path);
                  if (!this.snapshot(target, signal)) throw new Error("Artifact file does not exist.");
                },
                readFile: async (path) => {
                  const target = this.target(path);
                  const snapshot = this.snapshot(target, signal);
                  if (!snapshot) throw new Error("Artifact file does not exist.");
                  snapshots.set(target, snapshot);
                  return snapshot.bytes;
                },
                writeFile: async (path, content) => {
                  const target = this.target(path);
                  const before = snapshots.get(target);
                  if (!before) throw new Error("Artifact edit has no matching read.");
                  await this.publish(target, content, before, signal);
                },
              },
            });
            return native.execute(id, args, signal, update, ctx);
          }),
      },
    ];
  }
}
