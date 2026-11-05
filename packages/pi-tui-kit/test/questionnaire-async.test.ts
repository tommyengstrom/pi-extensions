import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorComponent, StdinBuffer } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { runQuestionnaire } from "../src/questionnaire.js";
import { createTuiHarness } from "../src/testing/index.js";

const questions = [
  { id: "first", header: "First", prompt: "First question?", options: [{ label: "Small" }] },
  { id: "second", header: "Second", prompt: "Second question?", options: [{ label: "Small" }] },
] as const;

async function deferredRun() {
  const tui = createTuiHarness();
  const ctx = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom }).ctx as ExtensionContext;
  const editors: Array<EditorComponent & { disposed: number }> = [];
  const pending: Array<() => void> = [];
  ctx.ui.getEditorComponent = () => () => {
    let text = "";
    const editor: EditorComponent & { disposed: number; dispose(): void } = {
      disposed: 0,
      getText: () => text,
      setText(value) {
        text = value;
      },
      render: () => [`editor:${text}`],
      invalidate() {},
      handleInput(data) {
        if (data === "!") {
          const callback = this.onSubmit;
          const value = text;
          pending.push(() => callback?.(value));
        } else if (data === "?") {
          const value = text;
          pending.push(() => this.onSubmit?.(value));
        } else {
          text += data;
          this.onChange?.(text);
        }
      },
      dispose() {
        this.disposed++;
      },
    };
    editors.push(editor);
    return editor;
  };
  const running = runQuestionnaire(ctx, { questions, allowNotes: true });
  await tui.waitForOpen();
  const open = (field: "answer" | "note") => {
    if (field === "answer") {
      tui.press("tui.select.down");
      tui.press("tui.select.confirm");
    } else tui.type("n");
  };
  return { tui, running, editors, pending, open };
}

for (const field of ["answer", "note"] as const) {
  test(`deferred ${field} submission requests a new frame without further input`, async () => {
    const run = await deferredRun();
    run.open(field);
    run.tui.type("saved");
    run.tui.send("!");
    const before = run.tui.requestRenderCount;
    assert.match(run.tui.render().join("\n"), /editor:saved/u);
    run.pending.shift()?.();
    assert.ok(run.tui.requestRenderCount > before);
    const frame = run.tui.render().join("\n");
    assert.doesNotMatch(frame, /editor:/u);
    assert.match(frame, field === "answer" ? /Second question/u : /Note saved/u);
    run.tui.press("ctrl+c");
    await run.running;
    assert.equal(run.editors[0]?.disposed, 1);
  });
}

for (const first of ["answer", "note"] as const) {
  for (const next of ["answer", "note"] as const) {
    for (const mode of ["captured", "late lookup"] as const) {
      test(`obsolete ${first} callbacks cannot mutate a later ${next} (${mode})`, async () => {
        const run = await deferredRun();
        run.open(first);
        run.tui.type("old");
        run.tui.send(mode === "captured" ? "!" : "?");
        run.tui.send(mode === "captured" ? "!" : "?");
        const lateChange = run.editors[0]?.onChange;
        run.pending.shift()?.();
        // Move to the other question after a note; answer submission already advances there.
        if (first === "note") run.tui.send("\u001b[C");
        run.open(next);
        run.tui.type("current");
        const frame = run.tui.render();
        const renders = run.tui.requestRenderCount;
        run.pending.shift()?.();
        lateChange?.("obsolete change");
        assert.deepEqual(run.tui.render(), frame);
        assert.equal(run.tui.requestRenderCount, renders);
        assert.equal(run.editors.length, 2);
        assert.equal(run.editors[1]?.getText(), "current");
        assert.equal(run.editors[0]?.disposed, 1);
        run.tui.send("!");
        run.pending.shift()?.();
        if (next === "note") run.tui.press("tui.select.confirm");
        run.tui.press("tui.select.confirm");
        const result = await run.running;
        assert.equal(result.kind, "submitted");
        if (result.kind === "submitted") {
          assert.equal(result.answers[0]?.answer, first === "answer" ? "old" : "Small");
          assert.equal(result.answers[1]?.answer, next === "answer" ? "current" : "Small");
          assert.equal(result.answers[1]?.note, next === "note" ? "current" : undefined);
        }
        assert.ok(run.editors.every((editor) => editor.disposed === 1));
      });
    }
  }
}

for (const custom of [false, true]) {
  for (const boundary of ["prefix", "payload", "suffix", "fragmented payload", "between pastes"] as const) {
    test(`Pi terminal framing preserves Ctrl+C at ${boundary} (${custom ? "custom" : "default"})`, async () => {
      const tui = createTuiHarness();
      const ctx = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom }).ctx as ExtensionContext;
      ctx.ui.getEditorComponent = () => (custom ? (host, theme) => new Editor(host, theme) : undefined);
      const running = runQuestionnaire(ctx, { questions: [questions[0]] });
      await tui.waitForOpen();
      tui.press("tui.select.down");
      tui.press("tui.select.confirm");
      const buffer = new StdinBuffer();
      const events: string[] = [];
      buffer.on("data", (data) => {
        events.push(data);
        tui.send(data);
      });
      buffer.on("paste", (text) => {
        const data = `\u001b[200~${text}\u001b[201~`;
        events.push(data);
        tui.send(data);
      });
      const start = "\u001b[200~";
      const end = "\u001b[201~";
      if (boundary === "prefix") buffer.process(`\u0003${start}text${end}`);
      else if (boundary === "suffix") buffer.process(`${start}text${end}\u0003`);
      else if (boundary === "between pastes") buffer.process(`${start}one${end}\u0003${start}two${end}`);
      else if (boundary === "payload") buffer.process(`${start}a\u0003b${end}`);
      else {
        for (const chunk of ["\u001b[2", "00~a", "\u0003", "b\u001b[20", "1~"]) buffer.process(chunk);
      }
      buffer.clear();
      if (boundary === "payload" || boundary === "fragmented payload") {
        assert.deepEqual(events, [`${start}a\u0003b${end}`]);
        assert.equal(tui.isOpen, true);
        tui.press("tui.input.submit");
        const result = await running;
        assert.equal(result.kind, "submitted");
        if (result.kind === "submitted") assert.equal(result.answers[0]?.answer, "a\u0003b");
      } else {
        assert.ok(events.includes("\u0003"), "outside-paste Ctrl+C is a standalone component event");
        assert.deepEqual(await running, { kind: "closed", reason: "close" });
      }
    });
  }
}
