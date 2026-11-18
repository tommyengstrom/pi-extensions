#!/usr/bin/env node
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createRuntimeBuilder } from "./runtime-builder.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Node-only install build. No compiler, Bun executable, host imports or child allocation. */
export async function buildBackgroundPackage({ outputDirectory, validateOutput } = {}) {
  const name = "pi-background";
  const packageRoot = join(root, "packages", name);
  outputDirectory = resolve(outputDirectory ?? join(packageRoot, "dist"));
  const publication = createRuntimeBuilder({ packageRoot, temporaryPrefix: `.${name}` });
  await publication.assertSafeOutputDirectory(outputDirectory);
  const staging = await mkdtemp(join(dirname(outputDirectory), `.${name}-dist-`));
  try {
    const source = join(packageRoot, "src");
    const entries = (await readdir(source, { recursive: true })).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".d.ts"),
    );
    const result = await build({
      absWorkingDir: packageRoot,
      entryPoints: entries.map((entry) => join(source, entry)),
      outbase: source,
      outdir: staging,
      bundle: false,
      format: "esm",
      platform: "node",
      target: "es2024",
      metafile: true,
    });
    const outputs = new Set(Object.keys(result.metafile.outputs).map((file) => resolve(packageRoot, file)));
    for (const entry of entries)
      if (!outputs.has(join(staging, entry.replace(/\.ts$/u, ".js"))))
        throw new Error(`Missing background runtime module: ${entry}`);
    for (const [file, output] of Object.entries(result.metafile.outputs))
      for (const imported of output.imports)
        if (imported.path.startsWith(".") && !outputs.has(resolve(dirname(resolve(packageRoot, file)), imported.path)))
          throw new Error(`Missing runtime relative import: ${imported.path}`);
    await validateOutput?.(staging);
    await publication.publishRuntime(staging, outputDirectory);
    return result.metafile;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await buildBackgroundPackage();
