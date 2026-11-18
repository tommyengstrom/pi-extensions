import { randomUUID } from "node:crypto";

export const CONTEXT_EVENT = "pi-background:context:v1";
export const SCOPE_EVENT = "pi-background:scope:v1";
export interface EventBus {
  emit(name: string, data: unknown): void;
  on(name: string, listener: (data: unknown) => void): () => void;
}
export interface RestrictionSnapshot {
  allowedTools: readonly string[];
  parentOnly: readonly string[];
  guidance: string;
}
export interface WorkflowContext {
  version: 1;
  session: string;
  scope: string;
  held: boolean;
  restrictions?: RestrictionSnapshot;
}
interface Request {
  version: 1;
  session: string;
  respond(value: WorkflowContext): void;
}
function request(value: unknown): value is Request {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "session" in value &&
    typeof value.session === "string" &&
    "respond" in value &&
    typeof value.respond === "function"
  );
}

/** Synchronous snapshot contract, deliberately not an async event-handler protocol. */
export function readWorkflow(bus: EventBus, session: string): WorkflowContext | undefined {
  const replies: WorkflowContext[] = [];
  let open = true;
  bus.emit(CONTEXT_EVENT, {
    version: 1,
    session,
    respond(value: WorkflowContext) {
      if (!open) return;
      replies.push(structuredClone(value));
    },
  } satisfies Request);
  open = false;
  if (replies.length > 1) throw new Error("Conflicting workflow context registrations.");
  const value = replies[0];
  if (value && (value.version !== 1 || value.session !== session || !value.scope))
    throw new Error("Invalid workflow context response.");
  return value;
}

/** Owner calls replace/revoke before starting asynchronous cancellation or UI work. */
export class WorkflowScope {
  private current?: WorkflowContext;
  private readonly unsubscribe: () => void;
  constructor(private readonly bus: EventBus) {
    this.unsubscribe = bus.on(CONTEXT_EVENT, (value) => {
      if (request(value) && this.current?.session === value.session) value.respond(structuredClone(this.current));
    });
  }
  replace(session: string, restrictions?: RestrictionSnapshot): WorkflowContext {
    if (!session) throw new Error("Missing owner session.");
    this.revoke("replacement");
    this.current = {
      version: 1,
      session,
      scope: randomUUID(),
      held: false,
      ...(restrictions ? { restrictions: structuredClone(restrictions) } : {}),
    };
    this.bus.emit(SCOPE_EVENT, { ...structuredClone(this.current), action: "replace" });
    return structuredClone(this.current);
  }
  hold(held: boolean): void {
    if (!this.current || this.current.held === held) return;
    this.current.held = held;
    this.bus.emit(SCOPE_EVENT, { action: "hold", ...structuredClone(this.current) });
  }
  revoke(reason: string): void {
    const previous = this.current;
    this.current = undefined;
    if (previous) this.bus.emit(SCOPE_EVENT, { ...previous, action: "revoke", reason });
  }
  owns(scope: string): boolean {
    return this.current?.scope === scope;
  }
  dispose(): void {
    this.revoke("dispose");
    this.unsubscribe();
  }
}
