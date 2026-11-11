import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { test, vi } from "vitest";
import { createPlanStore, type PlanStore, planHash } from "../src/plan-store.js";

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
    await run({ root, project, agent, store: await createPlanStore(project, undefined, agent) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function git(cwd: string, ...args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], {
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  });
}
function staged(directory: string) {
  return readdirSync(directory).some(
    (name) => name.endsWith(".tmp") && readFileSync(join(directory, name), "utf8").endsWith(PLAN),
  );
}

test("default storage uses getAgentDir, canonical roots and a v3 envelope without touching the project", async () => {
  await withStore(async ({ project, agent, store }) => {
    vi.stubEnv("PI_CODING_AGENT_DIR", agent);
    try {
      assert.equal((await createPlanStore(project)).directory, store.directory);
    } finally {
      vi.unstubAllEnvs();
    }
    assert.equal(store.projectRoot, await realpath(project));
    assert.equal(store.directory, join(agent, "pi-plan-mode", "project"));
    assert.deepEqual(await store.list(), []);
    const document = await store.save(PLAN, { name: "useful-plan" });
    assert.ok(document.id);
    assert.equal(document.name, "useful-plan");
    assert.equal(document.title, "A useful plan");
    assert.match(await readFile(document.path, "utf8"), /^<!-- pi-plan-document-v3:/);
    assert.equal(await store.read(document), PLAN);
    assert.deepEqual(await store.list(), [document]);
    assert.deepEqual(await readdir(project), []);
  });
});

test("updates atomically replace the same document; names, identity and paths survive title changes and reopen", async () => {
  await withStore(async ({ project, agent, store }) => {
    const first = await store.save(PLAN, { name: "useful-plan" });
    const changed = await store.save("# Changed", { document: first, expectedHash: planHash(PLAN) });
    assert.equal(changed.id, first.id);
    assert.equal(changed.path, first.path);
    assert.equal(changed.name, first.name);
    assert.equal(changed.title, "Changed");
    assert.equal(await store.read(first), "# Changed", "old locators read current contents, not a snapshot");
    const reopened = await createPlanStore(project, undefined, agent);
    assert.deepEqual(await reopened.list(), [changed]);
    const again = await reopened.save("# Alternate", { document: changed, expectedHash: planHash("# Changed") });
    assert.equal(again.path, first.path);
    assert.equal(await store.read(first), "# Alternate");
    assert.deepEqual(await readdir(store.directory), [basename(first.path)]);
  });
});

test("stale expected hashes and forged document identities never overwrite current bytes", async () => {
  await withStore(async ({ store }) => {
    const first = await store.save(PLAN);
    const current = await store.save("# External update", { document: first, expectedHash: planHash(PLAN) });
    const bytes = await readFile(first.path);
    for (const options of [
      { document: first, expectedHash: planHash(PLAN) },
      { document: { ...current, id: "forged" }, expectedHash: planHash("# External update") },
      {
        document: { ...current, path: join(store.directory, "other.md") },
        expectedHash: planHash("# External update"),
      },
    ])
      await assert.rejects(store.save("# Must not publish", options));
    assert.deepEqual(await readFile(first.path), bytes);
    assert.deepEqual(await readdir(store.directory), [basename(first.path)]);
    await unlink(first.path);
    await assert.rejects(
      store.save("# Missing is not a new plan", { document: current, expectedHash: planHash("# External update") }),
    );
    assert.deepEqual(await readdir(store.directory), []);
  });
});

