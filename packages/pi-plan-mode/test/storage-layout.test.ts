import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { createPlanStore, planHash, storedPlanStorage, validPlanStorage } from "../src/plan-store.js";
import { PLAN_STATE_ENTRY, restorePlanState } from "../src/state.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "plan-layout-"));
  roots.push(root);
  const cwd = join(root, "my-repo");
  const agent = join(root, "agent");
  await mkdir(cwd);
  return { root, cwd, agent, store: await createPlanStore(cwd, undefined, agent) };
}
function date(day: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 0, day, 23, 45));
}

test("new documents use repository storage and retain their first-save path across dates and title changes", async () => {
  date(2);
  const { cwd, agent, store } = await fixture();
  assert.equal(store.directory, join(agent, "pi-plan-mode", "my-repo"));
  assert.deepEqual(store.storage, { kind: "repo" });
  const first = await store.save("# A useful plan\n\nOriginal.");
  assert.equal(basename(first.path), "a-useful-plan.md");
  vi.setSystemTime(new Date(2026, 0, 5, 1));
  const reopened = await createPlanStore(cwd, store.storage, agent);
  const second = await reopened.save("# Changed title\n\nUpdated.", {
    document: first,
    expectedHash: planHash("# A useful plan\n\nOriginal."),
  });
  assert.equal(second.path, first.path);
  assert.equal(second.id, first.id);
  assert.equal(second.name, first.name);
  assert.equal(await reopened.read(first), "# Changed title\n\nUpdated.");
  assert.deepEqual(await reopened.list(), [second]);
  assert.deepEqual(await readdir(cwd), []);
});

test("dates and timezones never appear in new filenames or rename existing files", async () => {
  vi.stubEnv("TZ", "Pacific/Honolulu");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-03T02:00:00Z"));
  const { store } = await fixture();
  const first = await store.save("# Local date");
  assert.equal(basename(first.path), "local-date.md");
  vi.stubEnv("TZ", "Asia/Tokyo");
  const second = await store.save("# New title", { document: first, expectedHash: planHash("# Local date") });
  assert.equal(second.path, first.path);
});

test("same-named checkouts intentionally share repo documents but retain separate legacy locations", async () => {
  const { root, cwd, agent, store } = await fixture();
  const other = join(root, "copy", "my-repo");
  await mkdir(other, { recursive: true });
  const shared = await createPlanStore(other, undefined, agent);
  assert.equal(shared.directory, store.directory);
  assert.notEqual(shared.projectRoot, store.projectRoot);
  const document = await store.save("# Shared plan");
  assert.deepEqual(await shared.list(), [document]);
  assert.equal(await shared.read(document), "# Shared plan");
  const legacy = await createPlanStore(cwd, "plans", agent);
  assert.notEqual(legacy.directory, (await createPlanStore(other, "plans", agent)).directory);
});

test("legacy files are left untouched and excluded; existing-only lookup does not create missing locations", async () => {
  date(2);
  const { cwd, agent, store } = await fixture();
  for (const directory of ["plans", "design/plans"]) {
    const legacy = await createPlanStore(cwd, directory, agent);
    const path = join(legacy.directory, "old-plan-01.md");
    await writeFile(path, "# Old plan");
    const reopened = await createPlanStore(cwd, legacy.storage, agent, { existingOnly: true });
    vi.setSystemTime(new Date(2026, 4, 10));
    assert.deepEqual(await reopened.list(), []);
    assert.equal(await readFile(path, "utf8"), "# Old plan");
  }
  assert.deepEqual(await store.list(), []);
  await assert.rejects(createPlanStore(cwd, "missing", agent, { existingOnly: true }), { code: "ENOENT" });
  assert.equal((await readdir(join(agent, "pi-plan-mode"))).includes("missing"), false);
});

test("short filename budgets and concurrent same-title saves preserve independent document identities", async () => {
  date(2);
  const { cwd, agent, store } = await fixture();
  const stores = await Promise.all(Array.from({ length: 6 }, () => createPlanStore(cwd, undefined, agent)));
  const created = await Promise.all(stores.map((storage) => storage.save(`# ${"a".repeat(500)}`)));
  assert.equal(new Set(created.map((document) => document.id)).size, stores.length);
  assert.equal(new Set(created.map((document) => document.path)).size, stores.length);
  assert.ok(
    created.every(
      (document) =>
        !/^\d{4}-\d{2}-\d{2}-/.test(basename(document.path)) && Buffer.byteLength(basename(document.path)) <= 80,
    ),
  );
  const updated = await Promise.all(
    stores.map((storage, index) =>
      storage.save("# Continued", { document: created[index], expectedHash: planHash(`# ${"a".repeat(500)}`) }),
    ),
  );
  assert.deepEqual(
    updated.map((document) => document.path),
    created.map((document) => document.path),
  );
  assert.equal((await store.list()).length, 6);
});

test("directories and files reject symlinks and forged storage identities", async () => {
  const { root, cwd, agent, store } = await fixture();
  const outside = join(root, "outside");
  await mkdir(outside);
  const first = await store.save("# Safe plan");
  await unlink(first.path);
  await writeFile(join(outside, "plan.md"), "# Outside");
  await symlink(join(outside, "plan.md"), first.path);
  await assert.rejects(store.read(first));
  assert.deepEqual(await store.list(), []);
  await rm(store.directory, { recursive: true });
  await symlink(outside, store.directory);
  await assert.rejects(createPlanStore(cwd, undefined, agent), /symlinks/);
  assert.equal(validPlanStorage({ kind: "legacy", plansDirectory: "../escape" }), false);
  assert.equal(validPlanStorage({ kind: "other" }), false);
});

test("v3 workflows explicitly capture their selected storage", () => {
  for (const storage of [{ kind: "repo" }, { kind: "legacy", plansDirectory: "design/plans" }] as const) {
    const state = restorePlanState([
      {
        type: "custom",
        customType: PLAN_STATE_ENTRY,
        data: {
          kind: "planning",
          workflow: {
            version: 3,
            id: "33333333-3333-4333-8333-333333333333",
            projectRoot: "/project",
            storage,
            instructions: "",
            previousTools: [],
          },
        },
      },
    ]);
    assert.equal(state.kind, "planning");
    if (state.kind !== "planning") throw new Error("Expected workflow");
    assert.deepEqual(storedPlanStorage(state.workflow), storage);
  }
});
