import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { CONTEXT_EVENT, type EventBus, readWorkflow, SCOPE_EVENT, WorkflowScope } from "../src/context.js";

function bus(): EventBus {
  const emitter = new EventEmitter();
  return {
    emit(name, value) {
      emitter.emit(name, value);
    },
    on(name, fn) {
      emitter.on(name, fn);
      return () => {
        emitter.off(name, fn);
      };
    },
  };
}
describe("workflow context contract", () => {
  it("uses stable scopes until replacement, not per-turn generations", () => {
    const events = bus();
    const owner = new WorkflowScope(events);
    const first = owner.replace("session", { allowedTools: [], parentOnly: ["save"], guidance: "Read only" });
    expect(readWorkflow(events, "session")).toEqual(first);
    owner.hold(true);
    expect(readWorkflow(events, "session")?.scope).toBe(first.scope);
    expect(readWorkflow(events, "session")?.held).toBe(true);
    expect(owner.replace("session").scope).not.toBe(first.scope);
    expect(owner.owns(first.scope)).toBe(false);
    owner.dispose();
    expect(readWorkflow(events, "session")).toBeUndefined();
  });
  it("revokes authority before broadcasting cancellation", () => {
    const events = bus();
    const owner = new WorkflowScope(events);
    const scope = owner.replace("session");
    events.on(SCOPE_EVENT, () => expect(owner.owns(scope.scope)).toBe(false));
    owner.revoke("mode change");
  });
  it("detects conflicting context owners", () => {
    const events = bus();
    new WorkflowScope(events).replace("session");
    new WorkflowScope(events).replace("session");
    expect(() => readWorkflow(events, "session")).toThrow(/Conflicting/);
  });
  it("does not assume emission awaits async responders", async () => {
    const events = bus();
    events.on(CONTEXT_EVENT, (value) => {
      const req = value as { respond: (value: unknown) => void };
      void Promise.resolve().then(() => req.respond({ version: 1, session: "session", scope: "late", held: false }));
    });
    expect(readWorkflow(events, "session")).toBeUndefined();
    await Promise.resolve();
  });
});
