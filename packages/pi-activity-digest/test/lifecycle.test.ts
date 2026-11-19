import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeAll, expect, it, vi } from "vitest";
import type { Group } from "../src/model.js";

// Exercise the real model and preferences, substituting only the terminal surface.
vi.mock("../src/view.js", () => ({
  createView: (snapshot: () => Group[], _tui: unknown, done: () => void) => ({
    render: () => snapshot().map((group) => JSON.stringify(group)),
    invalidate() {},
    handleInput: done,
  }),
}));
let install: typeof import("../src/activity-digest.js").default;
beforeAll(async () => {
  if (!process.env.PI_CODING_AGENT_DIR) throw new Error("Missing Vitest agent directory");
  ({ default: install } = await import("../src/activity-digest.js"));
});

type Screen = { render(): string[]; handleInput(): void; dispose?(): void };
type Factory = (tui: { requestRender(): void }, theme: unknown, keys: unknown, done: () => void) => Screen;
function host(mode = "tui", hasUI = mode === "tui" || mode === "rpc") {
  const branch: { type: string; id: string; message: unknown }[] = [];
  const getBranch = vi.fn(() => branch);
  const sessionManager = { getBranch, getLeafId: () => branch.at(-1)?.id ?? null };
  const requestRender = vi.fn();
  let screen: Screen;
  const ui = {
    notify: vi.fn(),
    custom: vi.fn(
      (factory: Factory) =>
        new Promise<void>((resolve) => {
          screen = factory({ requestRender }, {}, {}, resolve);
        }),
    ),
  };
  const ctx = { mode, hasUI, sessionManager, ui };
  type Listener = (event: object, context: typeof ctx) => unknown;
  const handlers = new Map<string, Listener>();
  let handler: (args: string, context: typeof ctx) => Promise<void>;
  // No send*, append*, tools or context mutation capabilities in this fixture.
  install({
    on: (name: string, fn: Listener) => handlers.set(name, fn),
    registerCommand(name: string, cmd: { handler: typeof handler }) {
      expect(name).toBe("digest");
      handler = cmd.handler;
    },
  } as unknown as ExtensionAPI);
  const emit = (type: string, event = {}, context = ctx) => handlers.get(type)?.(event, context);
  emit("session_start");
  return {
    ctx,
    emit,
    ui,
    getBranch,
    requestRender,
    branch,
    persist: (message: unknown) => branch.push({ type: "message", id: String(branch.length + 1), message }),
    command: (args = "") => handler(args, ctx),
    screen: () => screen,
    groups: (): Group[] => screen.render().map((line) => JSON.parse(line)),
  };
}
const assistant = (...ids: string[]) => ({
  role: "assistant",
  timestamp: 1,
  stopReason: "toolUse",
  content: ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: id } })),
});
const result = (id: string, isError: boolean) => ({
  role: "toolResult",
  toolName: "read",
  toolCallId: id,
  content: [],
  timestamp: 1,
  isError,
});

it("reconciles a mid-stream open, out-of-order completion and persistence without duplicate calls", async () => {
  const h = host();
  h.emit("agent_start");
  h.emit("message_start", { message: assistant() });
  h.emit("message_update", { message: assistant("a") });
  expect(h.ui.custom).not.toHaveBeenCalled();
  const open = h.command();
  expect(h.groups()[0]).toMatchObject({ pending: true, items: [{ status: "running" }] });
  const m = assistant("a", "b");
  h.emit("message_update", { message: m });
  expect(h.emit("message_end", { message: m })).toBeUndefined();
  h.persist(structuredClone(m));
  h.emit("tool_execution_end", { ...result("b", true), parentToolCallId: "other" });
  expect(h.groups()[0].items.map((i) => i.status)).toEqual(["running", "running"]);
  h.emit("tool_execution_end", result("b", true));
  expect(h.groups()[0].items.map((i) => i.status)).toEqual(["running", "failed"]);
  for (const r of [result("a", false), result("b", true)]) {
    h.emit("message_start", { message: r });
    h.emit("message_end", { message: r });
    h.persist(structuredClone(r));
  }
  h.emit("agent_end");
  const final = h.groups();
  expect(final).toHaveLength(1);
  expect(final[0]).toMatchObject({ pending: false, items: [{ status: "done" }, { status: "failed" }] });
  h.screen().handleInput();
  await open;
  const replay = h.command();
  expect(h.groups()).toEqual(final);
  h.emit("session_shutdown");
  await replay;
});

it("keeps run ends on their branch, even across a mid-run close and a context-only continuation", async () => {
  const h = host();
  h.emit("agent_start");
  const old = h.command();
  h.screen().handleInput();
  await old;
  h.requestRender.mockClear();
  h.persist(assistant("abandoned"));
  h.emit("agent_end");
  h.emit("agent_start");
  h.emit("message_start", { message: assistant("new") });
  expect(h.requestRender).not.toHaveBeenCalled();
  const next = h.command();
  expect(h.groups().map((g) => [g.pending, g.items[0].status])).toEqual([
    [false, "failed"],
    [true, "running"],
  ]);
  const stale = h.screen();
  h.branch.length = 0;
  h.emit("session_tree");
  const fresh = h.command();
  stale.dispose?.(); // Late disposal and promise cleanup must not detach fresh.
  await next;
  expect(stale.render()).toEqual([]);
  expect(h.groups()).toEqual([]);
  h.emit("agent_start");
  h.emit("message_start", { message: assistant("fresh") });
  expect(h.groups()[0].items).toHaveLength(1);
  h.emit("session_shutdown");
  await fresh;
});

it("regroups existing history and rejects invalid settings without replacing the active view", async () => {
  const h = host();
  h.persist(assistant("a", "b"));
  const open = h.command();
  await h.command("size 1");
  await h.command("size 0");
  expect(h.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("/digest size"), "error");
  expect(h.groups().map((g) => g.items.length)).toEqual([1, 1]);
  expect(h.ui.custom).toHaveBeenCalledTimes(1);
  h.emit("session_shutdown");
  await open;
  await h.command();
  expect(h.ui.custom).toHaveBeenCalledTimes(1);
});

it("detaches the old view on session replacement and ignores its late events", async () => {
  const h = host();
  const opened = h.command();
  const old = h.screen();
  const replacement = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager } };
  h.emit("session_start", {}, replacement);
  await opened;
  h.requestRender.mockClear();
  h.emit("agent_start", {}, h.ctx);
  h.emit("session_shutdown", {}, h.ctx);
  old.handleInput();
  expect(old.render()).toEqual([]);
  expect(h.requestRender).not.toHaveBeenCalled();
  await h.command();
  expect(h.ui.custom).toHaveBeenCalledTimes(1);
});

it.each(["print", "json", "rpc", "tui without UI"])("stays silent in %s", async (mode) => {
  const h = mode === "tui without UI" ? host("tui", false) : host(mode);
  h.emit("agent_start");
  h.emit("message_start", { message: assistant("x") });
  await h.command();
  await h.command("thinking on");
  await h.command("invalid");
  expect(h.getBranch).not.toHaveBeenCalled();
  expect(h.ui.custom).not.toHaveBeenCalled();
  expect(h.ui.notify).not.toHaveBeenCalled();
});
