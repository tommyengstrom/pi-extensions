import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import {
  captureCapabilities,
  delegable,
  matchesIdentity,
  permitsCall,
  resolveCapabilities,
  verifySourceFiles,
} from "../src/capabilities.js";

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
it("preserves active and nested access without promoting inactive, hidden, or model-only tools", async () => {
  const all = [
    tool("read"),
    tool("write"),
    tool("model", "model-only", "builtin:codemode"),
    tool("mcp__docs__find", "deferred", "builtin:mcp"),
    tool("hidden", "hidden", "builtin:mcp"),
  ];
  const active = ["read", "model"];
  const snapshot = await resolveCapabilities(captureCapabilities(all, active));
  expect(snapshot.tools.map((t) => t.name)).toEqual(["read", "model", "mcp__docs__find"]);
  for (const [name, direct, nested] of [
    ["write", false, false],
    ["model", true, false],
    ["mcp__docs__find", false, true],
  ] as const) {
    expect(permitsCall(snapshot, all, name, false, active)).toBe(direct);
    expect(permitsCall(snapshot, all, name, true, active)).toBe(nested);
  }
});
it("respects empty ceilings and exact parent-only names", () => {
  const active = ["artifact_search", "artifact_update"];
  const captured = captureCapabilities(
    active.map((n) => tool(n)),
    active,
  );
  expect(delegable(captured, [], [])).toEqual([]);
  expect(delegable(captured, ["artifact_update"], active).map((t) => t.name)).toEqual(["artifact_search"]);
});
it("reports SDK closures and aggregate MCP access without enabling MCP", async () => {
  const selection = await resolveCapabilities(
    captureCapabilities(
      [tool("read", "direct", "sdk:read", "sdk"), tool("read_mcp_resource", "deferred", "builtin:mcp")],
      ["read"],
    ),
  );
  expect(selection.tools).toEqual([]);
  expect(selection.builtins).toEqual([]);
  expect(selection.omissions).toEqual([
    expect.stringMatching(/read: inline SDK/),
    expect.stringMatching(/read_mcp_resource:.*server set/),
  ]);
});
it("checks file-backed source and exact tool schema/exposure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-core-capability-"));
  try {
    const path = join(directory, "extension.ts");
    await writeFile(path, "export default () => {};\n");
    const selected = tool("read", "direct", path, "extension");
    const snapshot = await resolveCapabilities(captureCapabilities([selected], ["read"]));
    await expect(verifySourceFiles(snapshot)).resolves.toBeUndefined();
    const [expected] = snapshot.tools;
    expect(matchesIdentity(expected, [tool("read")])).toBe(false);
    expect(matchesIdentity(expected, [{ ...selected, exposure: "model-only" }])).toBe(false);
    expect(matchesIdentity(expected, [{ ...selected, parameters: { type: "string" } } as ToolInfo])).toBe(false);
    await writeFile(path, "export default () => { throw new Error(); };\n");
    await expect(verifySourceFiles(snapshot)).rejects.toThrow(/changed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
