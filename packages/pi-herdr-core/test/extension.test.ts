import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { delegationServiceV2, WorkflowScope } from "@narumitw/pi-background";
import { expect, it, vi } from "vitest";
import { backgroundFixture } from "../../../test/background-fixture.js";
import herdr from "../src/herdr.js";
import { parseTask, profile } from "../src/launch.js";

import workerGuard from "../src/worker-guard.js";
import { Workers } from "../src/workers.js";

it("captures the live selection before the named profile read", async () => {
  const f = backgroundFixture();
  const dir = await mkdtemp(join(tmpdir(), "herdr-profile-"));
  try {
    vi.stubEnv("HC_TERMINAL_ID", "t1");
    vi.stubEnv("HC_TERMINAL_SOCKET", "/unused");
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    const profiles = join(dir, "pi-herdr-core/profiles");
    await mkdir(profiles, { recursive: true });
    await writeFile(
      join(profiles, "review.json"),
      JSON.stringify({ instructions: "", tools: ["artifact_search", "artifact_create", "write", "subagent"] }),
    );
    for (const name of ["subagent", "read", "write", "artifact_search", "artifact_create"])
      f.catalogue.push({
        name,
        description: name,
        parameters: { type: "object", properties: {} },
        exposure: "direct",
        sourceInfo: {
          path: name === "artifact_search" ? "builtin:tool_search" : `builtin:${name}`,
          source: "builtin",
          scope: "temporary",
          origin: "top-level",
        },
      } as (typeof f.catalogue)[number]);
    f.pi.setActiveTools(["read", "subagent", "artifact_search", "artifact_create"]);
    Object.assign(f.ctx, {
      model: { id: "fixture", provider: "fixture", baseUrl: "local" },
      modelRegistry: {
        find: (provider: string, id: string) =>
          id === "review" ? { provider, id, reasoning: true, baseUrl: "review-endpoint" } : undefined,
        getRegisteredNativeProvider: (provider: string) => provider === "runtime",
        getRegisteredProviderConfig: () => undefined,
      },
    });
    const dispatch = vi.spyOn(Workers.prototype, "launch").mockImplementation(async (scope, _cwd, prepare) => {
      const { argv, omissions } = await prepare(join(dir, "worker"));
      expect(argv[argv.indexOf("--tools") + 1]).toBe("artifact_search");
      expect(omissions).toEqual([]);
      expect(argv[argv.indexOf("--model") + 1]).toBe("fixture");
      expect(argv[argv.indexOf("--thinking") + 1]).toBe("off");
      return { id: "worker", scope, state: "running", omissions };
    });
    herdr(f.pi);
    await f.emit("session_start");
    const execute = f.tools.get("subagent")?.execute as (...args: unknown[]) => Promise<unknown>;
    const pending = execute("call", { task: "inspect", agent: "review" }, undefined, undefined, f.ctx);
    f.pi.setActiveTools([...f.pi.getActiveTools(), "write"]);
    await pending;
    expect(dispatch).toHaveBeenCalledOnce();
    // The private service uses the same launch path, but its caller owns result delivery.
    const plan = `# Current\n${"x".repeat(50000)}`;
    dispatch.mockImplementationOnce(async (scope, _cwd, prepare, _signal, enqueue) => {
      expect(enqueue).toBe(false);
      const { argv } = await prepare(join(dir, "completion"));
      expect(argv).toContain("--no-tools");
      expect(argv).not.toContain("--tools");
      expect(argv[argv.indexOf("--model") + 1]).toBe("review");
      expect(argv[argv.indexOf("--provider") + 1]).toBe("other");
      expect(argv[argv.indexOf("--thinking") + 1]).toBe("low");
      const policy = JSON.parse(await readFile(join(dir, "completion/policy.json"), "utf8"));
      expect(policy).toMatchObject({
        capabilities: { tools: [], builtins: [], files: [] },
        model: "review",
        provider: "other",
        baseUrl: "review-endpoint",
        thinking: "low",
      });
      const attachment = argv.at(-1) ?? "";
      expect(attachment.startsWith("@")).toBe(true);
      expect(await readFile(attachment.slice(1), "utf8")).toBe(
        `Delegated task:\nSummarize\n\nCurrent saved plan (Markdown):\n${plan}`,
      );
      return { id: "completion", scope, state: "running", omissions: [] };
    });
    const done = Promise.withResolvers<Awaited<ReturnType<Workers["finish"]>>>();
    const finish = vi.spyOn(Workers.prototype, "finish").mockReturnValueOnce(done.promise);
    const signal = new AbortController().signal;
    const delegate = delegationServiceV2(f.pi);
    const result = delegate(
      f.ctx,
      {
        task: "Summarize",
        plan,
        model: "other/review",
        effort: "low",
        remove_tools: ["read", "write", "artifact_search", "absent"],
      },
      signal,
    );
    await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
    done.resolve({ id: "completion", scope: "test", state: "succeeded", result: "Final summary", omissions: [] });
    expect(await result).toBe("Final summary");
    const child = backgroundFixture();
    child.catalogue.push(...f.catalogue);
    child.pi.setActiveTools(["read"]);
    Object.assign(child.ctx, {
      model: { provider: "other", id: "review", baseUrl: "review-endpoint" },
      thinkingLevel: "low",
    });
    vi.stubEnv("PI_HERDR_WORKER_DIR", join(dir, "completion"));
    workerGuard(child.pi);
    try {
      await child.emit("before_agent_start");
      expect(child.pi.getActiveTools()).toEqual([]);
      expect(await child.emit("tool_call", { toolName: "read", parentToolCallId: "nested" })).toMatchObject({
        block: true,
      });
    } finally {
      await child.emit("session_shutdown");
    }
    expect(dispatch).toHaveBeenCalledTimes(2);
    for (const [model, effort, reason] of [
      ["other/unknown", "low", /Unknown worker model/],
      ["runtime/review", "low", /runtime-registered/],
      ["other/review", "max", /does not support/],
    ] as const) {
      await expect(delegate(f.ctx, { task: "inspect", plan, model, effort }, signal)).rejects.toThrow(reason);
    }
    expect(f.ctx.model?.id).toBe("fixture");
    expect(f.pi.getActiveTools()).toContain("read");
  } finally {
    await f.emit("session_shutdown");
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});
it("loads four tools without allocating and the slash command respects an empty selection", async () => {
  const f = backgroundFixture();
  herdr(f.pi);
  await f.emit("session_start");
  expect([...f.tools.keys()]).toEqual(["subagent", "subagent_query", "subagent_wait", "subagent_cancel"]);
  const workflow = new WorkflowScope(f.pi.events);
  workflow.replace("session", { allowedTools: ["subagent"], parentOnly: [], guidance: "" });
  const execute = f.tools.get("subagent")?.execute as (...args: unknown[]) => Promise<unknown>;
  await expect(execute("id", { task: "inspect" }, undefined, undefined, f.ctx)).rejects.toThrow(/not selected/);
  const command = f.commands.get("subagent")?.handler as (text: string, ctx: ExtensionCommandContext) => Promise<void>;
  await command("inspect", f.ctx as ExtensionCommandContext);
  expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not selected"), "error");
  expect(existsSync(join(process.env.PI_CODING_AGENT_DIR ?? "", "pi-herdr-core"))).toBe(false);
  workflow.dispose();
  await f.emit("session_shutdown");
  expect(f.emitter.listenerCount("pi-background:work-status:v1")).toBe(0);
});
it("only consumes an explicit profile selector; task remains data", () => {
  expect(parseTask("reviewer /plan exit")).toEqual({ task: "reviewer /plan exit" });
  expect(parseTask("--agent reviewer --tools bash\n$(cmd)")).toEqual({
    agent: "reviewer",
    task: "--tools bash\n$(cmd)",
  });
  expect(() => parseTask("--agent reviewer")).toThrow(/Usage/);
});
it("batch work waits for an occupied slot, while ordinary delegation remains fail-fast", async () => {
  const pool = new Workers("/unused", "t1", "/unused", () => true, vi.fn());
  const gate = Promise.withResolvers<never>();
  const prepare = vi.fn(() => gate.promise);
  const running = Promise.allSettled(Array.from({ length: 4 }, () => pool.launch("scope", ".", prepare)));
  const next = vi.fn(async () => {
    throw new Error("queued launch reached preparation");
  });
  const ctrl = new AbortController();
  const cancelled = pool.launch("scope", ".", next, ctrl.signal, false);
  const waiting = pool.launch("scope", ".", next, undefined, false);
  await expect(pool.launch("scope", ".", next)).rejects.toThrow(/Four workers/);
  expect(pool.count("scope")).toBe(4);
  ctrl.abort();
  await expect(cancelled).rejects.toThrow();
  expect(next).not.toHaveBeenCalled();
  gate.reject(new Error("offline fixture"));
  await running;
  await expect(waiting).rejects.toThrow(/reached preparation/);
  expect(next).toHaveBeenCalledOnce();
  await pool.dispose();
});
it("a profile is a name, not an executable or path", async () => {
  await expect(profile("/tmp", "../bash")).rejects.toThrow(/Invalid/);
});
