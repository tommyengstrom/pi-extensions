/* biome-ignore-all lint/style/noNonNullAssertion: Fixture tools and commands are required registrations. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { backgroundRuntime } from "@narumitw/pi-background";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backgroundFixture } from "../../../test/background-fixture.js";

const state = vi.hoisted(() => ({
  created: 0,
  launches: [] as Record<string, unknown>[],
  disposed: 0,
  child: false,
  request: vi.fn(async () => ({ accepted: true })),
}));
vi.mock("../src/child-context.js", () => ({
  childContext: () => (state.child ? { peer: { request: state.request }, job: "job", attempt: "attempt" } : undefined),
}));
vi.mock("../src/snapshot.js", () => ({
  captureChildSnapshot: async () => ({ capabilities: { excluded: [] }, model: { provider: "fake", id: "fake" } }),
}));
vi.mock("../src/supervisor.js", () => ({
  Supervisor: class {
    root = "root";
    constructor() {
      state.created++;
    }
    list() {
      return [];
    }
    async launch(value: Record<string, unknown>) {
      state.launches.push(value);
      return { id: "job", scope: value.scope, state: "running" };
    }
    async dispose() {
      state.disposed++;
    }
    async revoke() {}
    hold() {}
  },
}));

import herdr from "../src/herdr.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  state.child = false;
  state.created = 0;
  state.disposed = 0;
  state.launches.length = 0;
  state.request.mockClear();
  vi.unstubAllEnvs();
});
async function fixture() {
  const f = backgroundFixture();
  herdr(f.pi);
  f.pi.setActiveTools([...f.tools.keys()]);
  await f.emit("session_start");
  cleanups.push(() => f.emit("session_shutdown"));
  return f;
}
async function execute(f: ReturnType<typeof backgroundFixture>, name: string, params: object) {
  const method = f.tools.get(name)!.execute as (
    id: string,
    params: object,
    signal: undefined,
    update: undefined,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
  return method("call", params, undefined, undefined, f.ctx);
}
describe("Herdr extension surface and lifecycle", () => {
  it("registers five distinct tools without allocating processes, storage or timers", async () => {
    const f = await fixture();
    expect([...f.tools.keys()]).toEqual([
      "subagent",
      "subagent_query",
      "subagent_wait",
      "subagent_cancel",
      "subagent_steer",
    ]);
    expect(state.created).toBe(0);
    expect(existsSync(join(process.env.PI_CODING_AGENT_DIR!, "pi-herdr-core"))).toBe(false);
    expect(f.tools.has("subagent_cleanup")).toBe(false);
    for (const name of ["subagent", "subagent_steer"]) {
      const schema = f.tools.get(name)!.parameters as { properties: Record<string, unknown> };
      expect(schema.properties).not.toHaveProperty("model");
      expect(schema.properties).not.toHaveProperty("parent");
      expect(schema.properties).not.toHaveProperty("tools");
    }
  });
  it("uses one dispatcher regardless of extension/library load order and removes service handlers", async () => {
    const f = backgroundFixture();
    const runtime = backgroundRuntime(f.pi);
    herdr(f.pi);
    expect(backgroundRuntime(f.pi)).toBe(runtime);
    expect(f.handlerCount("turn_end")).toBe(1);
    await f.emit("session_start");
    await f.emit("session_shutdown");
    expect(f.emitter.listenerCount("pi-background:work-status:v1")).toBe(0);
    expect(f.emitter.listenerCount("pi-background:scope:v1")).toBe(0);
  });
  it("delegates the entire literal human argument without a launch subcommand", async () => {
    vi.stubEnv("HC_TERMINAL_ID", "t1");
    vi.stubEnv("HC_TERMINAL_SOCKET", "/private/core.sock");
    const f = await fixture();
    const handler = f.commands.get("subagent")!.handler as (
      args: string,
      ctx: ExtensionCommandContext,
    ) => Promise<void>;
    await handler("launch /not-a-command; inspect everything literally", f.ctx as ExtensionCommandContext);
    expect(state.launches[0].task).toBe("launch /not-a-command; inspect everything literally");
    expect(state.created).toBe(1);
  });
  it("the slash command cannot bypass an explicit empty tool selection", async () => {
    const f = await fixture();
    f.pi.setActiveTools([]);
    await expect(execute(f, "subagent", { task: "inspect" })).rejects.toThrow(/not selected/);
    const handler = f.commands.get("subagent")!.handler as (
      args: string,
      ctx: ExtensionCommandContext,
    ) => Promise<void>;
    await handler("inspect", f.ctx as ExtensionCommandContext);
    expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not selected"), "error");
    expect(state.created).toBe(0);
  });
  it("does not allocate a supervisor for observation and cannot reacquire old control", async () => {
    const f = await fixture();
    await execute(f, "subagent_query", { action: "list" });
    expect(state.created).toBe(0);
    await expect(execute(f, "subagent_cancel", { id: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow(
      /Historical/,
    );
    expect(state.created).toBe(0);
  });
  it("a controlled child registers only descendant proxies, not another root supervisor", async () => {
    state.child = true;
    const f = await fixture();
    await execute(f, "subagent_query", { action: "list" });
    expect(state.request).toHaveBeenCalledWith("query", { action: "list" }, 60000);
    expect(state.created).toBe(0);
    expect(f.commands.size).toBe(0);
    expect(f.handlerCount("turn_end")).toBe(0);
  });
});
