import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

interface ToolSnapshot {
  name: string;
  source: string;
  path: string;
  exposure: ToolInfo["exposure"];
  schema: string;
  active: boolean;
  callable: boolean;
  namespace?: string;
  registration?: string;
}
type Servers = ReturnType<ExtensionAPI["getMcpServers"]>;
function registeredServer(tool: ToolInfo, servers: Servers) {
  return servers.find((s) => tool.namespace?.aliases?.includes(s.name));
}
interface Candidate {
  name: string;
  tool?: ToolSnapshot;
  reason?: string;
  registrar?: string;
}
export interface CapabilitySnapshot {
  tools: ToolSnapshot[];
  omissions: string[];
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
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  throw new Error("Capability metadata is not reproducible JSON.");
}
function identity(tool: ToolInfo, active: boolean, servers: Servers): ToolSnapshot {
  const server = tool.sourceInfo.path === "builtin:mcp" && registeredServer(tool, servers);
  return {
    ...(server ? { registration: createHash("sha256").update(canonical(server)).digest("hex") } : {}),
    name: tool.name,
    path: tool.sourceInfo.path,
    source: tool.sourceInfo.source,
    exposure: tool.exposure,
    schema: createHash("sha256").update(canonical(tool.parameters)).digest("hex"),
    active,
    ...(tool.namespace ? { namespace: tool.namespace.name } : {}),
    callable: tool.exposure === "codemode" || tool.exposure === "deferred" || (tool.exposure === "direct" && active),
  };
}

/** Copy identities, not live ToolInfo/schema objects. No asynchronous work or resource startup. */
export function captureCapabilities(
  all: readonly ToolInfo[],
  active: readonly string[],
  servers: Servers = [],
): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const tool of all) {
    const { name, exposure } = tool;
    if (seen.has(name)) {
      const prior = candidates.findIndex((c) => c.name === name);
      const ambiguous = { name, reason: "ambiguous parent tool identity" };
      if (prior >= 0) candidates[prior] = ambiguous;
      else candidates.push(ambiguous);
      continue;
    }
    seen.add(name);
    const direct = active.includes(name);
    if (exposure === "hidden" || (!direct && exposure !== "codemode" && exposure !== "deferred")) continue;
    try {
      const captured = identity(tool, direct, servers);
      let reason: string | undefined;
      let registrar: string | undefined;
      if (!/^[a-zA-Z0-9_][\w.-]*$/.test(name)) reason = "not an exact CLI tool name";
      else if (captured.source === "sdk") reason = "inline SDK closure";
      else if (captured.path === "builtin:mcp") {
        if (!name.startsWith("mcp__")) reason = "cannot verify the connected MCP resource server set";
        else {
          registrar = registeredServer(tool, servers)?.extensionPath;
          if (registrar && !isAbsolute(registrar)) reason = "MCP registrar is not file-backed";
        }
      }
      candidates.push({ name, tool: captured, reason, registrar });
    } catch {
      candidates.push({ name, reason: "unreproducible capability metadata" });
    }
  }
  for (const name of active) if (!seen.has(name)) candidates.push({ name, reason: "missing from parent inventory" });
  return candidates;
}
export function delegable(
  candidates: readonly Candidate[],
  parentOnly: readonly string[],
  allowed?: readonly string[],
  callable?: readonly string[],
  hidden: readonly string[] = [],
) {
  return candidates
    .filter(({ name }) => !parentOnly.includes(name) && (!allowed || allowed.includes(name)))
    .flatMap((candidate) => {
      const { name, tool } = candidate;
      if (!tool) return [candidate];
      const nested = tool.callable && (!callable || callable.includes(name));
      if (hidden.includes(name)) return [{ name, reason: "parent suppresses the tool declaration" }];
      if (!tool.active && !nested) return [];
      return [{ ...candidate, tool: { ...tool, callable: nested } }];
    });
}
async function fingerprint(path: string) {
  return {
    path,
    realpath: await realpath(path),
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  };
}
export async function resolveCapabilities(candidates: readonly Candidate[], profile?: readonly string[]) {
  const selection: CapabilitySnapshot = { tools: [], omissions: [], files: [], builtins: [] };
  for (const { name, tool, reason, registrar } of candidates) {
    if (profile && !profile.includes(name)) continue;
    if (!tool || reason) {
      selection.omissions.push(`${name}: ${reason}`);
      continue;
    }
    const builtin = tool.source === "builtin" && builtinExtensions.has(tool.path);
    const path = builtin
      ? registrar
      : native.has(name) && tool.source === "builtin" && tool.path === `builtin:${name}`
        ? undefined
        : tool.path;
    if (path !== undefined && !selection.files.some((f) => f.path === path)) {
      try {
        if (!isAbsolute(path)) throw new Error();
        selection.files.push(await fingerprint(path));
      } catch {
        selection.omissions.push(`${name}: no readable file-backed source`);
        continue;
      }
    }
    if (builtin && !selection.builtins.includes(tool.path)) selection.builtins.push(tool.path);
    selection.tools.push(tool);
  }
  return selection;
}

export async function verifySourceFiles(snapshot: CapabilitySnapshot): Promise<void> {
  for (const file of snapshot.files)
    if (canonical(await fingerprint(file.path)) !== canonical(file))
      throw new Error(`Selected extension source changed: ${file.path}`);
}
export function matchesIdentity(expected: ToolSnapshot, all: readonly ToolInfo[], servers: Servers = []): boolean {
  const matches = all.filter((t) => t.name === expected.name);
  if (matches.length !== 1) return false;
  try {
    const actual = identity(matches[0], expected.active, servers);
    // Loading a file explicitly changes package/local provenance to CLI, not its implementation path.
    return (
      (expected.source === "builtin"
        ? actual.source === "builtin"
        : actual.source !== "builtin" && actual.source !== "sdk") &&
      actual.path === expected.path &&
      actual.schema === expected.schema &&
      actual.exposure === expected.exposure &&
      actual.registration === expected.registration &&
      actual.namespace === expected.namespace
    );
  } catch {
    return false;
  }
}
export function permitsCall(
  snapshot: CapabilitySnapshot,
  all: readonly ToolInfo[],
  name: string,
  nested: boolean,
  active: readonly string[],
  servers: Servers = [],
): boolean {
  const expected = snapshot.tools.find((t) => t.name === name);
  return (
    !!expected &&
    (nested
      ? expected.callable
      : active.includes(name) &&
        (expected.active || expected.exposure === "deferred" || expected.exposure === "codemode")) &&
    matchesIdentity(expected, all, servers)
  );
}
