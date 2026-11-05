import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { planModeSettingsPath, readPlanModeSettings, updatePlanModeSettings } from "../src/settings.js";

async function withSettings(run: (path: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-settings-"));
  try {
    await run(join(directory, "pi-plan-mode.json"), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("settings path remains in the agent directory", () => {
  assert.equal(planModeSettingsPath(), join(getAgentDir(), "pi-plan-mode.json"));
});

test("missing settings return fresh defaults without reading legacy settings or creating a file", async () => {
  await withSettings(async (path, directory) => {
    await writeFile(join(directory, "plan-mode.json"), '{"plansDirectory":"legacy","tools":["bash"]}');
    const settings = await readPlanModeSettings(path);
    assert.deepEqual(settings, { plansDirectory: "plans" });
    settings.plansDirectory = "changed";
    assert.deepEqual(await readPlanModeSettings(path), { plansDirectory: "plans" });
    assert.deepEqual(await readdir(directory), ["plan-mode.json"]);
  });
});

test("settings round-trip relative directories, Unicode, and exact custom tool names", async () => {
  await withSettings(async (settingsPath, directory) => {
    for (const plansDirectory of ["plans", "design/计划 📝", "nested/relative plans"]) {
      const settings = await updatePlanModeSettings(
        { plansDirectory, tools: ["bash", "mcp__docs__search", "bash"] },
        { settingsPath },
      );
      assert.deepEqual(settings, { plansDirectory, tools: ["bash", "mcp__docs__search"] });
      assert.deepEqual(await readPlanModeSettings(settingsPath), settings);
    }
    assert.deepEqual(await readdir(directory), ["pi-plan-mode.json"]);
  });
});

test("empty tools means helpers only; null removes the custom selection", async () => {
  await withSettings(async (settingsPath) => {
    assert.deepEqual(await updatePlanModeSettings({ tools: [] }, { settingsPath }), {
      plansDirectory: "plans",
      tools: [],
    });
    assert.deepEqual(await readPlanModeSettings(settingsPath), { plansDirectory: "plans", tools: [] });
    assert.deepEqual(await updatePlanModeSettings({ tools: null }, { settingsPath }), { plansDirectory: "plans" });
    assert.equal(Object.hasOwn(JSON.parse(await readFile(settingsPath, "utf8")), "tools"), false);
  });
});

test("updates preserve unknown fields without interpreting retired settings", async () => {
  await withSettings(async (settingsPath) => {
    const unknown = { thinkingLevel: "invalid-retired-value", safeSubcommands: 42, future: { enabled: true } };
    await writeFile(settingsPath, JSON.stringify(unknown));
    assert.deepEqual(await readPlanModeSettings(settingsPath), { plansDirectory: "plans" });
    await updatePlanModeSettings({ plansDirectory: "drafts", tools: ["custom"] }, { settingsPath });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      ...unknown,
      plansDirectory: "drafts",
      tools: ["custom"],
    });
  });
});

test("invalid documents throw and cannot be repaired implicitly by an update", async () => {
  await withSettings(async (settingsPath, directory) => {
    for (const contents of [
      "{",
      "",
      "null",
      "[]",
      "42",
      '{"plansDirectory":null}',
      '{"plansDirectory":0}',
      '{"plansDirectory":""}',
      '{"plansDirectory":"   "}',
      '{"plansDirectory":"a\\u0000b"}',
      '{"tools":null}',
      '{"tools":"read"}',
      '{"tools":[""]}',
      '{"tools":["   "]}',
      '{"tools":["read",42]}',
    ]) {
      await writeFile(settingsPath, contents);
      await assert.rejects(readPlanModeSettings(settingsPath), /Invalid/);
      await assert.rejects(updatePlanModeSettings({ plansDirectory: "fixed", tools: null }, { settingsPath }));
      assert.equal(await readFile(settingsPath, "utf8"), contents);
      assert.deepEqual(await readdir(directory), ["pi-plan-mode.json"]);
    }
  });
});

test("bounded reads reject oversized files and malformed UTF-8 without replacing them", async () => {
  await withSettings(async (settingsPath) => {
    const invalidUtf8 = Buffer.concat([
      Buffer.from('{"plansDirectory":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}'),
    ]);
    for (const contents of [Buffer.from(JSON.stringify({ future: "x".repeat(65536) })), invalidUtf8]) {
      await writeFile(settingsPath, contents);
      await assert.rejects(readPlanModeSettings(settingsPath), /65536|UTF-8/);
      await assert.rejects(updatePlanModeSettings({ tools: [] }, { settingsPath }));
      assert.deepEqual(await readFile(settingsPath), contents);
    }
  });
});

test("directories and both valid and dangling symlinks are rejected", async () => {
  await withSettings(async (settingsPath, directory) => {
    await mkdir(settingsPath);
    await assert.rejects(readPlanModeSettings(settingsPath), /regular file/);
    await assert.rejects(updatePlanModeSettings({}, { settingsPath }), /regular file/);
    await rm(settingsPath, { recursive: true });
    const target = join(directory, "target.json");
    for (const exists of [false, true]) {
      if (exists) await writeFile(target, "{}");
      await symlink(target, settingsPath);
      await assert.rejects(readPlanModeSettings(settingsPath), /regular file/);
      await assert.rejects(updatePlanModeSettings({}, { settingsPath }), /regular file/);
      assert.equal((await lstat(settingsPath)).isSymbolicLink(), true);
      if (exists) assert.equal(await readFile(target, "utf8"), "{}");
      await rm(settingsPath);
    }
  });
});

test("invalid and oversized patches preserve valid existing settings", async () => {
  await withSettings(async (settingsPath) => {
    await writeFile(settingsPath, '{"future":true}');
    for (const patch of [
      { plansDirectory: "" },
      { tools: [""] },
      { plansDirectory: "x".repeat(65536) },
      { tools: "read" } as unknown as Parameters<typeof updatePlanModeSettings>[0],
    ]) {
      await assert.rejects(updatePlanModeSettings(patch, { settingsPath }));
      assert.equal(await readFile(settingsPath, "utf8"), '{"future":true}');
    }
  });
});

test("invalid plan directories cannot be persisted or silently repaired", async () => {
  await withSettings(async (settingsPath, directory) => {
    const invalidDirectories = [
      "",
      "   ",
      "..",
      "../outside",
      "nested/../../outside",
      "/absolute",
      "C:\\absolute",
      "nested\\plans",
      "nested//plans",
      "nested/",
      ".",
      "./plans",
      "nested/./plans",
      "nested/../plans",
      "bad\0path",
    ];
    const original = '{"plansDirectory":"plans","tools":["read"],"future":{"keep":true}}\n';
    await writeFile(settingsPath, original);
    for (const plansDirectory of invalidDirectories) {
      await assert.rejects(
        updatePlanModeSettings({ plansDirectory, tools: ["changed"] }, { settingsPath }),
        /Invalid.*plansDirectory/,
      );
      assert.equal(await readFile(settingsPath, "utf8"), original);
      assert.deepEqual(await readdir(directory), ["pi-plan-mode.json"]);
    }
    for (const plansDirectory of invalidDirectories) {
      const invalid = JSON.stringify({ plansDirectory, future: true });
      await writeFile(settingsPath, invalid);
      await assert.rejects(readPlanModeSettings(settingsPath), /Invalid.*plansDirectory/);
      await assert.rejects(updatePlanModeSettings({ plansDirectory: "fixed" }, { settingsPath }), /Invalid/);
      assert.equal(await readFile(settingsPath, "utf8"), invalid);
    }
    await rm(settingsPath);
    await assert.rejects(updatePlanModeSettings({ plansDirectory: "../outside" }, { settingsPath }), /Invalid/);
    assert.deepEqual(await readdir(directory), []);
  });
});

test("concurrent edits are ordered by path, merge fields, and reads wait for pending writes", async () => {
  await withSettings(async (settingsPath) => {
    await writeFile(settingsPath, '{"future":{"keep":true}}');
    const first = updatePlanModeSettings({ plansDirectory: "first" }, { settingsPath });
    const second = updatePlanModeSettings(
      { tools: ["custom"] },
      { settingsPath: relative(process.cwd(), settingsPath) },
    );
    const third = updatePlanModeSettings({ plansDirectory: "last" }, { settingsPath });
    const read = readPlanModeSettings(settingsPath);
    assert.deepEqual(await first, { plansDirectory: "first" });
    assert.deepEqual(await second, { plansDirectory: "first", tools: ["custom"] });
    assert.deepEqual(await third, { plansDirectory: "last", tools: ["custom"] });
    assert.deepEqual(await read, await third);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      future: { keep: true },
      plansDirectory: "last",
      tools: ["custom"],
    });
  });
});

