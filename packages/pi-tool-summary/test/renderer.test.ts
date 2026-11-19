import { stripVTControlCharacters } from "node:util";
import {
  createBashToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  initTheme,
  ToolExecutionComponent,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  getKeybindings,
  Image,
  setCapabilities,
  Text,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";
import { createRenderer, type RendererSession } from "../src/ui/renderer.js";

beforeAll(() => {
  initTheme("dark", false);
});

function fixture(name = "custom", downstream?: ToolRenderers) {
  const labels = new Map<string, string>();
  const watchers = new Map<string, () => void>();
  const session: RendererSession = {
    native: false,
    label: (id) => labels.get(id),
    watch: (id, invalidate) => {
      watchers.set(id, invalidate);
    },
  };
  const renderer = createRenderer(() => session)(name, () => downstream);
  const mount = (id: string, args: unknown) =>
    new ToolExecutionComponent(name, id, args, {}, renderer, { requestRender() {} } as TUI, process.cwd());
  return { labels, watchers, session, mount };
}

const output = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError });
const view = (row: ToolExecutionComponent, width = 80) => stripVTControlCharacters(row.render(width).join("\n"));
function click(row: ToolExecutionComponent, header: string) {
  const lines = row.render(80);
  const y = lines.findIndex((line) => stripVTControlCharacters(line).includes(header));
  expect(y).toBeGreaterThanOrEqual(0);
  expect(
    row.handleMouse({
      type: "click",
      button: "left",
      x: 2,
      y,
      screenX: 2,
      screenY: y,
      width: 80,
      height: lines.length,
      alt: false,
      ctrl: false,
      shift: false,
    }),
  ).toMatchObject({ handled: true });
}

test("completed clicks inspect one call; a label update doesn't collapse it", () => {
  const { labels, watchers, mount } = fixture();
  labels.set("a", "Inspect settings");
  const a = mount("a", { path: "config", unknown: { value: `${"Q".repeat(1200)}\nEND\u009b\u202e` } });
  const b = mount("b", { path: "other" });
  a.updateResult(output("first result"));
  b.updateResult(output("second result"));
  expect(a.render(80).join("\n")).toContain("\x1b[1mcustom\x1b[22m");
  expect(view(a)).toMatch(/▸ custom \[\d+\] Inspect settings/u);
  click(a, "Inspect settings");
  labels.set("a", "New label");
  watchers.get("a")?.();
  const opened = view(a, 24);
  expect(opened.match(/Q/g)).toHaveLength(1200);
  expect(opened).toContain('"unknown"');
  expect(opened.replace(/\s/g, "")).toContain("\\nEND\\u009b\\u202e");
  expect(opened).toContain("first result");
  expect(view(b)).not.toContain("second result");
  click(a, "custom");
  expect(view(a)).toContain("New label");
  expect(view(a)).not.toContain("first result");
});

test("pending header yields to Pi as soon as a partial result exists", () => {
  const { mount } = fixture();
  const row = mount("p", { path: "partial" });
  click(row, "[pending]");
  expect(view(row)).toContain("incomplete");
  row.updateArgs({ path: "final", nested: true });
  row.setArgsComplete();
  row.markExecutionStarted();
  expect(view(row)).not.toContain("incomplete");
  expect(view(row)).toContain('"nested"');
  row.updateResult(output("progress"), true);
  expect(view(row)).not.toContain('"nested"');
  click(row, "[pending]");
  expect(view(row)).toContain("progress");
  row.updateResult(output("failure body", true));
  click(row, "custom");
  expect(view(row)).toContain("[failed]");
  expect(view(row)).not.toContain("failure body");
  expect(row.render(12).every((line) => visibleWidth(line) <= 12)).toBe(true);
});

test("disclosure count matches expanded bash lines at each width, including its timer", () => {
  const { mount } = fixture("bash", createBashToolDefinition(process.cwd()) as ToolRenderers);
  const row = mount("b", { command: "rg -n 'export.*HTML' src/index.ts; git diff --stat", timeout: 3 });
  expect(view(row)).toContain("▸ bash […]");
  row.updateResult({ ...output(`match\n${"result ".repeat(20)}`), durationMs: 50 });
  const widths = [80, 31];
  const counts = widths.map((width) => Number(view(row, width).match(/▸ bash \[(\d+)\]/u)?.[1]));
  expect(counts[1]).toBeGreaterThan(counts[0]);
  row.setExpanded(true);
  widths.forEach((width, i) => {
    const lines = view(row, width).trim().split("\n");
    expect(lines.at(-1)).toContain("Took");
    expect(counts[i]).toBe(lines.length);
  });
});

