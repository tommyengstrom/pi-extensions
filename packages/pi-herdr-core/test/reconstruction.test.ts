/* biome-ignore-all lint/style/noNonNullAssertion: The fixture registers the selected read tool. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { captureCapabilities, permitsCall, verifyInventory, verifySourceFiles } from "../src/capabilities.js";

describe("ordinary file-backed capability reconstruction through public SDK APIs", () => {
  it("recreates an overridden builtin from its file and tolerates package-to-CLI provenance relocation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-herdr-core-file-extension-"));
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const path = join(directory, "custom-read.ts");
      await writeFile(
        path,
        `import { Type } from "typebox";
export default function(pi) {
  pi.registerTool({ name: "read", label: "Scoped read", description: "Fixture override",
    parameters: Type.Object({ path: Type.String() }),
    async execute() { return { content: [{ type: "text", text: "fixture" }], details: {} }; }
  });
}`,
      );
      const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
      const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: getAgentDir(),
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: [path],
      });
      await loader.reload({ resolveProjectTrust: async () => true });
      expect(loader.getExtensions().errors).toEqual([]);
      const runtime = await ModelRuntime.create({
        authPath: join(directory, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
      });
      runtime.registerProvider("fixture", {
        api: "openai-completions",
        apiKey: "unused",
        baseUrl: "http://127.0.0.1:9",
        models: [
          {
            id: "fixture",
            name: "Fixture",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:9",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 512,
          },
        ],
        streamSimple() {
          throw new Error("No provider request is permitted in this reconstruction test.");
        },
      });
      const created = await createAgentSession({
        cwd: directory,
        modelRuntime: runtime,
        model: runtime.getModel("fixture", "fixture"),
        resourceLoader: loader,
        settingsManager: settings,
        sessionManager: SessionManager.inMemory(directory),
        tools: ["read"],
      });
      session = created.session;
      await session.bindExtensions({ mode: "json" });
      const actual = session.getAllTools();
      const selected = actual.find((tool) => tool.name === "read")!;
      expect(selected.sourceInfo.path).toBe(path);
      expect(selected.sourceInfo.source).not.toBe("builtin");
      const captured = await captureCapabilities(
        [{ ...selected, sourceInfo: { ...selected.sourceInfo, source: "package" } }],
        ["read"],
      );
      await verifySourceFiles(captured);
      expect(() => verifyInventory(captured, actual)).not.toThrow();
      expect(permitsCall(captured, actual, "read", true)).toBe(true);
      const builtin = { ...selected, sourceInfo: { ...selected.sourceInfo, source: "builtin", path: "builtin:read" } };
      expect(() => verifyInventory(captured, [builtin])).toThrow();
    } finally {
      if (session) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
