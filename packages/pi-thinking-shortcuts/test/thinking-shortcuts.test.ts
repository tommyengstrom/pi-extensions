import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import thinkingShortcuts from "../src/index.js";

const model: Model<Api> = {
  id: "offline",
  name: "Offline reasoning model",
  api: "openai-responses",
  provider: "offline",
  baseUrl: "https://offline.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

type Shortcut = Parameters<ExtensionAPI["registerShortcut"]>[1];

function fixture(initial: ModelThinkingLevel = "medium", selected: Model<Api> | undefined = model) {
  let level = initial;
  const shortcuts = new Map<string, Shortcut>();
  const notify = vi.fn();
  const ctx = { mode: "tui", model: selected, ui: { notify } } as unknown as ExtensionContext;
  const setThinkingLevel = vi.fn((next: ModelThinkingLevel) => {
    level = ctx.model ? clampThinkingLevel(ctx.model, next) : "off";
  });
  const api = {
    registerShortcut: (key: string, shortcut: Shortcut) => shortcuts.set(key, shortcut),
    getThinkingLevel: () => level,
    setThinkingLevel,
  } as unknown as ExtensionAPI;
  thinkingShortcuts(api);
  return {
    shortcuts,
    ctx,
    notify,
    setThinkingLevel,
    get level() {
      return level;
    },
    set level(next: ModelThinkingLevel) {
      level = next;
    },
    async press(key: "alt+," | "alt+.") {
      const shortcut = shortcuts.get(key);
      expect(shortcut).toBeDefined();
      await shortcut?.handler(ctx);
    },
  };
}

describe("thinking shortcuts", () => {
  it("registers only the two native shortcuts without changing initial state", () => {
    const f = fixture();
    expect([...f.shortcuts.keys()]).toEqual(["alt+,", "alt+."]);
    expect(f.shortcuts.get("alt+,")?.description).toBe("Decrease thinking effort");
    expect(f.shortcuts.get("alt+.")?.description).toBe("Increase thinking effort");
    expect(f.setThinkingLevel).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("steps in both directions and reports the resulting level", async () => {
    const f = fixture();
    await f.press("alt+.");
    expect(f.level).toBe("high");
    expect(f.notify).toHaveBeenLastCalledWith("Thinking: high", "info");
    await f.press("alt+,");
    expect(f.level).toBe("medium");
    await f.press("alt+,");
    expect(f.level).toBe("low");
  });

  it.each([
    ["off", "alt+,", "lowest"],
    ["high", "alt+.", "highest"],
  ] as const)("does not wrap at %s", async (level, key, bound) => {
    const f = fixture(level);
    await f.press(key);
    expect(f.level).toBe(level);
    expect(f.setThinkingLevel).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenCalledWith(`Thinking is already at the ${bound} level (${level}).`, "info");
  });

  it("can disable and re-enable thinking when off is supported", async () => {
    const f = fixture("minimal");
    await f.press("alt+,");
    expect(f.level).toBe("off");
    await f.press("alt+.");
    expect(f.level).toBe("minimal");
  });

  it("skips unsupported levels and allows explicitly supported xhigh and max", async () => {
    const f = fixture("low", {
      ...model,
      thinkingLevelMap: { off: null, minimal: null, medium: null, xhigh: "xhigh", max: "max" },
    });
    await f.press("alt+,");
    expect(f.setThinkingLevel).not.toHaveBeenCalled();
    for (const expected of ["high", "xhigh", "max"]) {
      await f.press("alt+.");
      expect(f.level).toBe(expected);
    }
    await f.press("alt+.");
    expect(f.setThinkingLevel).toHaveBeenCalledTimes(3);
    await f.press("alt+,");
    expect(f.level).toBe("xhigh");
  });

  it("reads the current level and model on each press", async () => {
    const f = fixture();
    await f.press("alt+.");
    f.level = "low"; // Another Pi control changed the level.
    await f.press("alt+.");
    expect(f.level).toBe("medium");
    f.ctx.model = { ...model, thinkingLevelMap: { high: null, xhigh: "xhigh" } };
    await f.press("alt+.");
    expect(f.level).toBe("xhigh");
  });

  it("uses Pi's clamping policy for a no-longer-supported current level", async () => {
    const f = fixture("minimal", { ...model, thinkingLevelMap: { minimal: null } });
    await f.press("alt+.");
    expect(f.level).toBe("medium");
  });

  it("leaves non-reasoning models unchanged", async () => {
    const f = fixture("off", { ...model, reasoning: false });
    await f.press("alt+.");
    await f.press("alt+,");
    expect(f.setThinkingLevel).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenLastCalledWith("This model does not support thinking.", "info");
  });

  it("handles a missing model", async () => {
    const f = fixture();
    f.ctx.model = undefined;
    await f.press("alt+.");
    expect(f.setThinkingLevel).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenCalledWith("Thinking shortcuts are unavailable until a model is selected.", "info");
  });

  it("leaves a single supported level unchanged in both directions", async () => {
    const f = fixture("high", {
      ...model,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null },
    });
    await f.press("alt+,");
    await f.press("alt+.");
    expect(f.setThinkingLevel).not.toHaveBeenCalled();
  });

  it.each(["print", "json", "rpc"] as const)("does nothing in %s mode", async (mode) => {
    const f = fixture();
    f.ctx.mode = mode;
    await f.press("alt+,");
    await f.press("alt+.");
    expect(f.setThinkingLevel).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  });
});
