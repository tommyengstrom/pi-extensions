import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { test, vi } from "vitest";
import { createPlanStore, type PlanRevision, type PlanStore } from "../src/plan-store.js";

// Keep real filesystem behavior while making cleanup failures injectable.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const execFileAsync = promisify(execFile);
const PLAN = "# A useful plan\n\n1. Implement the change.\n2. Verify it.";

async function withStore(
  run: (fixture: { root: string; project: string; agent: string; store: PlanStore }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-store-"));
  try {
    const project = join(root, "project");
    const agent = join(root, "agent");
    await mkdir(project);
    const store = await createPlanStore(project, undefined, agent);
    await run({ root, project, agent, store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function git(cwd: string, ...args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], {
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  });
}

test("default storage uses getAgentDir, contains readable project and title names, and never writes to the project", async () => {
  await withStore(async ({ project, agent, store }) => {
    vi.stubEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const defaultStore = await createPlanStore(project);
      assert.equal(defaultStore.directory, store.directory);
    } finally {
      vi.unstubAllEnvs();
    }
    assert.equal(store.projectRoot, await realpath(project));
    assert.match(basename(store.directory), /^project-[a-f0-9]{64}$/);
    assert.equal(store.directory, join(agent, "pi-plan-mode", "plans", basename(store.directory)));
    assert.deepEqual(await store.list(), []);
    const revision = await store.save(PLAN);
    assert.equal(basename(revision.path), "a-useful-plan-01.md");
    assert.equal(revision.title, "A useful plan");
    assert.equal(await store.read(revision), PLAN);
    assert.deepEqual(await store.list(), [revision]);
    assert.deepEqual(await readdir(project), []);
  });
});

test("revision metadata is atomic, explains changes, and tracks actual parents rather than filename order", async () => {
  await withStore(async ({ store }) => {
    const first = await store.save(PLAN);
    await assert.rejects(store.save("# Changed", { series: first.series, parent: first }), /change reason/);
    const second = await store.save("# Changed", {
      series: first.series,
      parent: first,
      reason: "User requested changed scope.",
    });
    const third = await store.save("# Alternate", {
      series: first.series,
      parent: first,
      reason: "User requested an alternative from the baseline.",
    });
    assert.equal(third.revision, 3);
    assert.equal(third.history?.parent.revision, 1);
    assert.equal(await store.read(second), "# Changed");
    assert.deepEqual(await store.list(), [third, second, first]);
    const unchanged = await store.save("# Alternate", { series: first.series, parent: third });
    assert.equal(unchanged.history?.reason, undefined);
    await writeFile(third.path, "# External replacement");
    await assert.rejects(store.read(third), /metadata has changed/);
    assert.equal(await store.read(first), PLAN);
  });
});

test("Git roots unify nested directories and canonical aliases; linked worktrees get their own canonical root", async () => {
  await withStore(async ({ root, project, agent }) => {
    await git(project, "init", "--quiet");
    await git(
      project,
      "-c",
      "user.name=Plan Test",
      "-c",
      "user.email=plan@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "Initial",
    );
    const nested = join(project, "src", "nested");
    await mkdir(nested, { recursive: true });
    const alias = join(root, "alias");
    await symlink(project, alias);
    const main = await createPlanStore(project, undefined, agent);
    assert.equal((await createPlanStore(nested, undefined, agent)).directory, main.directory);
    assert.equal((await createPlanStore(join(alias, "src"), undefined, agent)).directory, main.directory);
    const worktree = join(root, "worktree");
    await git(project, "worktree", "add", "--quiet", "--detach", worktree);
    await mkdir(join(worktree, "nested"));
    const linked = await createPlanStore(join(worktree, "nested"), undefined, agent);
    assert.equal(linked.projectRoot, await realpath(worktree));
    assert.notEqual(linked.directory, main.directory);
    assert.equal((await createPlanStore(worktree, undefined, agent)).directory, linked.directory);
    await main.save(PLAN);
    assert.deepEqual(await linked.list(), []);
  });
});

test("non-Git cwd fallback and same-named projects have stable, collision-resistant scopes", async () => {
  await withStore(async ({ root, project, agent, store }) => {
    const otherProject = join(root, "other", "project");
    const nested = join(project, "nested");
    await mkdir(otherProject, { recursive: true });
    await mkdir(nested);
    const other = await createPlanStore(otherProject, undefined, agent);
    assert.notEqual(other.directory, store.directory);
    assert.notEqual((await createPlanStore(nested, undefined, agent)).directory, store.directory);
    assert.equal((await createPlanStore(project, undefined, agent)).directory, store.directory);
    const revision = await store.save(PLAN);
    await assert.rejects(other.read(revision), /belong/);
    await assert.rejects(other.save(PLAN, { series: revision.series }), /belong/);
    assert.deepEqual(await other.list(), []);
  });
});

test("configured directory is relative to extension data and rejects lexical escapes", async () => {
  await withStore(async ({ project, agent }) => {
    const custom = await createPlanStore(project, "notes/plans", agent);
    assert.equal(custom.directory, join(agent, "pi-plan-mode", "notes", "plans", basename(custom.directory)));
    for (const option of ["", "..", "../escape", "notes/../../escape", "/tmp/escape", "notes\\escape", "bad\0path"]) {
      await assert.rejects(createPlanStore(project, option, agent), /directory/);
    }
  });
});

test("directory symlinks cannot redirect writes outside the extension data directory", async () => {
  await withStore(async ({ root, project, agent, store }) => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(agent, "pi-plan-mode", "redirect"));
    await assert.rejects(createPlanStore(project, "redirect/plans", agent), /symlink/);
    await rename(store.directory, `${store.directory}-original`);
    await symlink(outside, store.directory);
    await assert.rejects(store.save(PLAN), /symlink/);
    await assert.rejects(store.list(), /symlink/);
    await assert.rejects(
      store.read({
        series: "a-useful-plan",
        revision: 1,
        path: join(store.directory, "a-useful-plan-01.md"),
        title: "",
      }),
      /symlink/,
    );
    assert.deepEqual(await readdir(outside), []);
    const secondAgent = join(root, "second-agent");
    await mkdir(secondAgent);
    await symlink(outside, join(secondAgent, "pi-plan-mode"));
    await assert.rejects(createPlanStore(project, undefined, secondAgent), /symlink/);
  });
});

