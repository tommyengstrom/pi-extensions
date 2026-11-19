import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type CapabilitySnapshot,
  type captureCapabilities,
  resolveCapabilities,
  verifySourceFiles,
} from "./capabilities.js";
import { resolvePiCli } from "./runtime-resolution.js";

export interface Profile {
  instructions: string;
  tools?: string[];
}
export function parseTask(text: string): { task: string; agent?: string } {
  if (!/^--agent(?:\s|$)/.test(text)) return { task: text };
  const match = /^--agent\s+(\S+)\s+([\s\S]+)$/.exec(text);
  if (!match) throw new Error("Usage: /subagent --agent NAME TASK");
  return { agent: match[1], task: match[2] };
}
export async function profile(agentDir: string, name?: string): Promise<Profile> {
  if (name === undefined) return { instructions: "" };
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(name)) throw new Error("Invalid worker profile name.");
  let p: Profile;
  try {
    p = JSON.parse(await readFile(join(agentDir, "pi-herdr-core", "profiles", `${name}.json`), "utf8"));
  } catch {
    throw new Error(`Unknown or unreadable worker profile: ${name}`);
  }
  if (
    !p ||
    typeof p.instructions !== "string" ||
    Object.keys(p).some((k) => !["instructions", "tools"].includes(k)) ||
    (p.tools !== undefined && !(Array.isArray(p.tools) && p.tools.every((t) => typeof t === "string")))
  )
    throw new Error(`Invalid worker profile: ${name}`);
  return p;
}
export interface WorkerPolicy {
  capabilities: CapabilitySnapshot;
  provider: string;
  model: string;
  thinking: string;
  baseUrl: string;
}
export async function prepareWorker(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  agentDir: string,
  directory: string,
  input: { task: string; agent?: string; plan?: string },
  candidates: ReturnType<typeof captureCapabilities>,
  guidance?: string,
) {
  if (!input.task.trim() || (input.plan === undefined && Buffer.byteLength(input.task) > 32000))
    throw new Error("Expected a nonempty task of at most 32000 bytes.");
  if (!ctx.model) throw new Error("Select a model before delegating.");
  if (
    ctx.modelRegistry.getRegisteredNativeProvider(ctx.model.provider) ||
    ctx.modelRegistry.getRegisteredProviderConfig(ctx.model.provider)
  )
    throw new Error(
      `Worker cannot guarantee the parent’s runtime-registered provider ${ctx.model.provider}. Use a CLI-configured provider.`,
    );
  const trusted = ctx.isProjectTrusted();
  const model = {
    provider: ctx.model.provider,
    model: ctx.model.id,
    baseUrl: ctx.model.baseUrl,
    thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(),
  };
  const role = await profile(agentDir, input.agent);
  const capabilities = await resolveCapabilities(candidates, role.tools);
  const policy: WorkerPolicy = { capabilities, ...model };
  const extensions = [...capabilities.builtins, ...capabilities.files.map((f) => f.path)];
  const names = capabilities.tools.map((t) => t.name);
  const cli = await resolvePiCli();
  const guard = fileURLToPath(new URL("./worker-guard.ts", import.meta.url));
  await access(guard, constants.R_OK);
  await verifySourceFiles(capabilities);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "policy.json"), JSON.stringify(policy), { mode: 0o600, flag: "wx" });
  await writeFile(
    join(directory, "guidance.txt"),
    [
      role.instructions,
      guidance,
      "Answer the delegated task. Only your parent owns the workflow. You cannot delegate, save or approve plans, or change modes.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    { mode: 0o600, flag: "wx" },
  );
  // A complete saved plan may exceed the OS limit for one argv element.
  let prompt = `Delegated task:\n${input.task}`;
  if (input.plan !== undefined) {
    const path = join(directory, "completion-task.md");
    await writeFile(path, `${prompt}\n\nCurrent saved plan (Markdown):\n${input.plan}`, { mode: 0o600, flag: "wx" });
    prompt = `@${path}`;
  }
  const argv = [
    process.execPath,
    cli,
    "-p",
    "--offline",
    trusted ? "--approve" : "--no-approve",
    "--provider",
    policy.provider,
    "--model",
    policy.model,
    "--thinking",
    policy.thinking,
    "--session-dir",
    directory,
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    ...extensions.flatMap((path) => ["-e", path]),
    "-e",
    guard,
    ...(capabilities.builtins.includes("builtin:mcp") ? [] : ["--no-mcp"]),
    ...(names.length ? ["--tools", names.join(",")] : ["--no-tools"]),
    "--append-system-prompt",
    join(directory, "guidance.txt"),
    prompt,
  ];
  return { argv, omissions: capabilities.omissions };
}
