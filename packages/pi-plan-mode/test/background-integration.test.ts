/* biome-ignore-all lint/style/noNonNullAssertion: Fixture registrations are mandatory for the assertions below. */
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { backgroundRuntime, readWorkflow, STATUS_EVENT, SUBAGENT_TOOL_NAMES } from "@narumitw/pi-background";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { backgroundFixture } from "../../../test/background-fixture.js";

const saved = vi.hoisted(() => ({
  pi: undefined as ExtensionAPI | undefined,
  executed: 0,
}));
vi.mock("../src/plan-mode.js", () => ({
  default: async (pi: ExtensionAPI) => {
    saved.pi = pi;
    saved.executed = 0;
    pi.registerTool({
      name: "plan_mode_complete",
      label: "Save",
      description: "Fixture save",
      parameters: Type.Object({}),
      async execute() {
        saved.executed++;
        return { content: [{ type: "text", text: "saved" }], details: {} };
      },
    });
  },
}));

import planWithBackground from "../src/background-integration.js";
import { PLAN_STATE_ENTRY } from "../src/state.js";
import { defaultPlanTools, resolvePlanTools } from "../src/tool-policy.js";

const workflow = {
  version: 3,
  id: "stable-workflow",
  instructions: "Inspect",
  template: "fixture",
  templatePrompt: "# Plan",
  previousTools: ["read", "write"],
  projectRoot: "/project",
  storage: { kind: "repo" },
};
const tool = (name: string, path = `builtin:${name}`, source = "builtin") =>
  ({
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    exposure: "direct",
    sourceInfo: { path, source, scope: "temporary", origin: "top-level" },
  }) as ToolInfo;
