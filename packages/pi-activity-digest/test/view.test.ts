import { KeybindingsManager, type TUI, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { Group } from "../src/model.js";
import { createView } from "../src/view.js";

function group(headline: string, ...descriptions: string[]): Group {
  return { headline, pending: false, items: descriptions.map((description) => ({ description, status: "done" })) };
}

function setup(groups: Group[], rows = 6) {
  const terminal = { rows };
  const requestRender = vi.fn();
  const done = vi.fn();
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.up": "k",
    "tui.select.down": "j",
    "tui.select.confirm": "x",
    "tui.select.cancel": "q",
    "tui.select.pageDown": "n",
  });
  const tui = { terminal, requestRender } as unknown as TUI;
  const view = createView(() => groups, tui, done, keys);
  return { view, terminal, done, requestRender, screen: () => view.render(120).join("\n") };
}

describe("activity digest", () => {
  it("opens at the latest group, follows appends until browsing, and reads live changes", () => {
    const groups: Group[] = [];
    const { screen, view } = setup(groups, 3);
    expect(screen()).toContain("No activity");
    groups.push(group("first"), group("second", "Read file"));
    groups[1].pending = true;
    groups[1].items[0].status = "running";
    groups[1].headline = "second · 1 running";
    expect(screen()).toContain("1 item · pending  second · 1 running");
    expect(screen()).not.toContain("Read file");
    groups[1].items[0].status = "failed";
    groups[1].headline = "second · 1 failed";
    expect(screen()).toContain("1 failed");
    groups.push(group("third"));
    expect(screen()).toContain("third");
    view.handleInput("k");
    groups.push(group("fourth"));
    expect(screen()).toContain("second");
    groups.length = 0;
    expect(screen()).toContain("No activity");
  });

  it("scrolls through an expanded group in order and collapses from a child", () => {
    const { view, screen } = setup([group("older"), group("batch", "one", "two", "three", "four")], 4);
    view.handleInput("x");
    expect(screen()).toContain("batch\n    [done] one");
    view.handleInput("n");
    expect(screen()).toContain("[done] one\n>   [done] two");
    view.handleInput("n");
    expect(screen()).toContain("[done] three\n>   [done] four");
    view.handleInput("x");
    expect(screen()).toContain("> ▸ 4 items  batch");
    expect(screen()).not.toContain("[done]");
  });

  it("uses effective bindings for actions and hints and completes only once", () => {
    const { view, screen, requestRender, done } = setup([group("tools", "detail")]);
    expect(screen()).toContain("x toggle");
    expect(screen()).toContain("q close");
    for (const input of ["\r", "\x1b", "\x1b[200~xq\x1b[201~"]) view.handleInput(input);
    expect(requestRender).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    view.handleInput("x");
    expect(requestRender).toHaveBeenCalledOnce();
    expect(screen()).toContain("detail");
    view.handleInput("q");
    view.handleInput("q");
    expect(done).toHaveBeenCalledOnce();
  });

  it("sanitizes both levels and fits tiny resized viewports in terminal columns", () => {
    const { view, screen, terminal } = setup([group("界\x1b]0;hidden\x07plan", "📚\n\u202efile\x1b[2J")]);
    view.handleInput("x");
    expect(screen()).toContain("界plan");
    expect(screen()).toContain("📚 file");
    for (const unsafe of ["hidden", "\u202e", "\x1b[2J"]) expect(screen()).not.toContain(unsafe);
    for (const rows of [1, 2, 3, 5]) {
      terminal.rows = rows;
      for (const width of [0, 1, 4, 9, 17]) {
        const lines = view.render(width);
        expect(lines.length).toBeLessThanOrEqual(rows);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    }
  });
});
