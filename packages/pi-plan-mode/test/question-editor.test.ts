import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorComponent } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { askPlanModeQuestions } from "../src/question-tool.js";
import { createMockContext } from "./support.js";

test("Plan questions honor the public custom editor factory without changing the main editor", async () => {
  const tui = createTuiHarness();
  const ctx = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom }).ctx as ExtensionContext;
  let editor: EditorComponent | undefined;
  ctx.ui.getEditorComponent = () => (host, theme) => {
    editor = new Editor(host, theme);
    const handleInput = editor.handleInput.bind(editor);
    editor.handleInput = (data) => {
      if (data === "\u001b") return;
      handleInput(data);
    };
    return editor;
  };
  ctx.ui.setEditorText = () => assert.fail("must not change main editor text");
  ctx.ui.setEditorComponent = () => assert.fail("must not replace main editor");
  const running = askPlanModeQuestions(
    [{ id: "scope", header: "Scope", question: "How broad?", options: [{ label: "Small" }, { label: "Broad" }] }],
    ctx,
  );
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  assert.ok(editor);
  tui.type("  answer  ");
  tui.send("\u001b");
  assert.equal(tui.isOpen, true);
  tui.press("tui.input.submit");
  assert.equal(tui.isOpen, false);
  assert.deepEqual(await running, [
    { id: "scope", header: "Scope", question: "How broad?", answer: "answer", wasCustom: true },
  ]);
});
