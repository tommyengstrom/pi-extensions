import { describe, expect, it } from "vitest";
import { JobTree, LIMITS } from "../src/tree.js";

function fixture() {
  let now = 1000;
  const tree = new JobTree("root", () => now);
  const launch = (caller = "root", group = "request") => {
    const job = tree.reserve({ caller, group, scope: "scope", task: "Inspect" });
    tree.allocate(job.id, job.attempt, "core", "t3");
    tree.acknowledge(job.id, job.attempt);
    return job;
  };
  return {
    tree,
    launch,
    advance() {
      now += LIMITS.milliseconds;
    },
  };
}
describe("root-owned job tree", () => {
  it("binds nested jobs to immediate parent authority and original request", () => {
    const { tree, launch } = fixture();
    const parent = launch();
    const child = launch(parent.id, "forged");
    expect(child.group).toBe(parent.group);
    expect(child.depth).toBe(2);
    expect(child.parent).toBe(parent.id);
    expect(() => launch(child.id)).toThrow(/depth/);
    expect(() => tree.authorize(child.id, parent.id)).toThrow();
    const sibling = launch();
    expect(() => tree.authorize(parent.id, sibling.id)).toThrow();
    expect(() => tree.authorize(parent.id, child.id)).not.toThrow();
    expect(() => tree.authorize("root", child.id)).not.toThrow();
  });
  it("counts uncertain launches and rejects capacity instead of queueing", () => {
    const { tree, launch } = fixture();
    const uncertain = launch();
    tree.uncertain(uncertain.id);
    launch();
    launch();
    launch();
    expect(() => launch()).toThrow(/capacity/);
    expect(tree.list()).toHaveLength(4);
  });
  it("does not reset accepted quota after jobs settle", () => {
    const { tree, launch } = fixture();
    for (let i = 0; i < LIMITS.accepted; i++) {
      const job = launch();
      tree.settle(job.id, "result.md");
      tree.confirmExecutionStopped(job.id);
    }
    expect(() => launch()).toThrow(/request job limit/);
    expect(() => launch("root", "next-human-request")).not.toThrow();
  });
  it("waits without spinning turns until descendants settle", () => {
    const { tree, launch } = fixture();
    const parent = launch();
    const child = launch(parent.id);
    expect(tree.settle(parent.id, "draft.md")).toBe("waiting");
    expect(() => tree.charge(parent.id, "turn")).toThrow();
    expect(() => tree.resumeSynthesis(parent.id)).toThrow();
    tree.settle(child.id, "child.md");
    expect(() => tree.resumeSynthesis(parent.id)).toThrow();
    tree.confirmExecutionStopped(child.id);
    tree.resumeSynthesis(parent.id);
    tree.charge(parent.id, "turn");
    expect(tree.settle(parent.id, "final.md")).toBe("succeeded");
    expect(() => tree.steer("root", parent.id)).toThrow();
  });
  it("cancels subtrees deepest-first and requires stop confirmation", () => {
    const { tree, launch } = fixture();
    const parent = launch();
    const child = launch(parent.id);
    expect(tree.cancel("root", parent.id)).toEqual([child.id, parent.id]);
    expect(() => tree.confirmStopped(parent.id, "cancelled")).toThrow();
    tree.confirmStopped(child.id, "cancelled");
    tree.confirmStopped(parent.id, "cancelled");
    expect(tree.get(parent.id).state).toBe("cancelled");
  });
  it("records late allocations without dispatching after revocation", () => {
    const { tree } = fixture();
    const job = tree.reserve({ caller: "root", group: "request", scope: "scope", task: "Inspect" });
    tree.revoke("scope");
    tree.allocate(job.id, job.attempt, "core", "t5");
    expect(tree.get(job.id).terminal).toBe("t5");
    expect(tree.get(job.id).state).toBe("cancelling");
    expect(() => tree.acknowledge(job.id, job.attempt)).toThrow();
  });
  it("freezes launch and steering during review", () => {
    const { tree, launch } = fixture();
    const parent = launch();
    tree.hold("scope", true);
    expect(() => launch()).toThrow();
    expect(() => tree.steer("root", parent.id)).toThrow();
    tree.hold("scope", false);
    expect(() => tree.steer("root", parent.id)).not.toThrow();
  });
  it("retains live capacity until successful processes actually exit", () => {
    const { tree, launch } = fixture();
    const jobs = Array.from({ length: 4 }, () => launch());
    for (const job of jobs) tree.settle(job.id, "result.md");
    expect(() => launch()).toThrow(/capacity/);
    tree.confirmExecutionStopped(jobs[0].id);
    expect(() => launch()).not.toThrow();
  });
  it("retains deadlines and budgets during steering", () => {
    const { tree, launch, advance } = fixture();
    const job = launch();
    for (let i = 0; i < LIMITS.turns; i++) tree.charge(job.id, "turn");
    tree.steer("root", job.id);
    expect(() => tree.charge(job.id, "turn")).toThrow(/Turn limit/);
    for (let i = 0; i < LIMITS.calls; i++) tree.charge(job.id, "call");
    expect(() => tree.charge(job.id, "call")).toThrow(/Tool call limit/);
    advance();
    expect(tree.expired()).toContain(job.id);
    expect(() => tree.steer("root", job.id)).toThrow(/deadline/);
  });
});
