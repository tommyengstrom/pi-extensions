// Explicit CLI extension, never registered as a workspace extension. Pi itself
// owns prompting, tools, MCP, model transport, the transcript and print output.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesIdentity, permitsCall, verifySourceFiles } from "./capabilities.js";
import type { WorkerPolicy } from "./launch.js";
import { terminalText } from "./terminal-text.js";

export default function workerGuard(pi: ExtensionAPI) {
  const directory = process.env.PI_HERDR_WORKER_DIR;
  if (!directory) process.exit(1); // Throwing from an extension factory alone does not stop Pi.
  const resultFile = join(directory, "answer.json");
  function publish(ok: boolean, text: string) {
    writeFileSync(`${resultFile}.tmp`, JSON.stringify({ ok, text, omissions: policy?.capabilities?.omissions }), {
      mode: 0o600,
    });
    renameSync(`${resultFile}.tmp`, resultFile);
  }
  function fail(reason: unknown): never {
    try {
      publish(false, terminalText(String(reason)));
    } finally {
      process.exit(1);
    } // Startup notification exceptions alone do not prevent provider dispatch.
  }
  let policy: WorkerPolicy;
  try {
    policy = JSON.parse(readFileSync(join(directory, "policy.json"), "utf8"));
    if (!Array.isArray(policy?.capabilities?.tools) || !Array.isArray(policy.capabilities.omissions)) throw new Error();
  } catch {
    return fail("Unreadable worker policy");
  }
  // Keep the one-shot worker bounded even if the parent process disappears.
  const timer = setTimeout(() => fail("Worker deadline exceeded"), 600_000).unref();
  pi.on("session_shutdown", () => {
    clearTimeout(timer);
  });
  const { capabilities } = policy;
  let ready = false;
  pi.on("cache_warming_decision", () => ({ action: "stop" }));
  pi.on("before_agent_start", async (_event, ctx) => {
    try {
      if (
        ctx.model?.id !== policy.model ||
        ctx.model.provider !== policy.provider ||
        ctx.model.baseUrl !== policy.baseUrl ||
        ctx.thinkingLevel !== policy.thinking
      )
        fail("Pi CLI could not reproduce the selected parent model/thinking level.");
      await verifySourceFiles(capabilities);
      // CLI MCP registration may still be completing. Wait only for selected names.
      const deadline = Date.now() + 10000;
      while (
        capabilities.tools.some((t) => t.path === "builtin:mcp" && !pi.getAllTools().some((v) => v.name === t.name)) &&
        Date.now() < deadline
      )
        await delay(50);
      const inventory = pi.getAllTools();
      const servers = pi.getMcpServers();
      capabilities.tools = capabilities.tools.filter((t) => {
        if (matchesIdentity(t, inventory, servers)) return true;
        capabilities.omissions.push(`${t.name}: child identity unavailable or mismatched`);
        return false;
      });
      pi.setActiveTools(capabilities.tools.filter((t) => t.active).map((t) => t.name));
      writeFileSync(join(directory, "omissions.json"), JSON.stringify(capabilities.omissions), { mode: 0o600 });
      ready = true;
    } catch (e) {
      fail(e);
    }
  });
  let firstRequest = true;
  pi.on("context", () => {
    try {
      if (!ready) fail("Worker capability check did not run");
      const inventory = pi.getAllTools();
      const active = pi.getActiveTools();
      const servers = pi.getMcpServers();
      for (const name of active)
        if (
          (firstRequest && !capabilities.tools.some((t) => t.name === name && t.active)) ||
          !permitsCall(capabilities, inventory, name, false, active, servers)
        )
          fail(`Unexpected worker tool: ${name}`);
      firstRequest = false;
    } catch (e) {
      fail(e);
    }
  });
  pi.on("tool_call", (event) => {
    if (
      !ready ||
      !permitsCall(
        capabilities,
        pi.getAllTools(),
        event.toolName,
        event.parentToolCallId !== undefined,
        pi.getActiveTools(),
        pi.getMcpServers(),
      )
    )
      return { block: true, reason: `Outside inherited tool selection: ${event.toolName}` };
  });
  let answer = "";
  let ok = false;
  pi.on("message_end", ({ message }) => {
    if (message.role !== "assistant") return;
    ok = message.stopReason === "stop";
    answer = ok
      ? message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n")
      : `Worker stopped: ${message.stopReason}`;
  });
  pi.on("agent_settled", ({ aborted }) =>
    publish(ready && ok && !aborted && !!answer, aborted ? "Worker aborted" : answer || "No final assistant answer"),
  );
}
