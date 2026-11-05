import assert from "node:assert/strict";
import { getKeybindings, Input, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { restoreSearchInput } from "../src/components/rendering.js";
import { defineMenu, runMenu } from "../src/index.js";

for (const screenKind of ["settings", "choice"] as const) {
  for (const action of [
    "tui.select.cancel",
    "tui.editor.undo",
    "tui.input.submit",
    "tui.editor.deleteCharBackward",
    "tui.editor.cursorLeft",
    "tui.editor.yank",
  ] as const) {
    test(`${screenKind} restores pasted search without dispatching ${action}`, async () => {
      const previous = getKeybindings();
      setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { [action]: "s" }));
      const frames: string[] = [];
      let calls = 0;
      let saved = "Off";
      const context = createMockContext({
        mode: "tui",
        custom: async (factory: unknown) => {
          calls++;
          const harness = createCustomSelectorHarness(factory, 80);
          try {
            if (calls === 1) {
              harness.handleInput("\u001b[200~s\u001b[201~");
              frames.push(harness.render().join("\n"));
              harness.handleInput("tui.select.confirm");
            } else {
              frames.push(harness.render().join("\n"));
              // Paste appends at the restored cursor, rather than prepending to it.
              harness.handleInput("\u001b[200~t\u001b[201~");
              frames.push(harness.render().join("\n"));
              harness.handleInput("\u0003");
            }
            await harness.waitForPending();
            return harness.result;
          } finally {
            harness.dispose();
          }
        },
      });
      const menu = defineMenu<undefined, "main", "save">({
        start: "main",
        screens: {
          main: () =>
            screenKind === "settings"
              ? {
                  kind: "settings",
                  title: "Search restoration",
                  items: [
                    { id: "match", label: "st", currentValue: saved, values: ["Off", "On"], action: "save" },
                    { id: "other", label: "Other", currentValue: "Off", values: ["Off", "On"], action: "save" },
                  ],
                }
              : {
                  kind: "choice",
                  title: "Search restoration",
                  enableSearch: true,
                  action: "save",
                  items: [
                    { id: "match", label: "st" },
                    { id: "other", label: "Other" },
                  ],
                },
        },
        actions: {
          save: async () => {
            saved = "On";
            return { kind: "stay" };
          },
        },
      });
      try {
        assert.deepEqual(await runMenu(context.ctx, menu, { getState: () => undefined }), {
          kind: "closed",
          reason: "close",
        });
        assert.equal(calls, 2);
        assert.equal(saved, "On");
        assert.equal(frames.length, 3);
        for (const frame of frames) {
          assert.match(frame, /→ st/u);
          assert.doesNotMatch(frame, /Other|No matches/u);
        }
        if (screenKind === "settings") assert.match(frames[1] ?? "", /st.*On/u);
      } finally {
        setKeybindings(previous);
      }
    });
  }
}

test("restored search sanitizes terminal controls before framing a paste", () => {
  const input = new Input();
  let submitted = false;
  input.onSubmit = () => {
    submitted = true;
  };
  restoreSearchInput(input, "s\u001b[201~\r\u0003t");
  assert.equal(submitted, false);
  assert.equal(input.getValue(), "s [201~  t");
  input.handleInput("\u001b[200~z\u001b[201~");
  assert.equal(input.getValue(), "s [201~  tz");
});
