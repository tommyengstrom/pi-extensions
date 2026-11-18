import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export interface ToolSnapshot {
  name: string;
  source: string;
  path: string;
  exposure: ToolInfo["exposure"];
  schema: string;
  active: boolean;
  callable: boolean;
  namespace?: string;
}
export interface CapabilitySnapshot {
  tools: ToolSnapshot[];
  excluded: string[];
  files: Array<{ path: string; realpath: string; sha256: string }>;
  builtins: string[];
}
const native = new Set(["read", "write", "edit", "bash", "powershell", "ls", "grep", "find"]);
const builtinExtensions = new Set(["builtin:codemode", "builtin:tool_search", "builtin:tool-search", "builtin:mcp"]);

/** Canonical JSON rejects closure-backed schemas rather than silently dropping fields. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.entries(value)
      // Optional SDK fields are absent on the wire; functions still fail closed.
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  throw new Error("Capability metadata is not reproducible JSON.");
}
function schema(tool: ToolInfo): string {
  // TypeBox schemas have symbol metadata; JSON Schema's string keys are authoritative.
  return createHash("sha256").update(canonical(tool.parameters)).digest("hex");
}
function identity(tool: ToolInfo, active: boolean): ToolSnapshot {
  return {
    name: tool.name,
    path: tool.sourceInfo.path,
    source: tool.sourceInfo.source,
    exposure: tool.exposure,
    schema: schema(tool),
    active,
    ...(tool.namespace ? { namespace: tool.namespace.name } : {}),
    callable: tool.exposure === "codemode" || tool.exposure === "deferred" || (tool.exposure === "direct" && active),
  };
}

/** Inventory is not authority: only active direct/model-only and registered callable tools qualify. */
export async function captureCapabilities(
  all: readonly ToolInfo[],
  active: readonly string[],
  restrictions?: { allowedTools: readonly string[]; parentOnly: readonly string[] },
): Promise<CapabilitySnapshot> {
  const activeSet = new Set(active);
  const ceiling = restrictions ? new Set(restrictions.allowedTools) : undefined;
  const parentOnly = new Set(restrictions?.parentOnly ?? []);
  const snapshot: CapabilitySnapshot = { tools: [], excluded: [], files: [], builtins: [] };
  const seen = new Set<string>();
  for (const tool of all) {
    if (seen.has(tool.name)) throw new Error(`Ambiguous tool identity: ${tool.name}`);
    seen.add(tool.name);
    if (tool.exposure === "hidden") continue;
    if (!activeSet.has(tool.name) && tool.exposure !== "codemode" && tool.exposure !== "deferred") continue;
    if (parentOnly.has(tool.name)) {
      snapshot.excluded.push(tool.name);
      continue;
    }
    if (ceiling && !ceiling.has(tool.name)) continue;
    snapshot.tools.push(identity(tool, activeSet.has(tool.name)));
  }
  for (const name of active) if (!seen.has(name)) throw new Error(`Active tool missing from inventory: ${name}`);
  for (const tool of snapshot.tools) {
    if (tool.source === "sdk")
      throw new Error(
        `Unsupported capability ${tool.name}: inline SDK closure. Select a reproducible file-backed tool.`,
      );
    if (tool.source === "builtin" && native.has(tool.name) && tool.path === `builtin:${tool.name}`) continue;
    if (builtinExtensions.has(tool.path) && tool.source === "builtin") {
      if (!snapshot.builtins.includes(tool.path)) snapshot.builtins.push(tool.path);
      continue;
    }
    if (!isAbsolute(tool.path)) throw new Error(`Unsupported capability source for ${tool.name}: ${tool.path}`);
    if (snapshot.files.some((file) => file.path === tool.path)) continue;
    snapshot.files.push({
      path: tool.path,
      realpath: await realpath(tool.path),
      sha256: createHash("sha256")
        .update(await readFile(tool.path))
        .digest("hex"),
    });
  }
  return snapshot;
}

/** Must run after initialization and again before dispatch; this does not start any resources. */
export async function verifySourceFiles(snapshot: CapabilitySnapshot): Promise<void> {
  for (const file of snapshot.files) {
    if (
      (await realpath(file.path)) !== file.realpath ||
      createHash("sha256")
        .update(await readFile(file.path))
        .digest("hex") !== file.sha256
    )
      throw new Error(`Selected extension source changed: ${file.path}`);
  }
}

export function verifyInventory(snapshot: CapabilitySnapshot, all: readonly ToolInfo[]): void {
  for (const expected of snapshot.tools) {
    const matches = all.filter((tool) => tool.name === expected.name);
    if (matches.length !== 1) throw new Error(`Child tool unavailable or ambiguous: ${expected.name}`);
    const actual = identity(matches[0], expected.active);
    // Explicit reconstruction changes load-location metadata (package/local -> cli).
    // Keep the original source in records, but compare canonical implementation paths,
    // schemas/exposure and builtin-vs-extension identity, not incidental load location.
    const equivalentSource =
      expected.source === "builtin"
        ? actual.source === "builtin"
        : actual.source !== "builtin" &&
          actual.source !== "sdk" &&
          isAbsolute(expected.path) &&
          actual.path === expected.path;
    if (!equivalentSource || canonical({ ...actual, source: expected.source }) !== canonical(expected))
      throw new Error(`Child tool provenance/schema/exposure mismatch: ${expected.name}`);
  }
}

/** Called for EVERY direct and nested tool_call, including tools registered after startup. */
export function permitsCall(
  snapshot: CapabilitySnapshot,
  all: readonly ToolInfo[],
  name: string,
  nested: boolean,
): boolean {
  const expected = snapshot.tools.find((tool) => tool.name === name);
  if (
    !expected ||
    (nested
      ? !expected.callable
      : !(expected.active || expected.exposure === "deferred" || expected.exposure === "codemode"))
  )
    return false;
  try {
    verifyInventory({ ...snapshot, tools: [expected] }, all);
    return true;
  } catch {
    return false;
  }
}