test("series remain stable when titles change and revisions follow the highest existing number, including 100", async () => {
  await withStore(async ({ project, agent, store }) => {
    const first = await store.save(PLAN);
    const second = await store.save("# A different title\n\nUpdated.", { series: first.series });
    assert.equal(second.series, first.series);
    assert.equal(second.revision, 2);
    assert.equal(second.title, "A different title");
    assert.equal(basename(second.path), "a-useful-plan-02.md");
    await writeFile(join(store.directory, `${first.series}-99.md`), "# Manually retained revision");
    await unlink(first.path);
    const reopened = await createPlanStore(project, undefined, agent);
    const hundredth = await reopened.save("# Yet another title", { series: first.series });
    assert.equal(hundredth.revision, 100);
    assert.equal(basename(hundredth.path), "a-useful-plan-100.md");
    assert.deepEqual(
      (await reopened.list()).map((revision) => revision.revision),
      [100, 99, 2],
    );
  });
});

test("new plans with the same title are independent of existing series even when revision 01 is missing", async () => {
  await withStore(async ({ store }) => {
    const first = await store.save(PLAN);
    const resumed = await store.save(PLAN, { series: first.series });
    await unlink(first.path);
    const independent = await store.save(PLAN);
    assert.notEqual(independent.series, first.series);
    assert.match(independent.series, /^a-useful-plan-[a-f0-9-]+$/);
    assert.equal(independent.revision, 1);
    assert.equal(resumed.revision, 2);
    assert.equal((await store.save("# Changed again", { series: independent.series })).revision, 2);
    assert.equal(await readFile(resumed.path, "utf8"), PLAN);
  });
});

test("concurrent independent store instances create distinct same-title plans and never overwrite revisions", async () => {
  await withStore(async ({ project, agent, store }) => {
    const stores = await Promise.all(Array.from({ length: 8 }, () => createPlanStore(project, undefined, agent)));
    const created = await Promise.all(stores.map((instance) => instance.save(PLAN)));
    assert.equal(new Set(created.map((revision) => revision.series)).size, stores.length);
    assert.ok(created.every((revision) => revision.revision === 1));
    const first = created[0];
    const continued = await Promise.all(
      stores.map((instance, index) => instance.save(`# Revision ${index}`, { series: first.series })),
    );
    assert.deepEqual(
      continued.map((revision) => revision.revision).sort((a, b) => a - b),
      [2, 3, 4, 5, 6, 7, 8, 9],
    );
    assert.equal(new Set(continued.map((revision) => revision.path)).size, stores.length);
    for (const [index, revision] of continued.entries()) {
      assert.equal(await store.read(revision), `# Revision ${index}`);
    }
    assert.equal(await store.read(first), PLAN);
    assert.equal((await readdir(store.directory)).length, 16);
  });
});

