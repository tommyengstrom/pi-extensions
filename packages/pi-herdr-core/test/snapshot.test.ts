/* biome-ignore-all lint/style/noNonNullAssertion: Isolated test setup always provides an agent directory. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backgroundFixture } from "../../../test/background-fixture.js";

vi.mock("../src/runtime-resolution.js", () => ({ resolveSdkEntry: async () => "file:///installed/pi/dist/index.js" }));

import { captureChildSnapshot, verifyConfiguration } from "../src/snapshot.js";

let cwd: string;
const agent = process.env.PI_CODING_AGENT_DIR!;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-herdr-core-snapshot-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(join(agent, "mcp.json"), { force: true });
});
function tool(name: string, path = "builtin:mcp", exposure = "deferred", namespace?: string): ToolInfo {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    exposure,
    sourceInfo: { path, source: "builtin", scope: "temporary", origin: "top-level" },
    ...(namespace ? { namespace: { name: namespace } } : {}),
  } as ToolInfo;
}
function fixture(tools: ToolInfo[], trusted = true) {
  const f = backgroundFixture();
  f.catalogue.push(...tools);
  f.pi.setActiveTools(tools.filter((item) => item.exposure === "direct").map((item) => item.name));
  const ctx = {
    ...f.ctx,
    cwd,
    isProjectTrusted: () => trusted,
    thinkingLevel: "off",
    model: { provider: "fake", id: "deterministic" },
    modelRegistry: {
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "private-key" }),
    },
  } as unknown as ExtensionContext;
  return { ...f, ctx };
}
describe("private child capability/configuration capture", () => {
  it("does not parse unrelated broken MCP config for native-only delegation", async () => {
    await writeFile(join(agent, "mcp.json"), "broken JSON");
    const f = fixture([tool("read", "builtin:read", "direct")]);
    const snapshot = await captureChildSnapshot(f.pi, f.ctx);
    expect(snapshot.mcp).toEqual([]);
    expect(snapshot.configFiles).toEqual([]);
    expect(snapshot.capabilities.tools.map((item) => item.name)).toEqual(["read"]);
  });
  it("captures configured and extension-registered MCP without ambient server fallback", async () => {
    await writeFile(
      join(agent, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          docs: { command: "docs-server", exposure: "deferred" },
          unrelated: { command: "unrelated-server" },
        },
      }),
    );
    const f = fixture([tool("mcp__docs__find"), tool("mcp__registered__lookup")]);
    const pi = {
      ...f.pi,
      getMcpServers: () => [
        {
          name: "registered",
          config: { command: "registered-server", exposure: "deferred" },
          extensionPath: "/trusted/register.ts",
        },
      ],
    } as ExtensionAPI;
    const snapshot = await captureChildSnapshot(pi, f.ctx);
    expect(snapshot.mcp.map((server) => server.name)).toEqual(["docs", "registered"]);
    expect(snapshot.capabilities.tools.every((item) => item.callable && !item.active)).toBe(true);
    await expect(verifyConfiguration(snapshot)).resolves.toBeUndefined();
    await writeFile(join(agent, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    await expect(verifyConfiguration(snapshot)).rejects.toThrow(/changed/);
  });
  it("honors project trust, partial overrides, and global precedence over registered definitions", async () => {
    await mkdir(join(cwd, ".pi"));
    await writeFile(
      join(agent, "mcp.json"),
      JSON.stringify({ mcpServers: { docs: { command: "global-server", exposure: "codemode" } } }),
    );
    await writeFile(join(cwd, ".pi/mcp.json"), JSON.stringify({ mcpServers: { docs: { exposure: "direct" } } }));
    const f = fixture([tool("mcp__docs__find", "builtin:mcp", "direct")]);
    const snapshot = await captureChildSnapshot(f.pi, f.ctx);
    expect(snapshot.mcp[0].config).toMatchObject({ command: "global-server", exposure: "direct" });
    const untrusted = await captureChildSnapshot(f.pi, { ...f.ctx, isProjectTrusted: () => false });
    expect(untrusted.mcp[0].config.exposure).toBe("codemode");
    expect(untrusted.configFiles).toHaveLength(1);
  });
  it("uses MCP namespace identity for tool names shortened by the host", async () => {
    const name = "long_server_name_".repeat(5);
    await writeFile(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { [name]: { command: "server" } } }));
    const f = fixture([tool("mcp__long_server_name_shortened_hash", "builtin:mcp", "codemode", `mcp__${name}`)]);
    expect((await captureChildSnapshot(f.pi, f.ctx)).mcp[0].name).toBe(name);
  });
  it("rejects inline provider transports before any task work", async () => {
    const f = fixture([tool("read", "builtin:read", "direct")]);
    const ctx = {
      ...f.ctx,
      modelRegistry: { ...f.ctx.modelRegistry, getRegisteredProviderConfig: () => ({ streamSimple() {} }) },
    } as unknown as ExtensionContext;
    await expect(captureChildSnapshot(f.pi, ctx)).rejects.toThrow(/Unsupported stateful/);
  });
});
