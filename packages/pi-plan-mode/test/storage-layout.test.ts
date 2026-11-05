import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { createPlanStore, storedPlanStorage, validPlanStorage } from "../src/plan-store.js";
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

test("new series use the plain repository name, local first-save date, and initial description", async () => {
  date(2);
  const { cwd, agent, store } = await fixture();
  assert.equal(store.directory, join(agent, "pi-plan-mode", "my-repo"));
  assert.deepEqual(store.storage, { kind: "repo" });
  const first = await store.save("# A useful plan\n\nOriginal.");
  assert.equal(basename(first.path), "2026-01-02-a-useful-plan-01.md");
  vi.setSystemTime(new Date(2026, 0, 5, 1));
  const reopened = await createPlanStore(cwd, store.storage, agent);
  const second = await reopened.save("# Changed title\n\nUpdated.", { series: first.series });
  assert.equal(basename(second.path), "2026-01-02-a-useful-plan-02.md");
  await unlink(first.path);
  await writeFile(join(store.directory, `${first.series}-99.md`), "# Retained revision");
  const last = await reopened.save("# Another title", { series: first.series });
  assert.equal(basename(last.path), "2026-01-02-a-useful-plan-100.md");
  assert.deepEqual(await readdir(cwd), []);
});

test("series dates use the local calendar rather than the UTC date", async () => {
  vi.stubEnv("TZ", "Pacific/Honolulu");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-03T02:00:00Z"));
  const { store } = await fixture();
  const first = await store.save("# Local date");
  assert.equal(basename(first.path), "2026-01-02-local-date-01.md");
  vi.stubEnv("TZ", "Asia/Tokyo");
  const second = await store.save("# New title", { series: first.series });
  assert.equal(basename(second.path), "2026-01-02-local-date-02.md");
});

test("same-named checkouts intentionally share new plans but retain separate legacy scopes", async () => {
  const { root, cwd, agent, store } = await fixture();
  const other = join(root, "copy", "my-repo");
  await mkdir(other, { recursive: true });
  const shared = await createPlanStore(other, undefined, agent);
  assert.equal(shared.directory, store.directory);
  assert.notEqual(shared.projectRoot, store.projectRoot);
  const revision = await store.save("# Shared plan");
  assert.deepEqual(await shared.list(), [revision]);
  assert.equal(await shared.read(revision), "# Shared plan");
  const legacy = await createPlanStore(cwd, "plans", agent);
  assert.notEqual(legacy.directory, (await createPlanStore(other, "plans", agent)).directory);
});

test("legacy stores remain unchanged and continuation does not invent dates", async () => {
  date(2);
  const { cwd, agent, store } = await fixture();
  for (const directory of ["plans", "design/plans"]) {
    const legacy = await createPlanStore(cwd, directory, agent);
    const first = await legacy.save("# Old plan");
    const original = await readFile(first.path, "utf8");
    assert.equal(basename(first.path), "old-plan-01.md");
    const reopened = await createPlanStore(cwd, legacy.storage, agent, { existingOnly: true });
    vi.setSystemTime(new Date(2026, 4, 10));
    const second = await reopened.save("# Updated old plan", { series: first.series });
    assert.equal(basename(second.path), "old-plan-02.md");
    assert.equal(await readFile(first.path, "utf8"), original);
  }
  assert.deepEqual(await store.list(), []);
  await assert.rejects(createPlanStore(cwd, "missing", agent, { existingOnly: true }), { code: "ENOENT" });
  assert.equal((await readdir(join(agent, "pi-plan-mode"))).includes("missing"), false);
});

test("dated filename budgets and concurrent same-title saves preserve independent series", async () => {
  date(2);
  const { cwd, agent, store } = await fixture();
  const stores = await Promise.all(Array.from({ length: 6 }, () => createPlanStore(cwd, undefined, agent)));
  const created = await Promise.all(stores.map((storage) => storage.save(`# ${"a".repeat(500)}`)));
  assert.equal(new Set(created.map((revision) => revision.series)).size, stores.length);
  assert.ok(created.every((revision) => revision.series.startsWith("2026-01-02-") && revision.series.length <= 120));
  const first = created[0];
  const continued = await Promise.all(stores.map((storage) => storage.save("# Continued", { series: first.series })));
  assert.deepEqual(
    continued.map((revision) => revision.revision).sort((a, b) => a - b),
    [2, 3, 4, 5, 6, 7],
  );
  assert.equal((await store.list()).length, 12);
});

test("new-layout directories and files reject symlinks and forged store identities", async () => {
  const { root, cwd, agent, store } = await fixture();
  const outside = join(root, "outside");
  await mkdir(outside);
  const first = await store.save("# Safe plan");
  await unlink(first.path);
  await writeFile(join(outside, "plan.md"), "# Outside");
  await symlink(join(outside, "plan.md"), first.path);
  await assert.rejects(store.read(first), /regular files/);
  assert.deepEqual(await store.list(), []);
  await rm(store.directory, { recursive: true });
  await symlink(outside, store.directory);
  await assert.rejects(createPlanStore(cwd, undefined, agent), /symlinks/);
  assert.equal(validPlanStorage({ kind: "legacy", plansDirectory: "../escape" }), false);
  assert.equal(validPlanStorage({ kind: "other" }), false);
});

test("old state locators remain legacy while new states explicitly identify repo storage", async () => {
  const workflow = { projectRoot: "/project", plansDirectory: "design/plans", instructions: "", previousTools: [] };
  const old = restorePlanState([
    { type: "custom", customType: PLAN_STATE_ENTRY, data: { kind: "planning", workflow } },
  ]);
  assert.equal(old.kind, "planning");
  assert.deepEqual(storedPlanStorage(old.workflow), { kind: "legacy", plansDirectory: "design/plans" });
  const modern = restorePlanState([
    {
      type: "custom",
      customType: PLAN_STATE_ENTRY,
      data: {
        kind: "planning",
        workflow: { projectRoot: "/project", storage: { kind: "repo" }, instructions: "", previousTools: [] },
      },
    },
  ]);
  assert.ok(modern.kind !== "idle");
  assert.deepEqual(storedPlanStorage(modern.workflow), { kind: "repo" });
});
