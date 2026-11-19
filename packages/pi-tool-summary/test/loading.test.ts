import { resolve } from "node:path";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, expect, it } from "vitest";

let loaded: LoadExtensionsResult;
beforeAll(async () => {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) throw new Error("Missing isolated Pi directory");
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const loader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [resolve("packages/pi-tool-summary")],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  loaded = loader.getExtensions();
});
afterAll(() => loaded?.runtime.invalidate("tool-summary loader test complete"));
it("loads one standalone renderer without registering tools, shortcuts, or message hooks", () => {
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(1);
  const [extension] = loaded.extensions;
  expect(extension.toolRenderers).toHaveLength(1);
  expect([...extension.commands.keys()]).toEqual(["tool-view"]);
  expect(extension.tools.size + extension.shortcuts.size).toBe(0);
  expect([...extension.handlers.keys()].sort()).toEqual(["session_shutdown", "session_start", "tool_execution_start"]);
});
