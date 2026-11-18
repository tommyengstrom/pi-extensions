/* biome-ignore-all lint/style/noNonNullAssertion: These fixtures deliberately require an available queue claim. */
import { describe, expect, it } from "vitest";
import { type Notice, NotificationQueue } from "../src/queue.js";

function notice(id = "event", wake = true): Notice {
  return {
    id,
    jobId: "job",
    session: "session",
    scope: "scope",
    topic: "result",
    summary: "Finished",
    result: "result.md",
    wake,
  };
}
function queue(capacity = 128) {
  const result = new NotificationQueue(capacity);
  result.replace("session");
  return result;
}
describe("live notification queue", () => {
  it("does not consume proposed entries", () => {
    const q = queue();
    q.enqueue(notice());
    const proposal = q.claim({ idle: false, pendingUserWork: false });
    expect(proposal?.notices).toHaveLength(1);
    expect(q.status().pending).toBe(1);
    expect(q.claim({ idle: false, pendingUserWork: false })).toBeUndefined();
    q.release(proposal!.token);
    expect(q.claim({ idle: false, pendingUserWork: false })?.notices).toHaveLength(1);
  });
  it("requires committed evidence and keeps event IDs deduplicated", () => {
    const q = queue();
    q.enqueue(notice());
    q.committed("old-session", ["event"]);
    expect(q.status().pending).toBe(1);
    q.committed("session", ["event"]);
    expect(q.status().pending).toBe(0);
    expect(q.enqueue(notice())).toBe("duplicate");
  });
  it("keeps artifacts passive and does not repeatedly wake for a failed send", () => {
    const q = queue();
    q.enqueue(notice("artifact", false));
    expect(q.claim({ idle: true, pendingUserWork: false })).toBeUndefined();
    q.enqueue(notice("child"));
    const proposal = q.claim({ idle: true, pendingUserWork: false });
    expect(proposal?.notices).toHaveLength(2);
    q.release(proposal!.token);
    expect(q.claim({ idle: true, pendingUserWork: false })).toBeUndefined();
    expect(q.claim({ idle: false, pendingUserWork: false })?.notices).toHaveLength(2);
  });
  it("holds review, UI and compaction independently and prefers user work", () => {
    const q = queue();
    q.enqueue(notice());
    q.hold("review", true);
    q.hold("ui", true);
    q.hold("review", false);
    expect(q.claim({ idle: false, pendingUserWork: false })).toBeUndefined();
    q.hold("ui", false);
    q.hold("compaction", true);
    expect(q.claim({ idle: true, pendingUserWork: false })).toBeUndefined();
    q.hold("compaction", false);
    expect(q.claim({ idle: true, pendingUserWork: true })).toBeUndefined();
    expect(q.claim({ idle: true, pendingUserWork: false })).toBeDefined();
  });
  it("revokes synchronously and rejects late completions", () => {
    const q = queue();
    q.enqueue(notice());
    q.revoke("scope");
    expect(q.status().pending).toBe(0);
    expect(q.enqueue(notice("late"))).toBe("stale");
    q.replace("replacement");
    expect(q.enqueue(notice())).toBe("stale");
  });
  it("bounds queue and summaries without silently evicting results", () => {
    const q = queue(1);
    expect(q.enqueue(notice())).toBe("queued");
    expect(q.enqueue(notice("overflow"))).toBe("full");
    expect(() => q.enqueue({ ...notice("large"), summary: "é".repeat(4097) })).toThrow();
  });
  it("claims explicit results provisionally and does not consume status", () => {
    const q = queue();
    q.enqueue(notice());
    const claim = q.claimResults("session", ["event"]);
    expect(claim?.notices).toHaveLength(1);
    expect(q.status("scope").pending).toBe(1);
    q.release(claim!.token);
    expect(q.claimResults("session", ["event"])?.notices).toHaveLength(1);
    q.committed("session", ["event"]);
    expect(q.status("scope").pending).toBe(0);
  });
  it("recognizes a committed result before its completion callback arrives", () => {
    const q = queue();
    q.committed("session", ["event"]);
    expect(q.enqueue(notice())).toBe("duplicate");
  });
  it("defends its snapshots against caller mutation", () => {
    const q = queue();
    const original = notice();
    q.enqueue(original);
    original.summary = "changed";
    const claim = q.claim({ idle: false, pendingUserWork: false });
    expect(claim?.notices[0].summary).toBe("Finished");
  });
});