test("Markdown headings produce safe bounded kebab-case stems, with a fallback for non-ASCII titles", async () => {
  await withStore(async ({ store }) => {
    const revision = await store.save("```md\n# Not the title\n```\n\n## Café: ../../A **safe** title! ##\n\nBody");
    assert.equal(revision.series, "cafe-a-safe-title");
    assert.equal(revision.title, "Café: ../../A **safe** title!");
    assert.equal((await store.save("Setext title\n============\n\nBody")).series, "setext-title");
    assert.equal((await store.save("# 日本語")).series, "untitled-plan");
    const long = await store.save(`# ${"a".repeat(500)}`);
    assert.equal(long.series.length, 80);
    assert.ok((await store.save(`# ${"a".repeat(500)}`)).series.length <= 120);
    const control = await store.save("# Title\u001b[31m\u0007");
    assert.match(basename(control.path), /^[a-z0-9-]+\.md$/);
    assert.ok(control.title.includes("\u001b"), "Titles are data; terminal sanitization belongs to the UI");
  });
});

test("reads validate full local revision identity and reject symlink plan files", async () => {
  await withStore(async ({ root, store }) => {
    const first = await store.save(PLAN);
    const outside = join(root, "outside.md");
    await writeFile(outside, "# Outside");
    for (const replacement of [
      { path: outside },
      { path: join(store.directory, "..", basename(first.path)) },
      { series: "../escape" },
      { series: "/absolute" },
      { series: "bad\\path" },
      { revision: 0 },
      { revision: 1.5 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { revision: 2 },
    ]) {
      await assert.rejects(store.read({ ...first, ...replacement }));
    }
    for (const series of ["", "../escape", "/absolute", "bad\\path", "bad\0path", "a".repeat(121)]) {
      await assert.rejects(store.save(PLAN, { series }), /series/);
    }
    await unlink(first.path);
    await symlink(outside, first.path);
    await assert.rejects(store.read(first));
    assert.deepEqual(await store.list(), []);
    const replacement = await store.save(PLAN);
    assert.notEqual(replacement.path, first.path);
    assert.equal(await readFile(outside, "utf8"), "# Outside");
  });
});

test("content limits use JavaScript characters rather than UTF-8 bytes and invalid disk content is bounded", async () => {
  await withStore(async ({ store }) => {
    const maximum = "😀".repeat(25_000);
    const revision = await store.save(`  ${maximum}\n`);
    assert.equal(await store.read(revision), maximum);
    await assert.rejects(store.save(`${maximum}x`), /50000/);
    await assert.rejects(store.save(" \n "), /empty/);
    for (const [name, content] of [
      ["oversized-01.md", "x".repeat(50_001)],
      ["huge-01.md", "x".repeat(150_001)],
      ["empty-01.md", " \n"],
    ]) {
      const path = join(store.directory, name);
      await writeFile(path, content);
      const series = name.slice(0, -6);
      await assert.rejects(store.read({ series, revision: 1, path, title: "" }));
    }
    assert.deepEqual(await store.list(), [revision]);
  });
});

test("malformed UTF-8 plan files are rejected on read and skipped during discovery", async () => {
  await withStore(async ({ store }) => {
    const valid = await store.save(PLAN);
    const path = join(store.directory, "malformed-01.md");
    for (const bytes of [[0xc3, 0x28], [0xe2, 0x82], [0xff]]) {
      const contents = Buffer.concat([Buffer.from("# Malformed\n"), Buffer.from(bytes)]);
      await writeFile(path, contents);
      await assert.rejects(store.read({ series: "malformed", revision: 1, path, title: "" }), /UTF-8/);
      assert.deepEqual(await store.list(), [valid]);
      assert.deepEqual(await readFile(path), contents);
    }
  });
});

test("discovery accepts only current canonical revision filenames and regular files", async () => {
  await withStore(async ({ store }) => {
    const revision = await store.save(PLAN);
    for (const name of [
      "PLAN.md",
      "legacy.json",
      "foo-1.md",
      "foo-001.md",
      "foo-00.md",
      "foo-9007199254740992.md",
      ".plan-leftover.tmp",
      "Bad Title-01.md",
    ]) {
      await writeFile(join(store.directory, name), "# Ignored");
    }
    await mkdir(join(store.directory, "directory-01.md"));
    assert.deepEqual(await store.list(), [revision]);
  });
});

test("only complete final files are observable while concurrent saves are in flight", async () => {
  await withStore(async ({ store }) => {
    const content = `# Atomic plan\n${"x".repeat(49_000)}`;
    let finished = false;
    const saves = Promise.all(Array.from({ length: 12 }, () => store.save(content))).finally(() => {
      finished = true;
    });
    try {
      do {
        for (const name of await readdir(store.directory)) {
          if (!name.endsWith(".md")) continue;
          assert.equal(await readFile(join(store.directory, name), "utf8"), content);
        }
      } while (!finished);
    } finally {
      await saves;
    }
    const names = await readdir(store.directory);
    assert.equal(names.length, 12);
    for (const name of names) {
      assert.ok(name.endsWith(".md"));
      assert.equal(await readFile(join(store.directory, name), "utf8"), content);
    }
  });
});

test("cancelled and stale saves publish nothing and remove staged files", async () => {
  await withStore(async ({ store }) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(store.save(PLAN, { signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(store.save(PLAN, { isCurrent: () => false }), { name: "AbortError" });
    let sawCompleteTemporary = false;
    await assert.rejects(
      store.save(PLAN, {
        isCurrent: () => {
          const temporary = readdirSync(store.directory).find((name) => name.endsWith(".tmp"));
          if (temporary && readFileSync(join(store.directory, temporary), "utf8") === PLAN) {
            sawCompleteTemporary = true;
            return false;
          }
          return true;
        },
      }),
      { name: "AbortError" },
    );
    assert.ok(sawCompleteTemporary, "Cancellation is rechecked after staging, before publication");
    const lateAbort = new AbortController();
    await assert.rejects(
      store.save(PLAN, {
        signal: lateAbort.signal,
        isCurrent: () => {
          const temporary = readdirSync(store.directory).find((name) => name.endsWith(".tmp"));
          if (temporary && readFileSync(join(store.directory, temporary), "utf8") === PLAN) lateAbort.abort();
          return true;
        },
      }),
      { name: "AbortError" },
    );
    assert.deepEqual(await readdir(store.directory), []);
    const first = await store.save(PLAN);
    assert.equal(first.revision, 1);
  });
});

test("cleanup failure after publication still returns the committed revision", async () => {
  await withStore(async ({ store }) => {
    const cleanup = vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("Cleanup unavailable"));
    let revision: PlanRevision;
    try {
      revision = await store.save(PLAN);
      assert.equal(cleanup.mock.calls.length, 1);
    } finally {
      cleanup.mockRestore();
    }
    assert.equal(revision.revision, 1);
    assert.equal(await readFile(revision.path, "utf8"), PLAN);
    assert.deepEqual(await store.list(), [revision]);
    assert.ok((await readdir(store.directory)).some((name) => name.endsWith(".tmp")));
    const next = await store.save("# Next revision", { series: revision.series });
    assert.equal(next.revision, 2);
  });
});

test("cleanup failure before publication cannot replace the original save error", async () => {
  await withStore(async ({ store }) => {
    const original = new Error("Owner failed before publication");
    const cleanup = vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("Cleanup unavailable"));
    try {
      await assert.rejects(
        store.save(PLAN, {
          isCurrent: () => {
            if (readdirSync(store.directory).some((name) => name.endsWith(".tmp"))) throw original;
            return true;
          },
        }),
        (error: unknown) => error === original,
      );
      assert.equal(cleanup.mock.calls.length, 1);
      assert.deepEqual(await store.list(), []);
      assert.ok((await readdir(store.directory)).every((name) => name.endsWith(".tmp")));
    } finally {
      cleanup.mockRestore();
    }
  });
});

test("failure after staging cleans temporary artifacts without harming existing revisions", async () => {
  await withStore(async ({ store }) => {
    const first = await store.save(PLAN);
    await assert.rejects(
      store.save(PLAN, {
        series: first.series,
        isCurrent: () => {
          const temporary = readdirSync(store.directory).find((name) => name.endsWith(".tmp"));
          if (temporary && readFileSync(join(store.directory, temporary), "utf8") === PLAN)
            throw new Error("Owner failed");
          return true;
        },
      }),
      /Owner failed/,
    );
    assert.deepEqual(await readdir(store.directory), [basename(first.path)]);
    assert.equal(await store.read(first), PLAN);
    const next: PlanRevision = await store.save("# Retry", { series: first.series });
    assert.equal(next.revision, 2);
  });
});
