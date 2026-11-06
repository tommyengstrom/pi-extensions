import path from "node:path";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, expect, it } from "vitest";

let loaded: LoadExtensionsResult | undefined;

beforeAll(async () => {
  // Shared Vitest setup initializes this before Pi's first runtime import.
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) throw new Error("Missing isolated test agent directory");
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const loader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [path.resolve("packages/pi-thinking-shortcuts")],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  loaded = loader.getExtensions();
});

afterAll(() => loaded?.runtime.invalidate("thinking shortcuts loading test complete"));

it("loads the standalone package through Pi's manifest and Jiti loader", () => {
  expect(loaded?.errors).toEqual([]);
  expect(loaded?.extensions).toHaveLength(1);
  const extension = loaded?.extensions[0];
  if (!extension) throw new Error("Extension did not load");
  expect([...extension.shortcuts.keys()]).toEqual(["alt+,", "alt+."]);
  expect(extension.handlers.size).toBe(0);
  expect(extension.tools.size).toBe(0);
  expect(extension.commands.size).toBe(0);
});
