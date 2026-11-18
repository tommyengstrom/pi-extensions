import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type McpServerEntry,
} from "@earendil-works/pi-coding-agent";
import { type CapabilitySnapshot, canonical, captureCapabilities } from "./capabilities.js";
import { resolveSdkEntry } from "./runtime-resolution.js";

export interface ChildSnapshot {
  version: 1;
  cwd: string;
  trusted: boolean;
  agentDir: string;
  sdkUrl: string;
  capabilities: CapabilitySnapshot;
  mcp: McpServerEntry[];
  model: Model<Api>;
  thinking: NonNullable<ExtensionContext["thinkingLevel"]>;
  providerConfig?: Record<string, unknown>;
  auth: { apiKey?: string; headers?: Record<string, string>; baseUrl?: string; env?: Record<string, string> };
  guidance: string;
  environment: Record<string, string>;
  configFiles: Array<{ path: string; hash: string | null }>;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
async function configuration(path: string): Promise<{ value: Record<string, unknown>; hash: string | null }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return { value: {}, hash: null };
    throw error;
  }
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("MCP configuration exceeds limit.");
  const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!record(value) || (value.mcpServers !== undefined && !record(value.mcpServers)))
    throw new Error("Invalid MCP configuration.");
  return { value, hash: createHash("sha256").update(text).digest("hex") };
}

/** Only serializable provider configuration can cross the process boundary. No closure cloning. */
export async function captureChildSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  restrictions?: {
    allowedTools: readonly string[];
    parentOnly: readonly string[];
    guidance: string;
  },
): Promise<ChildSnapshot> {
  const model = ctx.model;
  if (!model) throw new Error("Select a model before delegating.");
  if (ctx.modelRegistry.getRegisteredNativeProvider(model.provider))
    throw new Error(
      "Unsupported extension-only provider transport: native provider objects cannot be reproduced in a child.",
    );
  const providerConfig = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
  if (providerConfig) {
    try {
      canonical(providerConfig);
    } catch {
      throw new Error("Unsupported stateful/custom provider transport. Use a serializable provider configuration.");
    }
  }
  const agentDir = getAgentDir();
  const capabilities = await captureCapabilities(pi.getAllTools(), pi.getActiveTools(), restrictions);
  const configFiles: ChildSnapshot["configFiles"] = [];
  const configured = new Map<string, McpServerEntry>();
  const needsMcp = capabilities.tools.some((tool) => tool.path === "builtin:mcp");
  // Native/file-tool delegation never reads unrelated MCP configuration.
  // Same documented merge semantics as Pi: partial overrides apply to global config.
  for (const scope of (needsMcp ? ["global", ...(ctx.isProjectTrusted() ? ["project"] : [])] : []) as Array<
    "global" | "project"
  >) {
    const path = scope === "global" ? join(agentDir, "mcp.json") : join(ctx.cwd, CONFIG_DIR_NAME, "mcp.json");
    const file = await configuration(path);
    configFiles.push({ path, hash: file.hash });
    for (const [name, raw] of Object.entries((file.value.mcpServers ?? {}) as Record<string, unknown>)) {
      if (!record(raw)) throw new Error("Invalid MCP server definition.");
      const partial = scope === "project" && !["command", "url", "type"].some((key) => key in raw);
      if (partial) {
        const previous = configured.get(name);
        if (!previous || Object.keys(raw).some((key) => !["enabled", "exposure", "toolExposure"].includes(key)))
          throw new Error("Invalid project MCP override.");
        configured.set(name, { ...previous, config: { ...previous.config, ...raw }, override: path });
      } else {
        if (scope === "project" && "auth" in raw)
          throw new Error("Project MCP provider-auth configuration is not permitted.");
        configured.set(name, { name, source: path, scope, config: raw as unknown as McpServerEntry["config"] });
      }
    }
  }
  // File configuration takes precedence, as it does in the parent's MCP extension.
  for (const server of needsMcp ? pi.getMcpServers() : [])
    if (!configured.has(server.name))
      configured.set(server.name, {
        name: server.name,
        config: structuredClone(server.config),
        source: server.extensionPath,
        scope: "extension",
      });
  const resourceTools = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
  const needsAll = capabilities.tools.some((tool) => resourceTools.has(tool.name));
  const mcp = [...configured.values()].filter(
    (server) =>
      server.config.enabled !== false &&
      (needsAll ||
        capabilities.tools.some(
          (tool) =>
            tool.namespace === `mcp__${server.name.replaceAll("-", "_")}` ||
            tool.name.startsWith(`mcp__${server.name.replaceAll("-", "_")}__`),
        )),
  );
  for (const tool of capabilities.tools.filter((tool) => tool.path === "builtin:mcp" && tool.name.startsWith("mcp__")))
    if (
      !mcp.some(
        (server) =>
          tool.namespace === `mcp__${server.name.replaceAll("-", "_")}` ||
          tool.name.startsWith(`mcp__${server.name.replaceAll("-", "_")}__`),
      )
    )
      throw new Error(
        `Cannot reproduce MCP server for selected tool ${tool.name}. Reconnect the configured server before delegating.`,
      );
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error("Selected parent model authentication is unavailable.");
  const sdkUrl = await resolveSdkEntry();
  const snapshot: ChildSnapshot = {
    version: 1,
    cwd: ctx.cwd,
    trusted: ctx.isProjectTrusted(),
    agentDir,
    sdkUrl,
    capabilities,
    mcp,
    model: structuredClone(model),
    thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(),
    ...(providerConfig ? { providerConfig: JSON.parse(canonical(providerConfig)) as Record<string, unknown> } : {}),
    auth: {
      apiKey: auth.apiKey,
      headers: auth.headers as Record<string, string> | undefined,
      baseUrl: auth.baseUrl,
      env: auth.env,
    },
    guidance:
      restrictions?.guidance ??
      "Follow the task and trusted project instructions. You cannot approve a workflow or grant yourself additional capabilities.",
    // Core's service environment is not necessarily the immediate parent's shell
    // environment. Preserve ordinary extension/MCP subprocess configuration privately.
    environment: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          !entry[0].startsWith("HC_") &&
          !entry[0].startsWith("PI_HERDR_") &&
          !["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"].includes(entry[0]),
      ),
    ),
    configFiles,
  };
  // Private IPC only: never persist this snapshot; auth/configuration can contain credentials.
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 192 * 1024)
    throw new Error("Child startup snapshot exceeds private IPC capacity.");
  return snapshot;
}
export async function verifyConfiguration(snapshot: ChildSnapshot): Promise<void> {
  for (const expected of snapshot.configFiles)
    if ((await configuration(expected.path)).hash !== expected.hash)
      throw new Error(
        "MCP configuration changed during delegation startup. Start a new task after policy is recaptured.",
      );
}