async function fixture() {
  const f = backgroundFixture();
  f.catalogue.push(
    tool("read"),
    ...["plan_mode_question", "plan_mode_complete", "plan_mode_edit"].map((name) =>
      tool(name, "/plan/index.ts", "extension"),
    ),
  );
  await planWithBackground(f.pi);
  await f.emit("session_start");
  saved.pi!.appendEntry(PLAN_STATE_ENTRY, { kind: "planning", workflow });
  return { ...f, runtime: backgroundRuntime(f.pi) };
}
async function complete(f: ReturnType<typeof backgroundFixture>) {
  const definition = f.tools.get("plan_mode_complete")!;
  const execute = definition.execute as (
    id: string,
    input: object,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
  return execute("call", {}, undefined, undefined, f.ctx);
}
describe("Plan-owned background integration", () => {
  it("uses verified Herdr implementations as defaults, never same-name replacements or explicit empty selections", () => {
    const herdrPath = resolve("packages/pi-herdr-core/src/index.ts");
    const catalogue = [tool("read"), ...SUBAGENT_TOOL_NAMES.map((name) => tool(name, herdrPath, "extension"))];
    expect(defaultPlanTools(catalogue)).toEqual(["read", ...SUBAGENT_TOOL_NAMES]);
    expect(
      defaultPlanTools(
        catalogue.map((entry) =>
          entry.name === "subagent" ? tool(entry.name, "/untrusted/replacement.ts", "extension") : entry,
        ),
      ),
    ).not.toContain("subagent");
    expect(resolvePlanTools(catalogue, []).allowed).toEqual([]);
    expect(resolvePlanTools(catalogue, [], "explain").allowed).toEqual([]);
  });
  it("does not broaden restored implicit or explicitly empty selections, while new workflows capture delegation defaults", async () => {
    const f = backgroundFixture();
    f.catalogue.push(
      tool("read"),
      ...SUBAGENT_TOOL_NAMES.map((name) => tool(name, resolve("packages/pi-herdr-core/src/index.ts"), "extension")),
    );
    const old = { ...workflow, id: "restored", tools: undefined };
    f.entries.push({ type: "custom", customType: PLAN_STATE_ENTRY, data: { kind: "planning", workflow: old } });
    await planWithBackground(f.pi);
    await f.emit("session_start");
    expect(defaultPlanTools(saved.pi!.getAllTools())).toEqual(["read"]);
    expect(saved.pi!.getAllTools().some((entry) => entry.name === "subagent")).toBe(true);
    expect(old.tools).toBeUndefined();
    const empty = { ...workflow, id: "explicit-empty", tools: [] as string[] };
    saved.pi!.appendEntry(PLAN_STATE_ENTRY, { kind: "planning", workflow: empty });
    expect(empty.tools).toEqual([]);
    const fresh = { ...workflow, id: "new-workflow", tools: undefined as string[] | undefined };
    saved.pi!.appendEntry(PLAN_STATE_ENTRY, { kind: "planning", workflow: fresh });
    expect(fresh.tools).toEqual(["read", ...SUBAGENT_TOOL_NAMES]);
    await f.emit("session_shutdown");
  });
  it("publishes stable workflow authority across ordinary turns and excludes parent-only helpers", async () => {
    const f = await fixture();
    const first = readWorkflow(f.pi.events, "session")!;
    expect(first.restrictions?.parentOnly).toContain("artifact_create");
    expect(first.restrictions?.parentOnly).toContain("plan_mode_implementation_complete");
    await f.emit("before_agent_start");
    expect(readWorkflow(f.pi.events, "session")?.scope).toBe(first.scope);
    saved.pi!.appendEntry(PLAN_STATE_ENTRY, { kind: "planning", workflow: { ...workflow, name: "new display name" } });
    expect(readWorkflow(f.pi.events, "session")?.scope).toBe(first.scope);
    saved.pi!.appendEntry(PLAN_STATE_ENTRY, { kind: "planning", workflow: { ...workflow, tools: [] } });
    expect(readWorkflow(f.pi.events, "session")?.scope).not.toBe(first.scope);
    await f.emit("session_shutdown");
  });
  it("blocks the save before execution while associated agents are active", async () => {
    const f = await fixture();
    const off = f.pi.events.on(STATUS_EVENT, (value) => {
      const request = value as { respond(value: { active: number; pending: number }): void };
      request.respond({ active: 1, pending: 0 });
    });
    await expect(complete(f)).rejects.toThrow(/not ready for review/);
    expect(saved.executed).toBe(0);
    off();
    await expect(complete(f)).resolves.toBeDefined();
    expect(saved.executed).toBe(1);
    await f.emit("session_shutdown");
  });
  it("requires committed retrieval of pending completions before plan publication", async () => {
    const f = await fixture();
    const recipient = f.runtime.recipient(f.ctx);
    f.runtime.enqueue({
      ...recipient,
      id: "completion",
      jobId: "job",
      topic: "result",
      summary: "Done",
      result: "result.md",
      wake: false,
    });
    await expect(complete(f)).rejects.toThrow(/pending results/);
    const details = f.runtime.resultDetails(recipient, ["completion"]);
    await expect(complete(f)).rejects.toThrow(/pending results/);
    f.entries.push({ type: "message", message: { role: "toolResult", toolName: "subagent_wait", details } });
    await expect(complete(f)).resolves.toBeDefined();
    await f.emit("session_shutdown");
  });
  it("holds ready review and rotates execution authority after abort without changing workflow identity", async () => {
    const f = await fixture();
    const first = f.runtime.recipient(f.ctx);
    await f.emit("agent_settled", { aborted: true });
    const next = f.runtime.recipient(f.ctx);
    expect(next.scope).not.toBe(first.scope);
    expect(f.runtime.owns(first)).toBe(false);
    expect(f.runtime.owns(next)).toBe(true);
    saved.pi!.appendEntry(PLAN_STATE_ENTRY, { kind: "ready", workflow, document: { path: "/project/plan.md" } });
    expect(readWorkflow(f.pi.events, "session")?.held).toBe(true);
    await f.emit("session_shutdown");
  });
});