test("Git roots unify nested directories and aliases; linked worktrees retain their own canonical root", async () => {
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
    await mkdir(join(project, "src", "nested"), { recursive: true });
    const alias = join(root, "alias");
    await symlink(project, alias);
    const main = await createPlanStore(project, undefined, agent);
    assert.equal((await createPlanStore(join(project, "src", "nested"), undefined, agent)).directory, main.directory);
    assert.equal((await createPlanStore(join(alias, "src"), undefined, agent)).directory, main.directory);
    const worktree = join(root, "worktree");
    await git(project, "worktree", "add", "--quiet", "--detach", worktree);
    await mkdir(join(worktree, "nested"));
    const linked = await createPlanStore(join(worktree, "nested"), undefined, agent);
    assert.equal(linked.projectRoot, await realpath(worktree));
    assert.equal(basename(linked.directory), "worktree");
    assert.notEqual(linked.directory, main.directory);
    assert.equal((await createPlanStore(worktree, undefined, agent)).directory, linked.directory);
    await main.save(PLAN);
    assert.deepEqual(await linked.list(), []);
  });
});

test("non-Git cwd fallback is stable and documents cannot cross unrelated stores", async () => {
  await withStore(async ({ project, agent, store }) => {
    const nested = join(project, "nested");
    await mkdir(nested);
    const other = await createPlanStore(nested, undefined, agent);
    assert.notEqual(other.directory, store.directory);
    assert.equal((await createPlanStore(project, undefined, agent)).directory, store.directory);
    const document = await store.save(PLAN);
    await assert.rejects(other.read(document));
    await assert.rejects(other.save(PLAN, { document, expectedHash: planHash(PLAN) }));
    assert.deepEqual(await other.list(), []);
  });
});

test("configured locations stay beneath extension data and reject lexical escapes", async () => {
  await withStore(async ({ project, agent }) => {
    const custom = await createPlanStore(project, "notes/plans", agent);
    assert.equal(custom.directory, join(agent, "pi-plan-mode", "notes", "plans", basename(custom.directory)));
    for (const option of ["", "..", "../escape", "notes/../../escape", "/tmp/escape", "notes\\escape", "bad\0path"])
      await assert.rejects(createPlanStore(project, option, agent), /directory/);
  });
});

test("directory symlinks cannot redirect reads, discovery or publication", async () => {
  await withStore(async ({ root, project, agent, store }) => {
    const document = await store.save(PLAN);
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(agent, "pi-plan-mode", "redirect"));
    await assert.rejects(createPlanStore(project, "redirect/plans", agent), /symlink/);
    await rename(store.directory, `${store.directory}-original`);
    await symlink(outside, store.directory);
    await assert.rejects(store.save(PLAN), /symlink/);
    await assert.rejects(store.list(), /symlink/);
    await assert.rejects(store.read(document), /symlink/);
    assert.deepEqual(await readdir(outside), []);
    const secondAgent = join(root, "second-agent");
    await mkdir(secondAgent);
    await symlink(outside, join(secondAgent, "pi-plan-mode"));
    await assert.rejects(createPlanStore(project, undefined, secondAgent), /symlink/);
  });
});

test("same-title independent saves never overwrite each other, even after another document is deleted", async () => {
  await withStore(async ({ store }) => {
    const first = await store.save(PLAN);
    const second = await store.save(PLAN);
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.path, second.path);
    await unlink(first.path);
    const third = await store.save(PLAN);
    assert.notEqual(third.id, second.id);
    assert.notEqual(third.path, second.path);
    assert.equal(await store.read(second), PLAN);
  });
});

