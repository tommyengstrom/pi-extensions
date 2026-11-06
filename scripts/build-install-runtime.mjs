#!/usr/bin/env node

import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { buildRuntime } from "../packages/pi-plan-mode/scripts/build-runtime.mjs";
import { createRuntimeBuilder } from "./runtime-builder.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const kitRoot = join(root, "packages/pi-tui-kit");
// Reuse the extension builder's ownership checks and rollback-safe publication,
// not its bundling or .ts output contract.
const publication = createRuntimeBuilder({ packageRoot: kitRoot, temporaryPrefix: ".pi-tui-kit" });

export async function buildTuiKit({ outputDirectory = join(kitRoot, "dist"), validateOutput } = {}) {
  outputDirectory = resolve(outputDirectory);
  await publication.assertSafeOutputDirectory(outputDirectory);
  const staging = await mkdtemp(join(dirname(outputDirectory), ".pi-tui-kit-dist-"));
  try {
    const source = join(kitRoot, "src");
    const entries = (await readdir(source, { recursive: true })).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".d.ts"),
    );
    const { metafile } = await build({
      absWorkingDir: kitRoot,
      entryPoints: entries.map((file) => join(source, file)),
      outbase: source,
      outdir: staging,
      bundle: false,
      format: "esm",
      platform: "node",
      target: "es2024",
      metafile: true,
    });
    const outputs = new Set(Object.keys(metafile.outputs).map((file) => resolve(kitRoot, file)));
    for (const entry of entries) {
      if (!outputs.has(join(staging, entry.replace(/\.ts$/u, ".js")))) {
        throw new Error(`Missing transpiled module: ${entry}`);
      }
    }
    const manifest = JSON.parse(await readFile(join(kitRoot, "package.json"), "utf8"));
    for (const target of [manifest.main, ...Object.values(manifest.exports).map((entry) => entry.import)]) {
      if (!target.startsWith("./dist/") || !outputs.has(resolve(staging, target.slice("./dist/".length)))) {
        throw new Error(`Missing runtime export: ${target}`);
      }
    }
    for (const [file, output] of Object.entries(metafile.outputs)) {
      const absolute = resolve(kitRoot, file);
      if (!(await stat(absolute)).isFile()) throw new Error(`Missing runtime file: ${file}`);
      for (const imported of output.imports) {
        if (imported.path.startsWith(".")) {
          if (!outputs.has(resolve(dirname(absolute), imported.path))) {
            throw new Error(`Missing relative runtime import: ${imported.path} from ${relative(staging, absolute)}`);
          }
        } else if (!imported.external) {
          throw new Error(`Package import is not external: ${imported.path}`);
        }
      }
    }
    await validateOutput?.(staging);
    await publication.publishRuntime(staging, outputDirectory);
    return metafile;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function buildInstallRuntime({ kit, plan } = {}) {
  await buildTuiKit(kit);
  await buildRuntime(plan);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await buildInstallRuntime();
}
