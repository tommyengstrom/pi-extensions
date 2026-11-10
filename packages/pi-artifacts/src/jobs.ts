import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { type RunInput, runArtifact, type Selection } from "./agent.js";
import { ConfinedMutations, directoryIdentity } from "./confined-tools.js";
import { diagnostic, pending } from "./contract.js";
import type { Artifact, ArtifactStore, Job } from "./store.js";

interface Work {
  artifact: Artifact;
  job: Job;
  task: string;
  selection: Selection;
  controller: AbortController;
  done: Promise<Job>;
  resolve(value: Job): void;
  started: boolean;
}
export class ArtifactJobs {
  private readonly work = new Map<string, Work>();
  private running = 0;
  private closed = false;
  private scheduled = false;
  constructor(
    readonly store: ArtifactStore,
    readonly owner: string,
    private readonly callbacks: {
      accepted(job: Job): void;
      terminal(job: Job): void;
      progress(text: string): void;
    },
    private readonly run: (input: RunInput) => Promise<string> = runArtifact,
  ) {}

  submit(
    input: { directory: string; source: string } | { artifactId: string },
    task: string,
    selection: Selection,
  ): Job {
    if (this.closed) throw new Error("Artifact session has ended.");
    if (!task.trim() || task.length > 32000) throw new Error("Artifact task must contain 1–32000 characters.");
    const captured = { ...selection, model: structuredClone(selection.model) };
    const accepted =
      "artifactId" in input
        ? this.store.update(input.artifactId, this.owner)
        : this.store.create(input.directory, input.source, this.owner);
    const deferred = Promise.withResolvers<Job>();
    const work: Work = {
      ...accepted,
      task,
      selection: captured,
      controller: new AbortController(),
      done: deferred.promise,
      resolve: deferred.resolve,
      started: false,
    };
    this.work.set(work.job.jobId, work);
    try {
      work.job = this.store.change(work.job, {
        model: { provider: captured.model.provider, id: captured.model.id },
        thinkingLevel: captured.thinkingLevel,
      });
      this.callbacks.accepted(work.job);
    } catch (error) {
      const failed = this.store.failAccepted(work.job, error);
      work.job = failed;
      work.resolve(failed);
      throw error;
    }
    this.schedule();
    return structuredClone(work.job);
  }
  private schedule() {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.pump();
    }, 0);
  }
  private pump() {
    if (this.closed) return;
    for (const work of this.work.values()) {
      if (this.running >= 2) return;
      if (work.started || !pending(work.job.status)) continue;
      work.started = true;
      this.running++;
      void this.execute(work).finally(() => {
        this.running--;
        this.schedule();
      });
    }
  }
  private async execute(work: Work) {
    let backend: ConfinedMutations | undefined;
    let staging: string | undefined;
    let summary = "Artifact generation interrupted.";
    let status: Job["status"] = "failed";
    let paths: string[] = [];
    let usage: Usage | undefined;
    const signal = AbortSignal.any([work.controller.signal, AbortSignal.timeout(10 * 60 * 1000)]);
    try {
      signal.throwIfAborted();
      this.store.assertOwned(work.job);
      work.job = this.store.change(work.job, { status: "running", summary: "Generating artifact in background." });
      if (JSON.stringify(directoryIdentity(work.artifact.root.path)) !== JSON.stringify(work.artifact.root))
        throw new Error("Artifact root identity changed.");
      // Private, unaddressable by mutation tools; supports output on a different volume.
      // No manifests, credentials, or conversation history live in this temporary directory.
      staging = mkdtempSync(join(work.artifact.root.path, ".pi-artifact-staging-"));
      work.job = this.store.change(work.job, { staging: directoryIdentity(staging) });
      backend = new ConfinedMutations({
        root: work.artifact.root,
        staging: directoryIdentity(staging),
        containedStaging: true,
        assertOwned: () => {
          signal.throwIfAborted();
          this.store.assertOwned(work.job);
        },
      });
      summary = await this.run({
        artifact: work.artifact,
        task: work.task,
        selection: work.selection,
        backend,
        signal,
        control: this.store.directory,
        progress: (text) => {
          if (!this.closed && !signal.aborted) this.callbacks.progress(diagnostic(text));
        },
        usage: (next) => {
          if (!usage) usage = structuredClone(next);
          else {
            for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
              usage[key] += next[key];
            for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
              usage.cost[key] += next.cost[key];
          }
        },
      });
      signal.throwIfAborted();
      paths = backend.outputPaths();
      if (!paths.length) throw new Error("Artifact agent completed without any output files.");
      status = "succeeded";
    } catch (error) {
      status = work.controller.signal.aborted ? "cancelled" : "failed";
      summary = `${diagnostic(error)} Partial files and saved conversation are retained.`.slice(0, 2000);
    } finally {
      await backend?.drain();
      // An aborted backend correctly refuses even inventory. Read retained files using
      // a fresh ownership-only backend after all mutation I/O has drained.
      if (staging) {
        try {
          paths = new ConfinedMutations({
            root: work.artifact.root,
            staging: directoryIdentity(staging),
            containedStaging: true,
            assertOwned: () => this.store.assertOwned(work.job),
          }).outputPaths();
        } catch {
          /* Invalid output is never advertised as success. */
        }
        try {
          this.store.assertOwned(work.job);
          if (
            JSON.stringify(directoryIdentity(work.artifact.root.path)) === JSON.stringify(work.artifact.root) &&
            work.job.staging &&
            JSON.stringify(directoryIdentity(staging)) === JSON.stringify(work.job.staging)
          )
            rmSync(staging, { recursive: true });
        } catch {
          /* Retain private staging on ownership/cleanup failure; never follow redirection. */
        }
      }
      try {
        work.job = this.store.change(work.job, {
          status,
          summary: diagnostic(summary),
          paths,
          ...(usage ? { usage } : {}),
        });
      } catch (error) {
        work.job = {
          ...work.job,
          status: "interrupted",
          summary: `Unable to persist terminal state: ${diagnostic(error)}`,
        };
      }
      work.resolve(structuredClone(work.job));
      try {
        if (!this.closed) this.callbacks.terminal(work.job);
      } catch {
        /* Durable result remains available through status/wait. */
      }
    }
  }
  status(id: string): Job {
    return this.store.status(id);
  }
  async wait(ids: string[], signal?: AbortSignal): Promise<Job[]> {
    if (!ids.length || ids.length > 100) throw new Error("Specify 1–100 job identifiers.");
    const promises = ids.map((id) => {
      const status = this.store.status(id);
      const local = this.work.get(id);
      if (!pending(status.status)) return Promise.resolve(status);
      if (!local) throw new Error("This job is owned by another live process/session; wait there or use status later.");
      return local.done;
    });
    if (!signal) return Promise.all(promises);
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      Promise.all(promises)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async cancel(id: string): Promise<Job> {
    const current = this.store.status(id);
    if (!pending(current.status)) return current;
    const work = this.work.get(id);
    if (!work || current.owner !== this.owner) throw new Error("Cannot cancel another live session's job.");
    work.controller.abort(new Error("Artifact job cancelled."));
    if (!work.started) {
      work.job = this.store.change(work.job, {
        status: "cancelled",
        summary: "Cancelled before child startup. Claim and conversation retained.",
      });
      work.resolve(work.job);
      if (!this.closed) this.callbacks.terminal(work.job);
    }
    return work.done;
  }
  async cancelOwned(ids?: string[]) {
    const owned = [...this.work.values()].filter((w) => pending(w.job.status) && (!ids || ids.includes(w.job.jobId)));
    // Stop provider work even when damaged persistence prevents a status transition.
    for (const work of owned) work.controller.abort(new Error("Artifact owner cancelled work."));
    try {
      await Promise.all(owned.map((work) => this.cancel(work.job.jobId)));
    } finally {
      await Promise.all(owned.filter((work) => work.started).map((work) => work.done));
    }
  }
  async close() {
    this.closed = true;
    await this.cancelOwned();
  }
}
