import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BuildMetadata, RuntimeBuilder } from "./runtime-builder-contract.js";

type BuildOptions = Parameters<RuntimeBuilder["buildRuntime"]>[0];
interface InstallBuilder {
  buildTuiKit(options?: BuildOptions): Promise<BuildMetadata>;
  buildInstallRuntime(options?: {
    kit?: BuildOptions;
    plan?: BuildOptions;
    background?: BuildOptions;
    herdr?: BuildOptions;
  }): Promise<void>;
}

export const kitRoot = resolve("packages/pi-tui-kit");
export async function loadInstallBuilder(): Promise<InstallBuilder> {
  return import(pathToFileURL(resolve("scripts/build-install-runtime.mjs")).href);
}

export async function withInstallOutputs(
  run: (kit: string, plan: string, background: string, herdr: string) => Promise<void>,
) {
  const kit = await mkdtemp(join(kitRoot, ".pi-tui-kit-build-test-"));
  const plan = await mkdtemp(join(resolve("packages/pi-plan-mode"), ".pi-plan-mode-build-test-"));
  const background = await mkdtemp(join(resolve("packages/pi-background"), ".pi-background-build-test-"));
  const herdr = await mkdtemp(join(resolve("packages/pi-herdr-core"), ".pi-herdr-core-build-test-"));
  try {
    await run(join(kit, "dist"), join(plan, "dist"), join(background, "dist"), join(herdr, "dist"));
  } finally {
    await rm(kit, { recursive: true, force: true });
    await rm(plan, { recursive: true, force: true });
    await rm(background, { recursive: true, force: true });
    await rm(herdr, { recursive: true, force: true });
  }
}
