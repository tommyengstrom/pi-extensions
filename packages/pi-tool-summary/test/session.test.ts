import type { ExtensionAPI, ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";

let install: typeof import("../src/index.js").default;
let pi: typeof import("@earendil-works/pi-coding-agent");
beforeAll(async () => {
  if (!process.env.PI_CODING_AGENT_DIR) throw new Error("Missing isolated Pi directory");
  pi = await import("@earendil-works/pi-coding-agent");
  pi.initTheme("dark", false);
  ({ default: install } = await import("../src/index.js"));
});

function host(mode: string) {
  const ctx = { mode, sessionManager: {}, modelRegistry: { find: vi.fn() }, ui: { notify: vi.fn() } };
  const hooks = new Map<string, (event: object, context: typeof ctx) => unknown>();
  let resolve!: ToolRendererResolver;
  let toggle!: (args: string, context: typeof ctx) => Promise<void>;
  install({
    registerToolRenderer(renderer: ToolRendererResolver) {
      resolve = renderer;
    },
    registerCommand(_: string, command: { handler: typeof toggle }) {
      toggle = command.handler;
    },
    on(name: string, callback: (event: object, context: typeof ctx) => unknown) {
      hooks.set(name, callback);
    },
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: object, context = ctx) => hooks.get(name)?.(event, context);
  return { ctx, resolve, emit, toggle: () => toggle("", ctx) };
}
const live = { toolName: "read", toolCallId: "live", args: { path: "settings.ts" } };

test.each(["rpc", "print", "json"])("%s leaves renderers, provider and output alone", async (mode) => {
  const h = host(mode);
  h.emit("session_start", {});
  const native: ToolRenderers = {};
  expect(h.resolve("read", () => native)).toBe(native);
  h.emit("tool_execution_start", live);
  await h.toggle();
  expect(h.ctx.modelRegistry.find).not.toHaveBeenCalled();
  expect(h.ctx.ui.notify).not.toHaveBeenCalled();
});

test("resume adopts pre-bind history; toggling redraws existing rows without billing history or nested calls", async () => {
  const h = host("tui");
  const ui = { requestRender: vi.fn() };
  const row = new pi.ToolExecutionComponent(
    "read",
    "history",
    { path: "old.ts" },
    {},
    h.resolve("read", () => undefined),
    ui as unknown as TUI,
    ".",
  );
  row.updateResult({ content: [{ type: "text", text: "native output" }], isError: false });
  h.emit("session_start", { reason: "resume" });
  expect(row.render(80).join("")).toContain("Inspect old.ts");
  await h.toggle();
  expect(row.render(80).join("")).toContain("native output");
  h.emit("tool_execution_start", { ...live, toolCallId: "native" });
  await h.toggle();
  expect(row.render(80).join("")).not.toContain("native output");
  expect(ui.requestRender).toHaveBeenCalledTimes(2);
  h.emit("tool_execution_start", { ...live, parentToolCallId: "parent" });
  await Promise.resolve();
  expect(h.ctx.modelRegistry.find).not.toHaveBeenCalled();
  expect(h.emit("tool_execution_start", live)).toBeUndefined();
  await Promise.resolve();
  expect(h.ctx.modelRegistry.find).toHaveBeenCalledTimes(1);
  h.emit("session_shutdown", {});
  h.emit("tool_execution_start", { ...live, toolCallId: "late" });
  await Promise.resolve();
  expect(h.ctx.modelRegistry.find).toHaveBeenCalledTimes(1);
});
