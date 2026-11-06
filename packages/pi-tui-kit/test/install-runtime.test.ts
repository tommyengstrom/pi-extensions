import assert from "node:assert/strict";
import { access, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "vitest";
import { kitRoot, loadInstallBuilder, withInstallOutputs } from "../../../test/install-runtime-support.js";
import { listFiles } from "../../../test/runtime-builder-contract.js";

test("installation transpiles every export and relative import without bundling or removing lazy boundaries", async () => {
  const { buildTuiKit } = await loadInstallBuilder();
  await withInstallOutputs(async (outputDirectory) => {
    const metadata = await buildTuiKit({ outputDirectory });
    const files = await listFiles(outputDirectory);
    const manifest = JSON.parse(await readFile(join(kitRoot, "package.json"), "utf8"));
    for (const entry of Object.values(manifest.exports) as { import: string }[]) {
      assert.ok(files.includes(entry.import.replace("./dist/", "")), entry.import);
    }
    assert.ok(
      files.every((file) => file.endsWith(".js")),
      "install output needs no declarations",
    );
    const imports = [];
    for (const output of Object.values(metadata.outputs ?? {})) {
      assert.equal(Object.keys(output.inputs ?? {}).length, 1, "one source module per output");
      for (const imported of output.imports ?? []) {
        imports.push(imported);
        assert.equal(imported.external, true);
        if (imported.path.startsWith(".")) {
          assert.ok(output.entryPoint);
          const sourceRelative = output.entryPoint.replace(/^src\//u, "");
          await access(resolve(dirname(join(outputDirectory, sourceRelative)), imported.path));
        }
      }
    }
    assert.ok(imports.some((item) => item.path === "@earendil-works/pi-tui"));
    assert.ok(imports.some((item) => item.path === "grok-mermaid" && item.kind === "dynamic-import"));
    assert.ok(imports.some((item) => item.path === "./components/questionnaire.js" && item.kind === "dynamic-import"));
    const first = await readFile(join(outputDirectory, "index.js"), "utf8");
    await writeFile(join(outputDirectory, "stale.js"), "stale");
    await buildTuiKit({ outputDirectory });
    assert.deepEqual(await listFiles(outputDirectory), files);
    assert.equal(await readFile(join(outputDirectory, "index.js"), "utf8"), first);
  });
});

test("installation rejects unowned outputs and symlinks and cleans failed staging without replacing output", async () => {
  const { buildTuiKit } = await loadInstallBuilder();
  await withInstallOutputs(async (outputDirectory, outside) => {
    for (const path of [kitRoot, join(kitRoot, "src"), outside]) {
      await assert.rejects(buildTuiKit({ outputDirectory: path }), /owned by the build/u);
    }
    await symlink(join(kitRoot, "src"), outputDirectory, "dir");
    await assert.rejects(buildTuiKit({ outputDirectory }), /must not be a symlink/u);
    await rm(outputDirectory);
    const alias = join(dirname(outputDirectory), "alias");
    await symlink(join(kitRoot, "src"), alias, "dir");
    await assert.rejects(buildTuiKit({ outputDirectory: join(alias, "dist") }), /symlink/u);
    await rm(alias);
    await mkdir(outputDirectory);
    await writeFile(join(outputDirectory, "previous.js"), "previous");
    await assert.rejects(
      buildTuiKit({
        outputDirectory,
        validateOutput: async () => {
          throw new Error("validation failed");
        },
      }),
      /validation failed/u,
    );
    assert.deepEqual(await listFiles(outputDirectory), ["previous.js"]);
    assert.equal(await readFile(join(outputDirectory, "previous.js"), "utf8"), "previous");
    assert.deepEqual(await readdir(dirname(outputDirectory)), ["dist"]);
  });
});
