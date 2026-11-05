import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type KeyId, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { runMultiSelect } from "../src/multi-select.js";
import { createRpcHarness, createTuiHarness } from "../src/testing/index.js";

function tuiContext(tui: ReturnType<typeof createTuiHarness>) {
  return createMockContext({ mode: "tui", hasUI: true, custom: tui.custom }).ctx;
}

const items = [
  { id: "read", label: "Read", searchText: "filesystem inspect", selected: true },
  { id: "write", label: "Write", searchText: "mutation" },
  { id: "blocked", label: "Blocked", disabled: true, disabledReason: "Policy" },
] as const;

test("runMultiSelect completes with interaction-local selections and leaves disabled items inert", async () => {
  const tui = createTuiHarness();
  const running = runMultiSelect(tuiContext(tui), { title: "Tools", items });
  await tui.waitForOpen();
  assert.match(stripVTControlCharacters(tui.render().join("\n")), /› \[x\] Read/u);
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  assert.deepEqual(await running, { kind: "completed", selectedItemIds: ["read", "write"] });
  assert.equal("selected" in items[1], false);
});

test("runMultiSelect supports fuzzy search, custom keybindings, focus, and exact widths", async () => {
  const bindings: Record<string, string> = {
    "tui.select.up": "k",
    "tui.select.down": "j",
    "tui.select.pageUp": "u",
    "tui.select.pageDown": "d",
    "tui.select.confirm": "l",
    "tui.select.cancel": "q",
  };
  const tui = createTuiHarness({
    keybindings: {
      matches: (data, binding) => data === bindings[binding],
      getKeys: (binding) => (bindings[binding] ? [bindings[binding] as KeyId] : []),
    },
  });
  const running = runMultiSelect(tuiContext(tui), {
    title: "Tools",
    items,
    enableSearch: true,
    completionLabel: "Apply",
  });
  await tui.waitForOpen();
  assert.equal(tui.isFocusable, true);
  tui.setFocused(true);
  tui.type("mut");
  const rendered = stripVTControlCharacters(tui.render(40).join("\n"));
  assert.match(rendered, /Write/u);
  assert.doesNotMatch(rendered, /\[x\] Read/u);
  tui.send("l");
  await tui.waitForPending();
  for (const width of [1, 2, 8, 40, 80]) {
    assert.ok(
      tui.render(width).every((line) => visibleWidth(line) <= width),
      `width ${width}`,
    );
  }
  tui.send("j");
  tui.send("l");
  assert.deepEqual(await running, { kind: "completed", selectedItemIds: ["read", "write"] });
});

test("runMultiSelect routes mouse toggles and completion using rendered geometry", async () => {
  const tui = createTuiHarness({ width: 60 });
  const running = runMultiSelect(tuiContext(tui), { title: "Tools", items, completionLabel: "Save" });
  await tui.waitForOpen();
  let frame = tui.render();
  const writeRow = frame.findIndex((line) => stripVTControlCharacters(line).includes("Write"));
  assert.ok(writeRow >= 0);
  tui.mouse({ type: "press", x: 3, y: writeRow });
  tui.mouse({ type: "click", x: 3, y: writeRow });
  await tui.waitForPending();
  frame = tui.render();
  const saveRow = frame.findIndex((line) => stripVTControlCharacters(line).includes("Save"));
  assert.ok(saveRow >= 0);
  tui.mouse({ type: "press", x: 3, y: saveRow });
  tui.mouse({ type: "click", x: 3, y: saveRow });
  assert.deepEqual(await running, { kind: "completed", selectedItemIds: ["read", "write"] });
});

test("runMultiSelect preserves Back and Close and classifies disposal or owner abort as stale", async () => {
  for (const [key, reason] of [
    ["tui.select.cancel", "back"],
    ["ctrl+c", "close"],
  ] as const) {
    const tui = createTuiHarness();
    const running = runMultiSelect(tuiContext(tui), { title: "Tools", items });
    await tui.waitForOpen();
    tui.press(key);
    assert.deepEqual(await running, { kind: "cancelled", reason });
  }

  const disposedTui = createTuiHarness();
  const disposed = runMultiSelect(tuiContext(disposedTui), { title: "Tools", items });
  await disposedTui.waitForOpen();
  disposedTui.dispose();
  assert.deepEqual(await disposed, { kind: "stale" });

  const abortTui = createTuiHarness();
  const controller = new AbortController();
  const aborted = runMultiSelect(tuiContext(abortTui), { title: "Tools", items, signal: controller.signal });
  await abortTui.waitForOpen();
  controller.abort();
  assert.deepEqual(await aborted, { kind: "stale" });
});

test("runMultiSelect adapts deterministic toggles, disabled rows, and completion to RPC", async () => {
  const initialOptions = ["[x] Read", "[ ] Write", "[-] Blocked — unavailable: Policy", "Apply"];
  const updatedOptions = ["[x] Read", "[x] Write", "[-] Blocked — unavailable: Policy", "Apply"];
  const rpc = createRpcHarness([
    { kind: "select", options: initialOptions, response: initialOptions[2] },
    { kind: "select", options: initialOptions, response: initialOptions[1] },
    { kind: "select", options: updatedOptions, response: "Apply" },
  ]);
  const ctx = createMockContext({ mode: "rpc", hasUI: true, select: rpc.ui.select }).ctx;
  const result = await runMultiSelect(ctx, {
    title: "Tools",
    items,
    enableSearch: true,
    completionLabel: "Apply",
  });
  assert.deepEqual(result, { kind: "completed", selectedItemIds: ["read", "write"] });
  rpc.assertConsumed();
});

test("runMultiSelect returns typed RPC cancellation, unsupported, validation, and stale results", async () => {
  const rpc = createRpcHarness([{ kind: "select", response: undefined }]);
  const rpcCtx = createMockContext({ mode: "rpc", hasUI: true, select: rpc.ui.select }).ctx;
  assert.deepEqual(await runMultiSelect(rpcCtx, { title: "Tools", items, hint: "close" }), {
    kind: "cancelled",
    reason: "close",
  });

  const jsonCtx = createMockContext({ mode: "json", hasUI: false }).ctx;
  assert.deepEqual(await runMultiSelect(jsonCtx, { title: "Tools", items }), {
    kind: "unsupported",
    mode: "json",
  });
  for (const invalidOptions of [
    { title: "\u0001", items },
    { title: "Tools", items: [{ id: "hidden", label: "\u0001" }] },
    {
      title: "Tools",
      items: [
        { id: "duplicate", label: "One" },
        { id: "duplicate", label: "Two" },
      ],
    },
  ]) {
    const invalid = await runMultiSelect(jsonCtx, invalidOptions);
    assert.equal(invalid.kind, "error");
  }

  let current = true;
  const staleCtx = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => {
      current = false;
      return "Done";
    },
  }).ctx;
  assert.deepEqual(await runMultiSelect(staleCtx, { title: "Tools", items, isCurrent: () => current }), {
    kind: "stale",
  });
});