test("independent store instances publish distinct documents; competing expected-hash updates have one winner", async () => {
  await withStore(async ({ project, agent, store }) => {
    const stores = await Promise.all(Array.from({ length: 8 }, () => createPlanStore(project, undefined, agent)));
    const created = await Promise.all(stores.map((instance) => instance.save(PLAN)));
    assert.equal(new Set(created.map((document) => document.id)).size, stores.length);
    assert.equal(new Set(created.map((document) => document.path)).size, stores.length);
    const first = created[0];
    const results = await Promise.allSettled(
      stores.map((instance, index) =>
        instance.save(`# Candidate ${index}`, { document: first, expectedHash: planHash(PLAN) }),
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await store.list()).length, 8);
    assert.match(await store.read(first), /^# Candidate \d$/);
    assert.equal((await readdir(store.directory)).length, 8);
  });
});

test("headings produce safe bounded filenames, including setext, fences, non-ASCII and terminal controls", async () => {
  await withStore(async ({ store }) => {
    const document = await store.save("```md\n# Not the title\n```\n\n## Café: ../../A **safe** title! ##\n\nBody");
    assert.match(basename(document.path), /cafe-a-safe-title/);
    assert.equal(document.title, "Café: ../../A **safe** title!");
    assert.match(basename((await store.save("Setext title\n============\n\nBody")).path), /setext-title/);
    for (const plan of ["# 日本語", `# ${"a".repeat(500)}`, "# Title\u001b[31m\u0007"]) {
      const saved = await store.save(plan);
      assert.match(basename(saved.path), /^[a-z0-9-]+\.md$/);
      assert.ok(Buffer.byteLength(basename(saved.path)) <= 255);
    }
    const control = await store.save("# Title\u001b[31m\u0007");
    assert.ok(control.title.includes("\u001b"), "titles are data; UI sanitizes them");
  });
});

test("reads validate local identity and reject symlink plan files without touching their targets", async () => {
  await withStore(async ({ root, store }) => {
    const first = await store.save(PLAN);
    const outside = join(root, "outside.md");
    await writeFile(outside, "# Outside");
    for (const replacement of [
      { path: outside },
      { path: join(store.directory, "..", basename(first.path)) },
      { id: "forged" },
      { id: "" },
    ])
      await assert.rejects(store.read({ ...first, ...replacement }));
    await unlink(first.path);
    await symlink(outside, first.path);
    await assert.rejects(store.read(first));
    await assert.rejects(store.save("# No", { document: first, expectedHash: planHash(PLAN) }));
    assert.deepEqual(await store.list(), []);
    const replacement = await store.save(PLAN);
    assert.notEqual(replacement.path, first.path);
    assert.equal(await readFile(outside, "utf8"), "# Outside");
  });
});

test("content limits count JavaScript characters; invalid on-disk content is bounded and excluded", async () => {
  await withStore(async ({ store }) => {
    const maximum = "😀".repeat(25_000);
    const document = await store.save(`  ${maximum}\n`);
    assert.equal(await store.read(document), maximum);
    await assert.rejects(store.save(`${maximum}x`), /50000/);
    await assert.rejects(store.save(" \n "), /empty/);
    const original = await readFile(document.path, "utf8");
    const header = original.slice(0, original.indexOf("\n") + 1);
    for (const content of ["x".repeat(50_001), "x".repeat(150_001), " \n"]) {
      await writeFile(document.path, header + content);
      await assert.rejects(store.read(document));
      assert.deepEqual(await store.list(), []);
    }
  });
});

test("malformed UTF-8 is rejected on read and excluded without modifying the file", async () => {
  await withStore(async ({ store }) => {
    const document = await store.save(PLAN);
    const original = await readFile(document.path, "utf8");
    const header = original.slice(0, original.indexOf("\n") + 1);
    for (const bytes of [[0xc3, 0x28], [0xe2, 0x82], [0xff]]) {
      const contents = Buffer.concat([Buffer.from(`${header}# Malformed\n`), Buffer.from(bytes)]);
      await writeFile(document.path, contents);
      await assert.rejects(store.read(document), /UTF-8/);
      assert.deepEqual(await store.list(), []);
      assert.deepEqual(await readFile(document.path), contents);
    }
  });
});

test("discovery accepts only valid v3 documents, never legacy Markdown, metadata, directories or staging files", async () => {
  await withStore(async ({ store }) => {
    const document = await store.save(PLAN);
    const history = { version: 1, parent: { series: "old", revision: 1, hash: planHash(PLAN) } };
    for (const [name, content] of [
      ["old-01.md", PLAN],
      ["PLAN.md", PLAN],
      ["legacy.json", "{}"],
      [".plan-leftover.tmp", PLAN],
      ["old-02.md", `<!-- pi-plan-revision-v1:${Buffer.from(JSON.stringify(history)).toString("base64")} -->\n${PLAN}`],
      [
        "old-03.md",
        `<!-- pi-plan-document-v2:${Buffer.from(JSON.stringify({ version: 2, history })).toString("base64")} -->\n${PLAN}`,
      ],
      ["malformed.md", "<!-- pi-plan-document-v3:not-json -->\n# Invalid"],
    ])
      await writeFile(join(store.directory, name), content);
    await mkdir(join(store.directory, "directory.md"));
    assert.deepEqual(await store.list(), [document]);
  });
});

test("only complete envelopes are observable while independent publications are in flight", async () => {
  await withStore(async ({ store }) => {
    const content = `# Atomic plan\n${"x".repeat(49_000)}`;
    let finished = false;
    const saves = Promise.all(Array.from({ length: 12 }, () => store.save(content))).finally(() => {
      finished = true;
    });
    try {
      do {
        for (const document of await store.list()) assert.equal(await store.read(document), content);
        for (const name of await readdir(store.directory)) {
          if (!name.endsWith(".md")) continue;
          const bytes = await readFile(join(store.directory, name), "utf8");
          assert.match(bytes, /^<!-- pi-plan-document-v3:/);
          assert.ok(bytes.endsWith(content));
        }
      } while (!finished);
    } finally {
      await saves;
    }
    assert.equal((await readdir(store.directory)).length, 12);
  });
});

test("cancelled and stale saves clean staging files, including cancellation after staging", async () => {
  await withStore(async ({ store }) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(store.save(PLAN, { signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(store.save(PLAN, { isCurrent: () => false }), { name: "AbortError" });
    let sawCompleteTemporary = false;
    await assert.rejects(
      store.save(PLAN, {
        isCurrent: () => {
          if (staged(store.directory)) {
            sawCompleteTemporary = true;
            return false;
          }
          return true;
        },
      }),
      { name: "AbortError" },
    );
    assert.ok(sawCompleteTemporary);
    const lateAbort = new AbortController();
    await assert.rejects(
      store.save(PLAN, {
        signal: lateAbort.signal,
        isCurrent: () => {
          if (staged(store.directory)) lateAbort.abort();
          return true;
        },
      }),
      { name: "AbortError" },
    );
    assert.deepEqual(await readdir(store.directory), []);
    assert.equal(await store.read(await store.save(PLAN)), PLAN);
  });
});

test("cleanup failure after new publication still returns the committed document", async () => {
  await withStore(async ({ store }) => {
    const cleanup = vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("Cleanup unavailable"));
    let document: Awaited<ReturnType<typeof store.save>>;
    try {
      document = await store.save(PLAN);
      assert.equal(cleanup.mock.calls.length, 1);
    } finally {
      cleanup.mockRestore();
    }
    assert.equal(await store.read(document), PLAN);
    assert.deepEqual(await store.list(), [document]);
    const next = await store.save("# Next", { document, expectedHash: planHash(PLAN) });
    assert.equal(next.path, document.path);
    assert.equal(await store.read(next), "# Next");
  });
});

test("cleanup failure before publication cannot replace the owner's original error", async () => {
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

test("failed same-path staging leaves original bytes intact and permits retry", async () => {
  await withStore(async ({ store }) => {
    const first = await store.save(PLAN);
    const bytes = await readFile(first.path);
    await assert.rejects(
      store.save(PLAN, {
        document: first,
        expectedHash: planHash(PLAN),
        isCurrent: () => {
          if (staged(store.directory)) throw new Error("Owner failed");
          return true;
        },
      }),
      /Owner failed/,
    );
    assert.deepEqual(await readFile(first.path), bytes);
    assert.deepEqual(await readdir(store.directory), [basename(first.path)]);
    const next = await store.save("# Retry", { document: first, expectedHash: planHash(PLAN) });
    assert.equal(next.path, first.path);
    assert.equal(await store.read(first), "# Retry");
  });
});
