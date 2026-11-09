import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { progressArguments, resolveProgressCli, runProgress } from "../src/progress-runner.js";
import { DEFAULT_PROGRESS } from "../src/settings.js";

const cli = fileURLToPath(new URL("./fixtures/progress-child.mjs", import.meta.url));
const request = (signal = new AbortController().signal) => ({
  ...DEFAULT_PROGRESS,
  prompt: "PRIVATE EVIDENCE",
  signal,
});

test("installed CLI resolution follows bin manifest rather than development layout or cwd", async () => {
  assert.ok(existsSync(resolveProgressCli()));
  assert.match(resolveProgressCli(), /dist\/bundle\/cli.js$/);
  const root = await mkdtemp(join(tmpdir(), "progress-package-"));
  try {
    await mkdir(join(root, "lib"));
    await mkdir(join(root, "packed"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "packed/start.js" } }),
    );
    await writeFile(join(root, "packed/start.js"), "");
    assert.equal(resolveProgressCli(join(root, "lib/api.js")), join(root, "packed/start.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("child invocation isolates resources and private evidence only travels over stdin", async () => {
  const args = progressArguments(request());
  for (const flag of [
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--no-approve",
  ])
    assert.ok(args.includes(flag));
  assert.ok(!args.includes("PRIVATE EVIDENCE"));
  const result = await runProgress(request(), { cli, args: ["success"] });
  assert.match(result, /PRIVATE EVIDENCE\u2028evidence/);
  assert.doesNotMatch(result, /NOT AUTHORITATIVE/);
});

for (const mode of [
  "malformed",
  "overflow",
  "stderr",
  "exit",
  "missing",
  "error",
  "aborted",
  "length",
  "tool",
  "tool-event",
  "mismatch",
]) {
  test(`runner rejects ${mode} rather than accepting a progress summary`, async () => {
    await assert.rejects(runProgress(request(), { cli, args: [mode], graceMs: 20 }));
  });
}
for (const mode of ["startup-timeout", "timeout", "ignore-term"]) {
  test(`runner deadline terminates/reaps ${mode}`, async () => {
    await assert.rejects(
      runProgress(request(), { cli, args: [mode], startupMs: 250, runMs: 350, graceMs: 20 }),
      /timed out/,
    );
  });
}
test("cancellation during startup/inference terminates and rejects without late output", async () => {
  for (const mode of ["startup-timeout", "ignore-term"]) {
    const controller = new AbortController();
    const pending = runProgress(request(controller.signal), { cli, args: [mode], graceMs: 20 });
    const timer = setTimeout(() => controller.abort(), 150);
    try {
      await assert.rejects(pending, /cancelled/);
    } finally {
      clearTimeout(timer);
    }
  }
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => runProgress(request(controller.signal)), /abort/i);
});
