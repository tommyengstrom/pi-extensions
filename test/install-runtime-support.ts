import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BuildMetadata, RuntimeBuilder } from "./runtime-builder-contract.js";

type BuildOptions = Parameters<RuntimeBuilder["buildRuntime"]>[0];
interface InstallBuilder {
  buildTuiKit(options?: BuildOptions): Promise<BuildMetadata>;
  buildInstallRuntime(options?: { kit?: BuildOptions; plan?: BuildOptions }): Promise<void>;
}

export const kitRoot = resolve("packages/pi-tui-kit");
export async function loadInstallBuilder(): Promise<InstallBuilder> {
  return import(pathToFileURL(resolve("scripts/build-install-runtime.mjs")).href);
}

export async function withInstallOutputs(run: (kit: string, plan: string) => Promise<void>) {
  const kit = await mkdtemp(join(kitRoot, ".pi-tui-kit-build-test-"));
  const plan = await mkdtemp(join(resolve("packages/pi-plan-mode"), ".pi-plan-mode-build-test-"));
  try {
    await run(join(kit, "dist"), join(plan, "dist"));
  } finally {
    await rm(kit, { recursive: true, force: true });
    await rm(plan, { recursive: true, force: true });
  }
}
