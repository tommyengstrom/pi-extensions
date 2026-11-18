import { describe, expect, it } from "vitest";
import { backgroundFixture } from "../../../test/background-fixture.js";
import { WorkflowScope } from "../src/context.js";
import { backgroundRuntime, backgroundStatus, NOTICE_TYPE } from "../src/runtime.js";

async function fixture() {
  const f = backgroundFixture();
  const runtime = backgroundRuntime(f.pi);
  await f.emit("session_start");
  const recipient = runtime.recipient(f.ctx);
  const notice = (id = "event", wake = true) => ({
    ...recipient,
    id,
    jobId: "job",
    topic: "result",
    summary: "Done",
    result: "result.md",
    wake,
  });
  return { ...f, runtime, recipient, notice };
}
describe("shared Pi runtime notification integration", () => {
  it("installs only one dispatcher and tears down event-bus registrations", async () => {
    const f = await fixture();
    expect(backgroundRuntime(f.pi)).toBe(f.runtime);
    expect(f.handlerCount("turn_end")).toBe(1);
    await f.emit("session_shutdown");
    expect(f.handlerCount("turn_end")).toBe(0);
    expect(f.emitter.listenerCount("pi-background:dispatcher:v1")).toBe(0);
    expect(backgroundRuntime(f.pi)).not.toBe(f.runtime);
    await f.emit("session_shutdown");
  });
  it("preserves prior boundary proposals and only consumes committed evidence", async () => {
    const f = await fixture();
    f.setIdle(false);
    f.runtime.enqueue(f.notice());
    const previous = { type: "custom", customType: "other-extension", data: { keep: true } };
    const proposed = await f.emit("turn_end", { outcome: "completed", entries: [previous] });
    const entries = proposed.entries as Record<string, unknown>[];
    expect(entries[0]).toEqual(previous);
    expect(entries[1].customType).toBe(NOTICE_TYPE);
    expect(backgroundStatus(f.pi, f.recipient.scope).pending).toBe(1);
    // Simulate a later handler rejecting the complete proposal: nothing persisted.
    await f.emit("turn_start");
    const retry = await f.emit("turn_end", { outcome: "completed", entries: [] });
    expect(retry.entries).toHaveLength(1);
    f.entries.push(...(retry.entries as Record<string, unknown>[]));
    await f.emit("turn_start");
    expect(backgroundStatus(f.pi, f.recipient.scope).pending).toBe(0);
    expect(f.runtime.enqueue(f.notice())).toBe("duplicate");
    await f.emit("session_shutdown");
  });
  it("holds nested UI prompts and compaction without waking early", async () => {
    const f = await fixture();
    await f.emit("ui_prompt_start");
    await f.emit("ui_prompt_start");
    f.runtime.enqueue(f.notice());
    await f.emit("ui_prompt_end");
    expect(f.sendMessage).not.toHaveBeenCalled();
    await f.emit("session_before_compact");
    await f.emit("ui_prompt_end");
    expect(f.sendMessage).not.toHaveBeenCalled();
    await f.emit("session_compact_failed");
    await f.emit("agent_settled", { aborted: false });
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    // Invocation is not a receipt. Failed/no commitment never earns another idle wake.
    expect(backgroundStatus(f.pi, f.recipient.scope).pending).toBe(1);
    await f.emit("agent_settled", { aborted: false });
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    await f.emit("session_shutdown");
  });
  it("keeps artifact completion passive and prefers queued human work", async () => {
    const f = await fixture();
    f.runtime.enqueue(f.notice("artifact", false));
    expect(f.sendMessage).not.toHaveBeenCalled();
    f.setPending(true);
    f.runtime.enqueue(f.notice("child"));
    expect(f.sendMessage).not.toHaveBeenCalled();
    f.setPending(false);
    await f.emit("agent_settled", { aborted: false });
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    await f.emit("session_shutdown");
  });
  it("deduplicates explicit waits by committed tool results, not invocation", async () => {
    const f = await fixture();
    f.setIdle(false);
    f.runtime.enqueue(f.notice());
    const details = f.runtime.resultDetails(f.recipient, ["event"]);
    expect(backgroundStatus(f.pi, f.recipient.scope).pending).toBe(1);
    f.entries.push({ type: "message", message: { role: "toolResult", toolName: "subagent_wait", details } });
    await f.emit("turn_end", { outcome: "completed", entries: [] });
    expect(backgroundStatus(f.pi, f.recipient.scope).pending).toBe(0);
    await f.emit("session_shutdown");
  });
  it("does not treat arbitrary prose or unrelated tool details as receipts", async () => {
    const f = await fixture();
    f.setIdle(false);
    f.runtime.enqueue(f.notice());
    f.entries.push({ type: "message", message: { role: "assistant", content: "event was delivered" } });
    f.entries.push({
      type: "message",
      message: { role: "toolResult", toolName: "echo", details: { backgroundEventIds: ["event"] } },
    });
    expect(backgroundStatus(f.pi, f.recipient.scope).pending).toBe(1);
    await f.emit("session_shutdown");
  });
  it("revokes successful navigation only and rejects old callbacks", async () => {
    const f = await fixture();
    f.setIdle(false);
    f.runtime.enqueue(f.notice());
    await f.emit("session_before_tree", { cancel: true });
    expect(f.runtime.owns(f.recipient)).toBe(true);
    await f.emit("session_tree");
    expect(f.runtime.owns(f.recipient)).toBe(false);
    expect(f.runtime.enqueue(f.notice("late"))).toBe("stale");
    expect(f.sendMessage).not.toHaveBeenCalled();
    await f.emit("session_shutdown");
  });
  it("holds review, revokes Normal jobs on entry, and supports fresh work after abort scope rotation", async () => {
    const f = await fixture();
    const workflow = new WorkflowScope(f.pi.events);
    workflow.replace("session", { allowedTools: [], parentOnly: [], guidance: "Inspect" });
    expect(f.runtime.owns(f.recipient)).toBe(false);
    const planning = f.runtime.recipient(f.ctx);
    workflow.hold(true);
    f.runtime.enqueue({ ...f.notice(), ...planning });
    expect(f.sendMessage).not.toHaveBeenCalled();
    await f.emit("agent_settled", { aborted: true });
    expect(f.runtime.owns(planning)).toBe(false);
    // Plan keeps its workflow identity but publishes a fresh revocable execution scope.
    workflow.replace("session", { allowedTools: [], parentOnly: [], guidance: "Inspect" });
    const next = f.runtime.recipient(f.ctx);
    expect(next.scope).not.toBe(planning.scope);
    expect(f.runtime.owns(next)).toBe(true);
    expect(f.runtime.enqueue({ ...f.notice("new"), ...next })).toBe("queued");
    expect(f.runtime.enqueue({ ...f.notice("late"), ...planning })).toBe("stale");
    workflow.dispose();
    await f.emit("session_shutdown");
  });
});
