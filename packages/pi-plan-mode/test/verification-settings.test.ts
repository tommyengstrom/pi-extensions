import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { DEFAULT_PROGRESS, readPlanModeSettings, updatePlanModeSettings } from "../src/settings.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function path() {
  const root = await mkdtemp(join(tmpdir(), "verification-settings-"));
  roots.push(root);
  return join(root, "settings.json");
}

test("progress defaults and independent overrides/reset preserve unknown fields", async () => {
  const settingsPath = await path();
  assert.deepEqual(DEFAULT_PROGRESS, { model: { provider: "openai", id: "gpt-6-luna" }, thinkingLevel: "low" });
  await writeFile(
    settingsPath,
    JSON.stringify({
      future: true,
      progress: { future: 42 },
      verification: { model: { provider: "other", id: "checker" } },
    }),
  );
  await updatePlanModeSettings(
    { progress: { model: { provider: "custom", id: "observer" }, thinkingLevel: "high" } },
    { settingsPath },
  );
  assert.deepEqual((await readPlanModeSettings(settingsPath)).progress, {
    model: { provider: "custom", id: "observer" },
    thinkingLevel: "high",
  });
  await updatePlanModeSettings({ progress: { model: null, thinkingLevel: null } }, { settingsPath });
  const raw = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(raw.progress, { future: 42 });
  assert.equal(raw.future, true);
  assert.deepEqual(raw.verification.model, { provider: "other", id: "checker" });
});

test.each([{ thinkingLevel: "ultra" }, { thinkingLevel: null }, { model: {} }, { model: null }, []])(
  "invalid progress settings cannot be overwritten: %j",
  async (progress) => {
    const settingsPath = await path();
    const contents = JSON.stringify({ progress });
    await writeFile(settingsPath, contents);
    await assert.rejects(updatePlanModeSettings({ progress: { model: null } }, { settingsPath }), /Invalid/);
    assert.equal(await readFile(settingsPath, "utf8"), contents);
  },
);

test("verification defaults on for missing file, object or flag; explicit false survives updates", async () => {
  const settingsPath = await path();
  for (const content of [undefined, {}, { verification: {} }]) {
    if (content) await writeFile(settingsPath, JSON.stringify(content));
    assert.equal((await readPlanModeSettings(settingsPath)).verification?.automatic ?? true, true);
  }
  await updatePlanModeSettings({ verification: { automatic: false } }, { settingsPath });
  await updatePlanModeSettings({ tools: ["read"] }, { settingsPath });
  assert.equal((await readPlanModeSettings(settingsPath)).verification?.automatic, false);
});

test("model defaults can be reset without losing unknown verification or root fields", async () => {
  const settingsPath = await path();
  await writeFile(
    settingsPath,
    JSON.stringify({ future: "keep", verification: { future: { keep: true }, automatic: false } }),
  );
  await updatePlanModeSettings(
    { verification: { model: { provider: "custom", id: "model/with/slashes" } } },
    { settingsPath },
  );
  assert.deepEqual((await readPlanModeSettings(settingsPath)).verification?.model, {
    provider: "custom",
    id: "model/with/slashes",
  });
  await updatePlanModeSettings({ verification: { model: null } }, { settingsPath });
  const raw = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(raw.future, "keep");
  assert.deepEqual(raw.verification, { automatic: false, future: { keep: true } });
});

test.each([{ automatic: "yes" }, { model: {} }, { model: null }, { model: { provider: "", id: "x" } }])(
  "invalid verification settings cannot be overwritten: %j",
  async (verification) => {
    const settingsPath = await path();
    const contents = JSON.stringify({ verification });
    await writeFile(settingsPath, contents);
    await assert.rejects(
      updatePlanModeSettings({ verification: { automatic: true } }, { settingsPath }),
      /Invalid verification/,
    );
    assert.equal(await readFile(settingsPath, "utf8"), contents);
  },
);
