import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { captureCapabilities, permitsCall, verifyInventory, verifySourceFiles } from "../src/capabilities.js";

function tool(
  name: string,
  exposure: ToolInfo["exposure"] = "direct",
  path = `builtin:${name}`,
  source = "builtin",
): ToolInfo {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    exposure,
    sourceInfo: { path, source, scope: "temporary", origin: "top-level" },
  } as ToolInfo;
}
describe("capability snapshots", () => {
  it("separates active, callable and registered tools", async () => {
    const all = [
      tool("read"),
      tool("write"),
      tool("model", "model-only", "builtin:codemode"),
      tool("mcp__docs__find", "deferred", "builtin:mcp"),
      tool("hidden", "hidden", "builtin:mcp"),
    ];
    const snapshot = await captureCapabilities(all, ["read", "model"]);
    expect(snapshot.tools.map((item) => item.name)).toEqual(["read", "model", "mcp__docs__find"]);
    expect(permitsCall(snapshot, all, "write", false)).toBe(false);
    expect(permitsCall(snapshot, all, "model", true)).toBe(false);
    expect(permitsCall(snapshot, all, "model", false)).toBe(true);
    expect(permitsCall(snapshot, all, "mcp__docs__find", true)).toBe(true);
  });
  it("respects explicit empty restrictions and parent-only exclusions", async () => {
    expect((await captureCapabilities([tool("read")], ["read"], { allowedTools: [], parentOnly: [] })).tools).toEqual(
      [],
    );
    const snapshot = await captureCapabilities([tool("read")], ["read"], {
      allowedTools: ["read"],
      parentOnly: ["read"],
    });
    expect(snapshot.tools).toEqual([]);
    expect(snapshot.excluded).toEqual(["read"]);
  });
  it("rejects SDK closures rather than substituting a builtin", async () => {
    await expect(captureCapabilities([tool("read", "direct", "sdk:read", "sdk")], ["read"])).rejects.toThrow(
      /inline SDK/,
    );
  });
  it("verifies file-backed source and exact tool schema/exposure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-herdr-core-capability-"));
    try {
      const path = join(directory, "extension.ts");
      await writeFile(path, "export default () => {};\n");
      const selected = tool("read", "direct", path, "extension");
      const snapshot = await captureCapabilities([selected], ["read"]);
      await expect(verifySourceFiles(snapshot)).resolves.toBeUndefined();
      expect(() => verifyInventory(snapshot, [tool("read")])).toThrow(/mismatch/);
      expect(() => verifyInventory(snapshot, [{ ...selected, exposure: "model-only" }])).toThrow(/mismatch/);
      expect(() => verifyInventory(snapshot, [{ ...selected, parameters: { type: "string" } } as ToolInfo])).toThrow(
        /mismatch/,
      );
      await writeFile(path, "export default () => { throw new Error(); };\n");
      await expect(verifySourceFiles(snapshot)).rejects.toThrow(/changed/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("does not broaden the ceiling for dynamic registration", async () => {
    const selected = tool("read");
    const snapshot = await captureCapabilities([selected], ["read"]);
    expect(permitsCall(snapshot, [selected, tool("write")], "write", false)).toBe(false);
    expect(permitsCall(snapshot, [selected, tool("write")], "write", true)).toBe(false);
  });
});