test("a write summary opens Pi's full multiline source view, including while pending", () => {
  const { mount } = fixture("write", createWriteToolDefinition(process.cwd()) as ToolRenderers);
  const source = Array.from({ length: 16 }, (_, i) => `const line${i} = "hello";`).join("\n");
  const row = mount("w", { path: "example.ts", content: source });
  click(row, "[pending]");
  expect(view(row)).toContain("incomplete");
  expect(view(row)).toContain('const line15 = "hello";');
  row.updateResult(output("Written"));
  expect(view(row)).not.toContain("line15");
  click(row, "▸ write");
  const expanded = view(row);
  expect(expanded.split("\n").map((line) => line.trim())).toEqual(expect.arrayContaining(source.split("\n")));
  expect(expanded).not.toContain('"content":');
  click(row, "example.ts");
  expect(view(row)).toContain("▸ write");
});

test("stock read renderer follows native style and host global expansion", () => {
  const { mount, session, watchers } = fixture("read", createReadToolDefinition(process.cwd()) as ToolRenderers);
  const row = mount("r", { path: "sample.txt", offset: 3, limit: 2 });
  row.updateResult(output("sample output"));
  for (const native of [true, false]) {
    session.native = native;
    watchers.get("r")?.();
    const compact = view(row);
    expect(compact.includes("3-4")).toBe(native);
    row.setExpanded(true);
    expect(view(row)).toContain("sample.txt:3-4");
    expect(view(row)).not.toContain('"offset":');
    expect(view(row)).toContain("sample output");
    row.setExpanded(false);
    expect(view(row)).toBe(compact);
  }
});

test("custom renderer gets shared private state and only its own last components", () => {
  const slots: string[] = [];
  const { mount, watchers, session } = fixture("custom", {
    renderShell: "self",
    renderCall(_args, _theme, ctx) {
      slots.push(ctx.lastComponent === ctx.state.call ? "call" : "wrong call");
      ctx.state.call ??= new Text("native call", 0, 0);
      return ctx.state.call;
    },
    renderResult(_result, _options, _theme, ctx) {
      slots.push(ctx.state.call && ctx.lastComponent === ctx.state.result ? "result" : "wrong result");
      ctx.state.result ??= new Text("native result", 0, 0);
      return ctx.state.result;
    },
  });
  const row = mount("id", { arg: 1 });
  row.updateResult(output("raw"));
  for (const native of [true, false, true]) {
    session.native = native;
    watchers.get("id")?.();
    expect(view(row).includes("native result")).toBe(native);
  }
  row.setExpanded(true);
  expect(view(row)).not.toContain('"arg": 1');
  expect(view(row)).toContain("native call");
  expect(view(row)).toContain("native result");
  expect(slots).toContain("result");
  expect(slots).not.toContain("wrong call");
  expect(slots).not.toContain("wrong result");
});

test("generic native fallback uses host's configured expand hint", () => {
  const keys = vi.spyOn(getKeybindings(), "getKeys").mockReturnValue(["ctrl+j"]);
  try {
    const { mount, session } = fixture();
    session.native = true;
    const row = mount("id", {});
    row.updateResult(output(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n")));
    expect(view(row)).toContain("ctrl+j to expand");
    expect(keys).toHaveBeenCalledWith("app.tools.expand");
    expect(view(row)).not.toContain("line 11");
    row.setExpanded(true);
    expect(view(row)).toContain("line 11");
  } finally {
    keys.mockRestore();
  }
});

test("host-managed images survive a hidden compact result slot", () => {
  const original = getCapabilities();
  try {
    setCapabilities({ ...original, images: "kitty" });
    const row = fixture().mount("image", {});
    row.updateResult({
      content: [
        {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cX1kAAAAASUVORK5CYII=",
        },
      ],
      isError: false,
    });
    expect(row.children.some((child) => child instanceof Image)).toBe(true);
    row.setShowImages(false);
    expect(row.children.some((child) => child instanceof Image)).toBe(false);
    row.setExpanded(true);
    expect(view(row)).toContain("[Image: image/png]");
  } finally {
    setCapabilities(original);
  }
});

test("a hidden downstream result still receives its final update for cleanup", () => {
  const partial: boolean[] = [];
  const { mount, watchers, session } = fixture("custom", {
    renderResult(_result, options) {
      partial.push(options.isPartial);
      return new Text("native body", 0, 0);
    },
  });
  session.native = true;
  const row = mount("id", {});
  row.updateResult(output("progress"), true);
  session.native = false;
  watchers.get("id")?.();
  row.updateResult(output("finished"));
  expect(partial).toEqual([true, false]);
  expect(view(row)).not.toContain("native body");
});

test("no interactive session leaves resolver chain untouched", () => {
  const renderer: ToolRenderers = {};
  expect(createRenderer(() => undefined)("read", () => renderer)).toBe(renderer);
  expect(createRenderer(() => undefined)("unknown", () => undefined)).toBeUndefined();
});
