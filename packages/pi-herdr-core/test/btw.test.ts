import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { showChat } from "../src/btw.js";
import { continueInDesktop, desktopSpace, UnconfirmedTab } from "../src/btw-desktop.js";
import { sideConversation } from "../src/btw-session.js";

it("forks only projected conversation and completed side turns, without writing the parent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "btw-"));
  try {
    const parent = SessionManager.create(dir, dir);
    const user = (content: string) => parent.appendMessage({ role: "user", content, timestamp: 0 });
    const root = user("old secret");
    user("unselected sibling");
    parent.branch(root);
    const kept = user("kept message");
    parent.appendCompaction("summary", kept, 5);
    parent.appendContextEdit(kept, { content: "edited question" });
    parent.appendCustomEntry("plan-owner", { token: "private" });
    const file = parent.getSessionFile();
    if (!file) throw new Error("Expected persistent fixture");
    const bytes = await readFile(file);
    const stream = vi.fn(() => ({
      result: async () => ({
        role: "assistant",
        content: [{ type: "text", text: "side answer" }],
        stopReason: "stop",
        provider: "local",
        model: "test",
        timestamp: 1,
      }),
    }));
    const ctx = {
      cwd: dir,
      model: { provider: "local", id: "test" },
      modelRegistry: { streamSimple: stream },
      getSystemPrompt: () => "main",
      sessionManager: parent,
    } as unknown as ExtensionCommandContext;
    const chat = sideConversation(ctx, "low");
    expect(stream).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    await chat.ask("first", signal);
    await chat.ask("second", signal);
    expect(stream).toHaveBeenLastCalledWith(
      ctx.model,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: "first" }),
          expect.objectContaining({ content: "second" }),
        ]),
      }),
      { signal, reasoning: "low" },
    );
    expect(await readdir(dir)).toHaveLength(1);
    const fork = SessionManager.open(chat.save());
    expect(fork.getHeader()?.parentSession).toBe(file);
    expect(fork.getSessionId()).not.toBe(parent.getSessionId());
    const context = JSON.stringify(fork.buildSessionProjection().messages);
    for (const text of ["edited question", "summary", "first", "second", "side answer"])
      expect(context).toContain(text);
    for (const text of ["unselected sibling", "old secret", "kept message", "plan-owner"])
      expect(context).not.toContain(text);
    expect(await readFile(file)).toEqual(bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const spaces = {
  spaces: [
    { id: "foreign", machine: "ssh" },
    { id: "local", machine: null, tabs: [{ terminals: [{ terminal: "t1" }] }] },
  ],
};
it("requires an unambiguous, explicitly local desktop space", () => {
  expect(desktopSpace(spaces)).toBe("local");
  const several = { spaces: [...spaces.spaces, { id: "other", machine: null }] };
  expect(desktopSpace(several, "t1")).toBe("local");
  expect(() => desktopSpace(several)).toThrow(/several/);
  expect(() => desktopSpace({ spaces: [{ id: "unknown" }, spaces.spaces[0]] })).toThrow();
});
it("launches one focused tab with literal paths; never retries an unconfirmed mutation", async () => {
  const exec = vi
    .fn()
    .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(spaces) })
    .mockResolvedValueOnce({ code: 1, stdout: "" });
  const pi = { exec, getActiveTools: () => ["read"] } as unknown as ExtensionAPI;
  const check = vi.fn();
  const save = vi.fn(() => "/sessions/one ' $().jsonl");
  await expect(
    continueInDesktop(pi, "/work dir", new AbortController().signal, check, save, async () => "/pi cli"),
  ).rejects.toBeInstanceOf(UnconfirmedTab);
  expect(exec).toHaveBeenCalledTimes(2);
  const [command, args] = exec.mock.calls[1] ?? [];
  expect(command).toBe("herdr-app");
  expect(args.slice(0, 2)).toEqual(["do", "tab.new"]);
  expect(JSON.parse(args[2])).toMatchObject({
    space: "local",
    focus: true,
    folder: "/work dir",
    argv: [process.execPath, "/pi cli", "--tools", "read", "--session", "/sessions/one ' $().jsonl"],
  });
  expect(save).toHaveBeenCalledOnce();
});
it("does not persist or dispatch if ownership or permissions change during preflight", async () => {
  const exec = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify(spaces) });
  const check = vi
    .fn()
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw new Error("restricted");
    });
  const save = vi.fn();
  await expect(
    continueInDesktop({ exec } as unknown as ExtensionAPI, "/work", new AbortController().signal, check, save),
  ).rejects.toThrow("restricted");
  expect(save).not.toHaveBeenCalled();
  expect(exec).toHaveBeenCalledTimes(1);
});

function overlay(initial: string, ask: (text: string) => Promise<string>, promote = vi.fn(async () => {})) {
  let input!: (key: string) => void;
  let render!: (width: number) => string[];
  const controller = new AbortController();
  const tui = { terminal: { rows: 42 }, requestRender: vi.fn() };
  const ctx = {
    ui: {
      custom: (
        factory: (...args: unknown[]) => { handleInput: (s: string) => void; render: (w: number) => string[] },
      ) =>
        new Promise<void>((done) => {
          const component = factory(
            tui,
            { fg: (_: string, s: string) => s },
            { matches: (s: string, k: string) => s === "\x1b" && k === "tui.select.cancel", getKeys: () => [] },
            done,
          );
          input = component.handleInput;
          render = component.render;
        }),
    },
  } as unknown as ExtensionCommandContext;
  const closed = showChat(ctx, initial, controller, ask, promote);
  return { input, render, closed, controller, tui, promote };
}
it("bare /btw waits for input, accepts pasted follow-ups, and promotes without another model request", async () => {
  const ask = vi.fn(async () => "answer");
  const chat = overlay("", ask);
  await Promise.resolve();
  expect(ask).not.toHaveBeenCalled();
  chat.input("\x1b[200~hello");
  chat.input("\nthere\x1b[201~");
  chat.input("\r");
  await vi.waitFor(() => expect(chat.render(75).join("\n")).toContain("Pi: answer"));
  expect(ask.mock.calls).toEqual([["hello\nthere"]]);
  chat.input("/herdr");
  chat.input("\r");
  await chat.closed;
  expect(chat.promote).toHaveBeenCalledOnce();
  expect(ask).toHaveBeenCalledTimes(1);
});
it("closes and ignores a late answer after cancellation", async () => {
  const pending = Promise.withResolvers<string>();
  const ask = vi.fn(() => pending.promise);
  const chat = overlay("original question", ask);
  await Promise.resolve();
  expect(ask.mock.calls).toEqual([["original question"]]);
  chat.input("\x1b");
  await chat.closed;
  expect(chat.controller.signal.aborted).toBe(true);
  const count = chat.tui.requestRender.mock.calls.length;
  pending.resolve("late");
  await Promise.resolve();
  expect(chat.tui.requestRender).toHaveBeenCalledTimes(count);
});
