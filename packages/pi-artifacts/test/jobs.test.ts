import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { RunInput, Selection } from "../src/agent.js";
import { ArtifactJobs } from "../src/jobs.js";
import { ArtifactStore, type Job } from "../src/store.js";

let root: string;
let store: ArtifactStore;
const managers: ArtifactJobs[] = [];
const selection = {
  model: { id: "captured", provider: "offline" },
  thinkingLevel: "off",
  modelRegistry: {},
} as Selection;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "artifacts-jobs-"));
  store = new ArtifactStore(join(root, "agent"));
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
  store.close();
  rmSync(root, { recursive: true, force: true });
});
function manager(run: (input: RunInput) => Promise<string>) {
  const accepted: Job[] = [];
  const terminal: Job[] = [];
  const jobs = new ArtifactJobs(
    store,
    "parent:branch",
    {
      accepted: (j) => {
        accepted.push(j);
      },
      terminal: (j) => {
        terminal.push(j);
      },
      progress() {},
    },
    run,
  );
  managers.push(jobs);
  return { jobs, accepted, terminal };
}
async function output(input: RunInput, text = "output") {
  await input.backend.tools()[0].execute("write", { path: "index.html", content: text }, input.signal, undefined, {
    cwd: input.artifact.root.path,
  } as ExtensionToolContext);
}
const tick = () => new Promise<void>((r) => setTimeout(r, 10));

test("claims new/empty destinations durably, including rejected hidden files and concurrent store claims", () => {
  const { jobs } = manager(async (input) => {
    await output(input);
    return "done";
  });
  const hidden = join(root, "hidden");
  mkdirSync(hidden);
  writeFileSync(join(hidden, ".hidden"), "no");
  expect(() => jobs.submit({ directory: hidden, source: root }, "task", selection)).toThrow(/empty/);
  const first = jobs.submit({ directory: "nested/new", source: root }, "task", selection);
  expect(first.status).toBe("queued");
  expect(store.getArtifact(first.artifactId).root.path).toBe(join(root, "nested/new"));
  expect(readFileSync(store.getArtifact(first.artifactId).history, "utf8")).toContain('"type":"session"');
  const other = new ArtifactStore(join(root, "agent"));
  try {
    expect(() => other.create(first.directory, root, "other")).toThrow(/claimed/);
    expect(() => other.create(join(first.directory, "child"), root, "other")).toThrow(/overlaps/);
  } finally {
    other.close();
  }
});

test("acknowledges before work completes, runs two jobs, and cancels queued work without startup", async () => {
  const release = Promise.withResolvers<void>();
  const started: string[] = [];
  const { jobs, terminal } = manager(async (input) => {
    started.push(input.artifact.id);
    await release.promise;
    await output(input);
    return "done";
  });
  const first = jobs.submit({ directory: "one", source: root }, "task", selection);
  const second = jobs.submit({ directory: "two", source: root }, "task", selection);
  const third = jobs.submit({ directory: "three", source: root }, "task", selection);
  expect(started).toEqual([]);
  await tick();
  expect(started).toHaveLength(2);
  expect(jobs.status(third.jobId).status).toBe("queued");
  expect((await jobs.cancel(third.jobId)).status).toBe("cancelled");
  release.resolve();
  expect((await jobs.wait([first.jobId, second.jobId])).every((j) => j.status === "succeeded")).toBe(true);
  expect(started).toHaveLength(2);
  expect(terminal).toHaveLength(3);
});

test("rejects simultaneous feedback, captures queued model selection, and stale cancellation cannot stop a later run", async () => {
  const seen: string[] = [];
  const { jobs } = manager(async (input) => {
    seen.push(input.selection.model.id);
    await output(input, input.task);
    return "done";
  });
  const mutable = { ...selection, model: { ...selection.model } };
  const first = jobs.submit({ directory: "artifact", source: root }, "first", mutable);
  mutable.model.id = "changed";
  expect(() => jobs.submit({ artifactId: first.artifactId }, "overlap", selection)).toThrow(/queued\/running/);
  await jobs.wait([first.jobId]);
  const second = jobs.submit({ artifactId: first.artifactId }, "second", selection);
  expect((await jobs.cancel(first.jobId)).status).toBe("succeeded");
  await jobs.wait([second.jobId]);
  expect(seen).toEqual(["captured", "captured"]);
  expect(readFileSync(join(first.directory, "index.html"), "utf8")).toBe("second");
});

test("failed generation retains identity and partial files and never reruns through status/wait", async () => {
  let calls = 0;
  const { jobs } = manager(async (input) => {
    calls++;
    await output(input);
    throw new Error("provider failure\u001b[31m");
  });
  const first = jobs.submit({ directory: "artifact", source: root }, "first", selection);
  const [failed] = await jobs.wait([first.jobId]);
  expect(failed.status).toBe("failed");
  expect(failed.paths).toEqual([join(first.directory, "index.html")]);
  expect(failed.summary).not.toContain("\u001b");
  expect((await jobs.wait([first.jobId]))[0].status).toBe("failed");
  expect(jobs.status(first.jobId).status).toBe("failed");
  expect(calls).toBe(1);
  const next = jobs.submit({ artifactId: first.artifactId }, "feedback", selection);
  await jobs.wait([next.jobId]);
  expect(calls).toBe(2);
});

test("shutdown drains an active child and preserves partial output", async () => {
  const wrote = Promise.withResolvers<void>();
  const { jobs } = manager(async (input) => {
    await output(input);
    wrote.resolve();
    await new Promise<void>((_resolve, reject) =>
      input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }),
    );
    return "unreachable";
  });
  const first = jobs.submit({ directory: "artifact", source: root }, "first", selection);
  await wrote.promise;
  await jobs.close();
  expect(jobs.status(first.jobId).status).toBe("cancelled");
  expect(readFileSync(join(first.directory, "index.html"), "utf8")).toBe("output");
});

test("reconciles dead-owner jobs but never steals a live job's lease", () => {
  const first = store.create(join(root, "artifact"), root, "owner");
  expect(() => store.update(first.artifact.id, "other")).toThrow(/queued\/running/);
  const database = new DatabaseSync(join(store.directory, "state.sqlite"));
  try {
    const stale = { ...first.job, pid: 2147483647 };
    database.prepare("UPDATE jobs SET data=? WHERE id=?").run(JSON.stringify(stale), stale.jobId);
    expect(store.status(stale.jobId).status).toBe("interrupted");
    const update = store.update(stale.artifactId, "other");
    expect(update.job.status).toBe("queued");
    expect(() => store.assertOwned(stale)).toThrow(/ownership/);
  } finally {
    database.close();
  }
});

test("invalid persisted manifests, unknown identifiers and output/control overlap fail closed", () => {
  expect(() => store.status("unknown")).toThrow(/Unknown/);
  expect(() => store.create(store.directory, root, "owner")).toThrow(/overlaps/);
  const first = store.create(join(root, "artifact"), root, "owner");
  const database = new DatabaseSync(join(store.directory, "state.sqlite"));
  try {
    database.prepare("UPDATE jobs SET data=? WHERE id=?").run('{"version":99}', first.job.jobId);
    expect(() => store.status(first.job.jobId)).toThrow(/Invalid/);
    expect(database.prepare("SELECT data FROM jobs WHERE id=?").get(first.job.jobId)?.data).toBe('{"version":99}');
  } finally {
    database.close();
  }
});
