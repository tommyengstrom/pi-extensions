import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readWorkflow, SCOPE_EVENT, type WorkflowContext } from "./context.js";
import { type Notice, NotificationQueue } from "./queue.js";

const DISPATCHER = "pi-background:dispatcher:v1";
export const NOTICE_TYPE = "pi-background-result-v1";
export const STATUS_EVENT = "pi-background:work-status:v1";
export interface Recipient {
  session: string;
  scope: string;
}
export interface WorkStatus {
  active: number;
  pending: number;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export function backgroundStatus(pi: ExtensionAPI, scope: string): WorkStatus {
  let active = 0;
  let pending = 0;
  let open = true;
  pi.events.emit(STATUS_EVENT, {
    version: 1,
    scope,
    respond(value: WorkStatus) {
      if (!open) return;
      if (
        !value ||
        !Number.isSafeInteger(value.active) ||
        !Number.isSafeInteger(value.pending) ||
        value.active < 0 ||
        value.pending < 0
      )
        throw new Error("Invalid background work status.");
      active += value.active;
      pending += value.pending;
    },
  });
  open = false;
  return { active, pending };
}
/** One integration per Pi event bus, including consumers with separate library copies. */
export function backgroundRuntime(pi: ExtensionAPI): BackgroundRuntime {
  const replies: BackgroundRuntime[] = [];
  pi.events.emit(DISPATCHER, { version: 1, respond: (runtime: BackgroundRuntime) => replies.push(runtime) });
  if (replies.length > 1) throw new Error("Conflicting background notification dispatchers.");
  return replies[0] ?? new BackgroundRuntime(pi);
}
export class BackgroundRuntime {
  private readonly queue = new NotificationQueue();
  private ctx?: ExtensionContext;
  private token = "";
  private fallback = "";
  private activeScope = "";
  private readonly revoked = new Set<string>();
  private readonly claims = new Set<string>();
  private readonly revokedListeners = new Set<(scope: string) => void>();
  private readonly subscriptions: Array<() => void> = [];
  private idleWakes = 0;
  private promptDepth = 0;
  private disposed = false;
  constructor(private readonly pi: ExtensionAPI) {
    this.subscriptions.push(
      pi.events.on(DISPATCHER, (value) => {
        if (record(value) && value.version === 1 && typeof value.respond === "function") value.respond(this);
      }),
    );
    this.subscriptions.push(
      pi.events.on(SCOPE_EVENT, (value) => {
        if (
          !record(value) ||
          value.version !== 1 ||
          value.session !== this.ctx?.sessionManager.getSessionId() ||
          typeof value.scope !== "string"
        )
          return;
        if (value.action === "revoke") this.revoke(value.scope);
        if (value.action === "hold") this.queue.hold("workflow", value.held === true);
        // A newly published workflow revokes standalone Normal jobs immediately.
        if (value.action === "replace") {
          if (this.activeScope !== value.scope) this.revoke(this.activeScope);
          this.activeScope = value.scope;
        }
      }),
    );
    this.subscriptions.push(
      pi.events.on(STATUS_EVENT, (value) => {
        if (
          record(value) &&
          value.version === 1 &&
          typeof value.scope === "string" &&
          typeof value.respond === "function"
        ) {
          this.reconcile(false);
          value.respond({ active: 0, pending: this.queue.status(value.scope).pending });
        }
      }),
    );
    this.subscriptions.push(pi.on("session_start", (_event, ctx) => this.start(ctx)));
    this.subscriptions.push(pi.on("session_tree", (_event, ctx) => this.start(ctx)));
    this.subscriptions.push(pi.on("session_shutdown", () => this.dispose()));
    this.subscriptions.push(
      pi.on("ui_prompt_start", () => {
        this.promptDepth++;
        this.queue.hold("ui", true);
      }),
    );
    this.subscriptions.push(
      pi.on("ui_prompt_end", () => {
        this.promptDepth = Math.max(0, this.promptDepth - 1);
        this.queue.hold("ui", this.promptDepth > 0);
        if (!this.promptDepth) this.idle();
      }),
    );
    this.subscriptions.push(pi.on("session_before_compact", () => this.queue.hold("compaction", true)));
    const compactFinished = () => {
      this.queue.hold("compaction", false);
      this.reconcile(false);
    };
    this.subscriptions.push(pi.on("session_compact", compactFinished));
    this.subscriptions.push(pi.on("session_compact_failed", compactFinished));
    this.subscriptions.push(
      pi.on("input", (event) => {
        if (event.source !== "extension") {
          this.idleWakes = 0;
          if (this.revoked.has(this.fallback)) this.fallback = randomUUID();
        }
      }),
    );
    this.subscriptions.push(
      pi.on("turn_start", () => {
        this.queue.hold("compaction", false);
        this.reconcile(true);
      }),
    );
    this.subscriptions.push(
      pi.on("turn_end", (event, ctx) => {
        this.reconcile(true);
        if (!this.validContext(ctx) || event.outcome !== "completed") return;
        this.refreshHold();
        const claim = this.queue.claim({ idle: false, pendingUserWork: ctx.hasPendingMessages() });
        if (!claim) return;
        this.claims.add(claim.token);
        return {
          entries: [
            ...event.entries,
            ...claim.notices.map((notice) => ({
              type: "custom_message" as const,
              customType: NOTICE_TYPE,
              content: `[Background result ${notice.id}]\n${notice.summary}\nResult reference: ${notice.result}`,
              display: false,
              details: { version: 1, backgroundEventIds: [notice.id], scope: notice.scope },
            })),
          ],
        };
      }),
    );
    this.subscriptions.push(
      pi.on("agent_settled", (event) => {
        this.reconcile(true);
        if (event.aborted) {
          this.revoke(this.activeScope || this.fallback);
          this.fallback = randomUUID();
          this.activeScope = this.fallback;
          return;
        }
        this.idle();
      }),
    );
  }
  private start(ctx: ExtensionContext): void {
    if (this.token) this.revoke(this.activeScope || this.fallback);
    this.ctx = ctx;
    this.token = randomUUID();
    this.fallback = randomUUID();
    this.activeScope = this.fallback;
    this.queue.replace(this.token);
    this.claims.clear();
    this.revoked.clear();
    this.idleWakes = 0;
    this.promptDepth = 0;
  }
  private validContext(ctx: ExtensionContext): boolean {
    return !this.disposed && this.ctx?.sessionManager === ctx.sessionManager;
  }
  workflow(ctx: ExtensionContext): WorkflowContext | undefined {
    if (!this.ctx && !this.disposed) this.start(ctx);
    if (!this.validContext(ctx)) throw new Error("Background caller session was replaced.");
    return readWorkflow(this.pi.events, ctx.sessionManager.getSessionId());
  }
  recipient(ctx: ExtensionContext): Recipient {
    const workflow = this.workflow(ctx);
    const scope = workflow?.scope ?? this.fallback;
    if (this.activeScope !== scope) {
      this.revoke(this.activeScope);
      this.activeScope = scope;
    }
    this.queue.hold("workflow", workflow?.held ?? false);
    return { session: this.token, scope };
  }
  owns(recipient: Recipient, ctx?: ExtensionContext): boolean {
    if (
      this.disposed ||
      recipient.session !== this.token ||
      this.revoked.has(recipient.scope) ||
      !this.ctx ||
      (ctx && !this.validContext(ctx))
    )
      return false;
    return this.recipient(this.ctx).scope === recipient.scope;
  }
  onRevoke(listener: (scope: string) => void): () => void {
    this.revokedListeners.add(listener);
    return () => this.revokedListeners.delete(listener);
  }
  revoke(scope: string): void {
    if (!scope || this.revoked.has(scope)) return;
    this.revoked.add(scope);
    this.queue.revoke(scope);
    for (const listener of this.revokedListeners) listener(scope);
  }
  hold(name: string, held: boolean): void {
    this.queue.hold(name, held);
  }
  enqueue(notice: Notice): "queued" | "duplicate" | "stale" | "full" {
    if (!this.owns(notice)) return "stale";
    const result = this.queue.enqueue(notice);
    if (result === "queued") this.idle();
    return result;
  }
  /** Put these IDs in the eventual tool result details; returning them is not a receipt. */
  resultDetails(recipient: Recipient, ids: string[]): { backgroundEventIds: string[] } {
    if (!this.owns(recipient)) throw new Error("Background result belongs to a revoked scope.");
    const claim = this.queue.claimResults(recipient.session, ids);
    if (claim) this.claims.add(claim.token);
    return { backgroundEventIds: ids };
  }
  private reconcile(release: boolean): void {
    if (!this.ctx || this.disposed) return;
    const ids: string[] = [];
    for (const entry of this.ctx.sessionManager.getBranch()) {
      const details =
        entry.type === "custom_message" && entry.customType === NOTICE_TYPE
          ? entry.details
          : entry.type === "message" &&
              entry.message.role === "toolResult" &&
              ["subagent_wait", "subagent_query", "artifact_wait"].includes(entry.message.toolName)
            ? entry.message.details
            : undefined;
      if (record(details) && Array.isArray(details.backgroundEventIds))
        for (const id of details.backgroundEventIds) if (typeof id === "string") ids.push(id);
    }
    this.queue.committed(this.token, ids);
    if (release) {
      for (const claim of this.claims) this.queue.release(claim);
      this.claims.clear();
    }
  }
  private refreshHold(): void {
    if (this.ctx) this.queue.hold("workflow", this.workflow(this.ctx)?.held ?? false);
  }
  private idle(): void {
    if (!this.ctx?.isIdle() || this.ctx.hasPendingMessages() || this.idleWakes >= 4 || this.disposed) return;
    this.refreshHold();
    const claim = this.queue.claim({ idle: true, pendingUserWork: false });
    if (!claim) return;
    this.claims.add(claim.token);
    this.idleWakes++;
    try {
      this.pi.sendMessage(
        {
          customType: NOTICE_TYPE,
          content: claim.notices
            .map((notice) => `[Background result ${notice.id}]\n${notice.summary}\nResult reference: ${notice.result}`)
            .join("\n\n"),
          display: false,
          details: { version: 1, backgroundEventIds: claim.notices.map((notice) => notice.id) },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch {
      this.queue.release(claim.token);
      this.claims.delete(claim.token);
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.revoke(this.activeScope || this.fallback);
    this.disposed = true;
    this.token = "";
    this.ctx = undefined;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.revokedListeners.clear();
    this.claims.clear();
  }
}
