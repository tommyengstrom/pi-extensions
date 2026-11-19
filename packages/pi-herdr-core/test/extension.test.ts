import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { delegationService, WorkflowScope } from "@narumitw/pi-background";
import { expect, it, vi } from "vitest";
import { backgroundFixture } from "../../../test/background-fixture.js";
import herdr from "../src/herdr.js";
import { parseTask, profile } from "../src/launch.js";

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
      modelRegistry: { getRegisteredNativeProvider: () => undefined, getRegisteredProviderConfig: () => undefined },
    });
    const dispatch = vi.spyOn(Workers.prototype, "launch").mockImplementation(async (scope, _cwd, prepare) => {
      const { argv, omissions } = await prepare(join(dir, "worker"));
      expect(argv[argv.indexOf("--tools") + 1]).toBe("artifact_search");
      expect(omissions).toEqual([]);
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
      const attachment = argv.at(-1) ?? "";
      expect(attachment.startsWith("@")).toBe(true);
      expect(await readFile(attachment.slice(1), "utf8")).toBe(
        `Delegated task:\nSummarize\n\nCurrent saved plan (Markdown):\n${plan}`,
      );
      return { id: "completion", scope, state: "running", omissions: [] };
    });
    const done = Promise.withResolvers<Awaited<ReturnType<Workers["finish"]>>>();
    const finish = vi.spyOn(Workers.prototype, "finish").mockReturnValueOnce(done.promise);
    const result = delegationService(f.pi)(f.ctx, { task: "Summarize", plan }, new AbortController().signal);
    await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
    done.resolve({ id: "completion", scope: "test", state: "succeeded", result: "Final summary", omissions: [] });
    expect(await result).toBe("succeeded: Final summary");
    expect(dispatch).toHaveBeenCalledTimes(2);
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
it("a profile is a name, not an executable or path", async () => {
  await expect(profile("/tmp", "../bash")).rejects.toThrow(/Invalid/);
});
