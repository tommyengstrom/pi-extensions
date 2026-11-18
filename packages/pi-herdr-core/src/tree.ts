import { randomUUID } from "node:crypto";

export const LIMITS = Object.freeze({ depth: 2, live: 4, accepted: 12, milliseconds: 600_000, turns: 40, calls: 160 });
export type JobState =
  | "intent"
  | "allocated"
  | "running"
  | "waiting"
  | "cancelling"
  | "uncertain"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface JobRecord {
  version: 1;
  id: string;
  attempt: string;
  root: string;
  parent: string;
  group: string;
  scope: string;
  depth: number;
  task: string;
  state: JobState;
  created: number;
  deadline: number;
  turns: number;
  calls: number;
  executionStopped?: boolean;
  terminal?: string;
  core?: string;
  result?: string;
}
const final = new Set<JobState>(["succeeded", "failed", "cancelled", "interrupted"]);
export function terminalState(state: JobState): boolean {
  return final.has(state);
}

/** Pure root-owned authority/accounting. Never construct one of these inside a child. */
export class JobTree {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly accepted = new Map<string, number>();
  private readonly revoked = new Set<string>();
  private readonly held = new Set<string>();
  constructor(
    readonly root: string,
    private readonly now = Date.now,
    private readonly id = randomUUID,
  ) {
    if (!root) throw new Error("Missing root owner.");
  }
  list(): JobRecord[] {
    return structuredClone([...this.jobs.values()]);
  }
  get(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown job.");
    return structuredClone(job);
  }
  private mutable(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown job.");
    return job;
  }
  private live(job: JobRecord): void {
    if (terminalState(job.state) || job.state === "cancelling" || job.state === "uncertain")
      throw new Error("Job is not controllable.");
    if (this.revoked.has(job.scope)) throw new Error("Job scope revoked.");
    if (this.now() >= job.deadline) throw new Error("Job deadline exceeded.");
  }
  /** Caller identity must come from the authenticated connection, never request JSON. */
  authorize(caller: string, target: string): void {
    let cursor = this.mutable(target);
    if (caller === target) throw new Error("A child cannot control itself through descendant tools.");
    const seen = new Set<string>();
    while (!seen.has(cursor.id)) {
      if (cursor.parent === caller) return;
      seen.add(cursor.id);
      if (cursor.parent === this.root) break;
      cursor = this.mutable(cursor.parent);
    }
    throw new Error("Only descendants are controllable.");
  }
  reserve(input: { caller: string; group: string; scope: string; task: string }): JobRecord {
    if (!input.task.trim() || Buffer.byteLength(input.task) > 32_000)
      throw new Error("Task must contain 1–32000 bytes.");
    let depth = 1;
    let group = input.group;
    let scope = input.scope;
    if (input.caller !== this.root) {
      const parent = this.mutable(input.caller);
      this.live(parent);
      if (parent.state !== "running") throw new Error("Parent is not running.");
      depth = parent.depth + 1;
      group = parent.group;
      scope = parent.scope;
    }
    if (!group || !scope || this.revoked.has(scope) || this.held.has(scope))
      throw new Error("Scope unavailable or held for review.");
    if (depth > LIMITS.depth) throw new Error("Delegation depth limit reached.");
    // Uncertain/cancelling jobs retain their slot until termination is confirmed.
    if ([...this.jobs.values()].filter((job) => !job.executionStopped).length >= LIMITS.live)
      throw new Error("Live delegation capacity reached; no queue is available.");
    const count = this.accepted.get(group) ?? 0;
    if (count >= LIMITS.accepted) throw new Error("Human request job limit reached.");
    const created = this.now();
    const job: JobRecord = {
      version: 1,
      id: this.id(),
      attempt: this.id(),
      root: this.root,
      parent: input.caller,
      group,
      scope,
      depth,
      task: input.task,
      state: "intent",
      created,
      deadline: created + LIMITS.milliseconds,
      turns: 0,
      calls: 0,
    };
    if (this.jobs.has(job.id) || job.id === this.root) throw new Error("Job identity collision.");
    this.accepted.set(group, count + 1);
    this.jobs.set(job.id, job);
    return structuredClone(job);
  }
  allocate(id: string, attempt: string, core: string, terminal: string): void {
    const job = this.mutable(id);
    if (job.attempt !== attempt || !["intent", "uncertain", "cancelling"].includes(job.state))
      throw new Error("Unexpected allocation acknowledgement.");
    if (!core || terminal.trim() !== terminal || !/^t[1-9][0-9]*$/.test(terminal))
      throw new Error("Invalid local Core allocation.");
    if (job.terminal && (job.terminal !== terminal || job.core !== core))
      throw new Error("Attempt acquired conflicting terminals.");
    job.core = core;
    job.terminal = terminal;
    // A late response to a cancelled launch records the acquired handle for cleanup only.
    if (job.state !== "cancelling" && !this.revoked.has(job.scope)) job.state = "allocated";
  }
  acknowledge(id: string, attempt: string): void {
    const job = this.mutable(id);
    this.live(job);
    if (job.attempt !== attempt || job.state !== "allocated") throw new Error("Unexpected child acknowledgement.");
    if (this.held.has(job.scope)) throw new Error("Scope held before dispatch.");
    job.state = "running";
  }
  uncertain(id: string): void {
    const job = this.mutable(id);
    if (!terminalState(job.state) && job.state !== "cancelling") job.state = "uncertain";
  }
  charge(id: string, kind: "turn" | "call"): void {
    const job = this.mutable(id);
    this.live(job);
    if (job.state !== "running") throw new Error("Provider/tool work outside running state.");
    if (kind === "turn") {
      if (job.turns >= LIMITS.turns) throw new Error("Turn limit reached.");
      job.turns++;
    } else {
      if (job.calls >= LIMITS.calls) throw new Error("Tool call limit reached.");
      job.calls++;
    }
  }
  hold(scope: string, held: boolean): void {
    if (held) this.held.add(scope);
    else this.held.delete(scope);
  }
  steer(caller: string, target: string): void {
    this.authorize(caller, target);
    const job = this.mutable(target);
    this.live(job);
    if (this.held.has(job.scope) || !["running", "waiting"].includes(job.state))
      throw new Error("Steering unavailable.");
  }
  private descendants(id: string): JobRecord[] {
    return [...this.jobs.values()].filter((job) => {
      try {
        this.authorize(id, job.id);
        return true;
      } catch {
        return false;
      }
    });
  }
  settle(id: string, result: string, needsSynthesis = false): "waiting" | "succeeded" {
    const job = this.mutable(id);
    this.live(job);
    if (job.state !== "running") throw new Error("Unexpected child settlement.");
    if (!result || result.length > 4096) throw new Error("A bounded result reference is required.");
    if (needsSynthesis || this.descendants(id).some((child) => !child.executionStopped)) {
      job.state = "waiting";
      return "waiting";
    }
    job.result = result;
    job.state = "succeeded";
    return "succeeded";
  }
  resumeSynthesis(id: string): void {
    const job = this.mutable(id);
    this.live(job);
    if (
      job.state !== "waiting" ||
      this.held.has(job.scope) ||
      this.descendants(id).some((child) => !child.executionStopped)
    )
      throw new Error("Parent cannot synthesize yet.");
    job.state = "running";
  }
  cancel(caller: string, id: string): string[] {
    this.authorize(caller, id);
    const subtree = [this.mutable(id), ...this.descendants(id)].filter((job) => !job.executionStopped);
    for (const job of subtree) if (!terminalState(job.state)) job.state = "cancelling";
    return subtree.sort((a, b) => b.depth - a.depth).map((job) => job.id);
  }
  revoke(scope: string): string[] {
    this.revoked.add(scope);
    const affected = [...this.jobs.values()].filter((job) => job.scope === scope && !job.executionStopped);
    for (const job of affected) if (!terminalState(job.state)) job.state = "cancelling";
    return affected.sort((a, b) => b.depth - a.depth).map((job) => job.id);
  }
  confirmStopped(id: string, outcome: "cancelled" | "failed" | "interrupted"): void {
    const job = this.mutable(id);
    if (this.descendants(id).some((child) => !child.executionStopped))
      throw new Error("Descendants are not confirmed stopped.");
    if (terminalState(job.state)) {
      job.executionStopped = true;
      return;
    }
    if (outcome === "cancelled" && job.state !== "cancelling") throw new Error("Cancellation was not requested.");
    job.state = outcome;
    job.executionStopped = true;
  }
  confirmExecutionStopped(id: string): void {
    const job = this.mutable(id);
    if (!terminalState(job.state)) throw new Error("An unfinished job requires an explicit stopped outcome.");
    job.executionStopped = true;
  }
  expired(): string[] {
    return [...this.jobs.values()]
      .filter((job) => !terminalState(job.state) && this.now() >= job.deadline)
      .map((job) => job.id);
  }
}
