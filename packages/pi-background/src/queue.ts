import { randomUUID } from "node:crypto";

export interface Notice {
  id: string;
  jobId: string;
  session: string;
  scope: string;
  topic: string;
  summary: string;
  result: string;
  wake: boolean;
}
export interface Claim {
  readonly token: string;
  readonly notices: readonly Notice[];
}
interface Pending {
  notice: Notice;
  claim?: string;
  wakeAttempted: boolean;
}

/** Live-runtime queue only. No durable receipts, replay or exactly-once guarantee. */
export class NotificationQueue {
  private readonly pending = new Map<string, Pending>();
  private readonly known = new Set<string>();
  private readonly revoked = new Set<string>();
  private session = "";
  private readonly holds = new Set<string>();

  constructor(
    readonly capacity = 128,
    readonly maxEvents = 4096,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || maxEvents < capacity)
      throw new Error("Invalid notification queue bounds.");
  }

  /** Replacement drops pending and committed IDs; old producers still fail session checks. */
  replace(session: string): void {
    if (!session) throw new Error("A runtime session token is required.");
    this.pending.clear();
    this.known.clear();
    this.revoked.clear();
    this.holds.clear();
    this.session = session;
  }

  revoke(scope: string): void {
    // Scope tokens are random and may never be reused within this runtime.
    if (this.revoked.size >= this.maxEvents && !this.revoked.has(scope)) {
      this.session = "";
      this.pending.clear();
      throw new Error("Scope revocation budget exhausted; runtime delivery disabled.");
    }
    this.revoked.add(scope);
    for (const [id, item] of this.pending) if (item.notice.scope === scope) this.pending.delete(id);
  }

  hold(owner: string, held: boolean): void {
    if (held) this.holds.add(owner);
    else this.holds.delete(owner);
  }

  enqueue(notice: Notice): "queued" | "duplicate" | "stale" | "full" {
    if (notice.session !== this.session || !this.session || this.revoked.has(notice.scope)) return "stale";
    for (const key of ["id", "jobId", "session", "scope", "topic", "result"] as const) {
      if (!notice[key] || notice[key].length > 4096) throw new Error(`Invalid notice ${key}.`);
    }
    if (Buffer.byteLength(notice.summary) > 8192) throw new Error("Notice summary exceeds 8192 bytes.");
    if (this.known.has(notice.id)) return "duplicate";
    if (this.pending.size >= this.capacity || this.known.size >= this.maxEvents) return "full";
    this.known.add(notice.id);
    this.pending.set(notice.id, { notice: structuredClone(notice), wakeAttempted: false });
    return "queued";
  }

  /** Claim is provisional. Never consume based only on proposed boundary entries. */
  claim(options: { idle: boolean; pendingUserWork: boolean; limit?: number }): Claim | undefined {
    if (this.holds.size || options.pendingUserWork) return;
    const limit = Math.min(20, Math.max(1, options.limit ?? 20));
    const available = [...this.pending.values()].filter((item) => !item.claim);
    const wake = options.idle ? available.find((item) => item.notice.wake && !item.wakeAttempted) : undefined;
    // Passive items can accompany a real wake, but cannot cause one. A passive
    // backlog must not hide a wake-capable completion beyond the batch boundary.
    if (options.idle && !wake) return;
    const selected = wake
      ? [wake, ...available.filter((item) => item !== wake)].slice(0, limit)
      : available.slice(0, limit);
    if (!selected.length) return;
    const token = randomUUID();
    for (const item of selected) {
      item.claim = token;
      if (options.idle) item.wakeAttempted = true;
    }
    return { token, notices: selected.map((item) => structuredClone(item.notice)) };
  }

  /** Failed/uncommitted proposals remain recoverable, but do not earn another idle wake. */
  release(token: string): void {
    for (const item of this.pending.values()) if (item.claim === token) item.claim = undefined;
  }

  /** Call only with IDs extracted from committed transcript evidence in this scope. */
  committed(session: string, ids: readonly string[]): void {
    if (session !== this.session) return;
    for (const id of ids) {
      if (!id || id.length > 4096) throw new Error("Invalid committed event ID.");
      this.pending.delete(id);
      // A tool result can commit before its producer's completion callback runs.
      // Remember that evidence too, without allowing unbounded receipt storage.
      if (this.known.size < this.maxEvents) this.known.add(id);
    }
  }

  /** Explicit wait/result is also provisional until its tool result is persisted. */
  claimResults(session: string, ids: readonly string[]): Claim | undefined {
    if (session !== this.session) return;
    const token = randomUUID();
    const notices: Notice[] = [];
    for (const id of new Set(ids)) {
      const item = this.pending.get(id);
      if (!item) continue;
      if (item.claim) continue;
      item.claim = token;
      notices.push(structuredClone(item.notice));
    }
    return notices.length ? { token, notices } : undefined;
  }

  status(scope?: string): { pending: number; held: boolean } {
    return {
      pending: [...this.pending.values()].filter((item) => !scope || item.notice.scope === scope).length,
      held: this.holds.size > 0,
    };
  }
}