test("queued updates capture tool arrays and recover after failure or cancellation", async () => {
  await withSettings(async (settingsPath, directory) => {
    const tools = ["read"];
    const first = updatePlanModeSettings({ tools }, { settingsPath });
    tools.push("bash");
    const failed = assert.rejects(updatePlanModeSettings({ plansDirectory: "" }, { settingsPath }));
    const controller = new AbortController();
    const cancelled = assert.rejects(
      updatePlanModeSettings({ tools: ["bash"] }, { settingsPath, signal: controller.signal }),
      { name: "AbortError" },
    );
    controller.abort();
    const last = updatePlanModeSettings({ plansDirectory: "final" }, { settingsPath });
    await Promise.all([first, failed, cancelled, last]);
    assert.deepEqual(await readPlanModeSettings(settingsPath), { plansDirectory: "final", tools: ["read"] });
    assert.deepEqual(await readdir(directory), ["pi-plan-mode.json"]);
  });
});

test("publishing replaces the whole file atomically rather than rewriting an open file", async () => {
  await withSettings(async (settingsPath, directory) => {
    const original = '{"plansDirectory":"original"}\n';
    await writeFile(settingsPath, original);
    const handle = await open(settingsPath, "r");
    try {
      await updatePlanModeSettings({ plansDirectory: "replacement" }, { settingsPath });
      assert.equal(await handle.readFile("utf8"), original);
      assert.deepEqual(await readPlanModeSettings(settingsPath), { plansDirectory: "replacement" });
      assert.deepEqual(await readdir(directory), ["pi-plan-mode.json"]);
    } finally {
      await handle.close();
    }
  });
});
