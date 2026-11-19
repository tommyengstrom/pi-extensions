import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { loadInstallBuilder, withInstallOutputs } from "./install-runtime-support.js";

test("Git manifest supplies a Node-only production build and discovers all six source extensions", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(manifest.dependencies.esbuild, "0.28.2");
  assert.equal(manifest.devDependencies.esbuild, undefined);
  assert.equal(manifest.overrides.esbuild, "0.28.2");
  assert.deepEqual(manifest.trustedDependencies, ["esbuild"]);
  assert.equal(manifest.scripts.postinstall, "node ./scripts/build-install-runtime.mjs");
  assert.deepEqual(manifest.pi.extensions, [
    "./packages/pi-plan-mode/src/index.ts",
    "./packages/pi-artifacts/src/index.ts",
    "./packages/pi-herdr-core/src/index.ts",
    "./packages/pi-thinking-shortcuts/src/index.ts",
    "./packages/pi-activity-digest/src/index.ts",
    "./packages/pi-tool-summary/src/index.ts",
  ]);
  for (const path of manifest.pi.extensions) await access(path);
  const library = JSON.parse(await readFile("packages/pi-background/package.json", "utf8"));
  assert.equal(library.pi, undefined);
});

test("installation builds libraries before consumers and propagates validation failures", async () => {
  const builder = await loadInstallBuilder();
  await withInstallOutputs(async (kit, plan, background) => {
    const shared = { background: { outputDirectory: background } };
    await assert.rejects(
      builder.buildInstallRuntime({
        ...shared,
        kit: {
          outputDirectory: kit,
          validateOutput: async () => {
            throw new Error("Kit failed");
          },
        },
        plan: { outputDirectory: plan },
      }),
      /Kit failed/u,
    );
    await assert.rejects(access(plan));
    await assert.rejects(
      builder.buildInstallRuntime({
        ...shared,
        kit: { outputDirectory: kit },
        plan: {
          outputDirectory: plan,
          validateOutput: async () => {
            await access(join(kit, "index.js"));
            await access(join(background, "index.js"));
            throw new Error("Plan failed");
          },
        },
      }),
      /Plan failed/u,
    );
    await assert.rejects(access(plan));
    await builder.buildInstallRuntime({ ...shared, kit: { outputDirectory: kit }, plan: { outputDirectory: plan } });
    await access(join(plan, "index.ts"));
  });
});

test("background build failures stop consumers before publication", async () => {
  const builder = await loadInstallBuilder();
  await withInstallOutputs(async (kit, plan, background) => {
    await assert.rejects(
      builder.buildInstallRuntime({
        background: {
          outputDirectory: background,
          validateOutput: async () => {
            throw new Error("Background failed");
          },
        },
        kit: { outputDirectory: kit },
        plan: { outputDirectory: plan },
      }),
      /Background failed/u,
    );
    await assert.rejects(access(plan));
  });
});
