import assert from "node:assert/strict";
import { CustomEditor, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  type EditorComponent,
  getKeybindings,
  isKittyProtocolActive,
  type KeybindingsConfig,
  KeybindingsManager,
  type KeyId,
  matchesKey,
  setKeybindings,
  setKittyProtocolActive,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { runQuestionnaire } from "../src/questionnaire.js";
import { createTuiHarness } from "../src/testing/index.js";

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

const questions = [{ id: "scope", header: "Scope", prompt: "How broad?", options: [{ label: "Small" }] }];

// Follow Pi's modal-editor example: own modal keys and delegate other keys to CustomEditor.
class ModalEditor extends CustomEditor {
  mode: "insert" | "normal" = "insert";
  disposed = 0;
  wantsKeyRelease = true;
  readonly inputs: string[] = [];

  override handleInput(data: string): void {
    this.inputs.push(data);
    if (matchesKey(data, "escape")) {
      this.mode = "normal";
      return;
    }
    if (this.mode === "normal") {
      if (data === "i") this.mode = "insert";
      else if (data === "x") super.handleInput("\u007f");
      return;
    }
    super.handleInput(data);
  }

  dispose(): void {
    this.disposed++;
  }
}

function run(
  bindings: KeybindingsConfig = {},
  extra: { maxTextLength?: number; signal?: AbortSignal; isCurrent?(): boolean } = {},
) {
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
  const tui = createTuiHarness({ keybindings });
  const ctx = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom }).ctx as ExtensionContext;
  const editors: ModalEditor[] = [];
  const components: Component[] = [];
  ctx.ui.custom = (create, options) =>
    tui.custom(async (...args) => {
      const component = await create(...args);
      components.push(component);
      return component;
    }, options);
  const factory: EditorFactory = (host, theme, keys) => {
    const editor = new ModalEditor(host, theme, keys);
    editors.push(editor);
    return editor;
  };
  let configured: EditorFactory | undefined;
  ctx.ui.setEditorComponent = (next) => {
    configured = next;
  };
  ctx.ui.getEditorComponent = () => configured;
  ctx.ui.setEditorComponent(factory);
  const running = runQuestionnaire(ctx, { questions, allowNotes: true, ...extra });
  return { ctx, tui, editors, components, running, keybindings, factory };
}

function openAnswer(tui: ReturnType<typeof createTuiHarness>): void {
  tui.setFocused(true);
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
}

for (const [name, bindings] of [
  ["default", {}],
  [
    "remapped cancel and submit",
    { "tui.select.cancel": "ctrl+x", "tui.input.submit": "ctrl+s", "tui.input.newLine": "alt+enter" },
  ],
] as const) {
  test(`questionnaire uses the configured editor and lets it own modal input (${name})`, async (t) => {
    const previous = getKeybindings();
    t.onTestFinished(() => setKeybindings(previous));
    const { ctx, tui, editors, components, running, keybindings, factory } = run(bindings);
    setKeybindings(keybindings);
    const mainDraft = "main prompt draft";
    ctx.ui.getEditorText = () => mainDraft;
    ctx.ui.setEditorText = () => assert.fail("must not modify the main editor");
    ctx.ui.setEditorComponent = () => assert.fail("must not replace the main editor");
    await tui.waitForOpen();
    assert.equal(components[0]?.wantsKeyRelease, true);
    openAnswer(tui);
    assert.equal(components[0]?.wantsKeyRelease, true);
    assert.equal(editors.length, 1);
    const editor = editors[0];
    assert.ok(editor);
    assert.equal(editor.focused, true);
    assert.ok(tui.render().join("\n").includes(CURSOR_MARKER));
    tui.type("draftx");
    tui.send("\u001b");
    assert.equal(tui.isOpen, true);
    assert.equal(editor.mode, "normal");
    assert.equal(editor.getExpandedText(), "draftx");
    tui.send(name === "default" ? "\r" : "\u0013");
    assert.equal(tui.isOpen, true, "normal-mode editor owns submission keys too");
    tui.type("x");
    tui.type("i");
    tui.send("\u001b\r");
    tui.type("answer");
    const editingHints = tui.render().join("\n");
    assert.match(editingHints, /editor keybindings/u);
    assert.match(editingHints, /Ctrl\+C/u);
    assert.doesNotMatch(editingHints, /Esc cancel/u);
    tui.send(name === "default" ? "\r" : "\u0013");
    assert.deepEqual(await running, {
      kind: "submitted",
      answers: [{ questionId: "scope", answer: "draft\nanswer", wasCustom: true }],
    });
    assert.equal(editor.disposed, 1);
    assert.equal(editor.focused, false);
    assert.equal(ctx.ui.getEditorText(), mainDraft);
    assert.equal(ctx.ui.getEditorComponent(), factory);
  });
}

test("custom editing owns configured cancel aliases and collisions while retaining hard-cancel fallback", async (t) => {
  const previousKitty = isKittyProtocolActive();
  t.onTestFinished(() => setKittyProtocolActive(previousKitty));
  for (const scenario of [
    { name: "matcher alias", cancel: ["return"], data: "\r", kitty: false },
    { name: "modifier order", cancel: ["shift+ctrl+x"], data: "\u001b[120;6u", kitty: true },
    { name: "legacy Ctrl+I / Tab collision", cancel: ["ctrl+i"], data: "\t", kitty: false },
    { name: "legacy Ctrl+[ / Escape collision", cancel: ["ctrl+["], data: "\u001b", kitty: false },
    { name: "Kitty disambiguation", cancel: ["ctrl+i"], data: "\u001b[105;5u", kitty: true },
    { name: "invalid configured key", cancel: ["not-a-key"], data: "\u0018", kitty: false },
    { name: "first usable configured fallback", cancel: ["not-a-key", "ctrl+x"], data: "\u0018", kitty: false },
  ]) {
    setKittyProtocolActive(scenario.kitty);
    const { tui, editors, running } = run({
      // Exercise malformed runtime configuration as well as statically valid keys.
      "tui.select.cancel": scenario.cancel as KeyId[],
      "tui.select.confirm": "ctrl+f",
    });
    await tui.waitForOpen();
    tui.setFocused(true);
    tui.press("tui.select.down");
    tui.send("\u0006");
    tui.send("\u001b");
    tui.send(scenario.data);
    assert.equal(tui.isOpen, true, scenario.name);
    assert.equal(editors[0]?.inputs.at(-1), scenario.data, scenario.name);
    const hints = tui.render().join("\n");
    assert.match(hints, /Ctrl\+C cancel/u);
    assert.doesNotMatch(hints, /not-a-key/u);
    tui.press("ctrl+c");
    assert.deepEqual(await running, { kind: "closed", reason: "close" });
  }
});

test("questionnaire delegates optional notes to the configured editor", async () => {
  const { tui, editors, running } = run();
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.type("n");
  tui.type("notex");
  tui.send("\u001b");
  assert.equal(tui.isOpen, true);
  tui.type("x");
  tui.type("i");
  tui.press("tui.input.submit");
  assert.equal(editors[0]?.focused, false);
  tui.press("tui.select.confirm");
  assert.deepEqual(await running, {
    kind: "submitted",
    answers: [{ questionId: "scope", answer: "Small", wasCustom: false, optionIndex: 1, note: "note" }],
  });
});

for (const exit of ["hard cancel", "owner abort", "dispose", "stale"] as const) {
  test(`questionnaire releases its custom editor on ${exit} and ignores late submissions`, async () => {
    const owner = new AbortController();
    let current = true;
    const { tui, editors, running } = run({}, { signal: owner.signal, isCurrent: () => current });
    await tui.waitForOpen();
    openAnswer(tui);
    const editor = editors[0];
    assert.ok(editor);
    const lateSubmit = editor.onSubmit;
    tui.type("draft");
    tui.send("\u001b");
    if (exit === "hard cancel") tui.press("ctrl+c");
    else if (exit === "owner abort") owner.abort();
    else if (exit === "dispose") tui.dispose();
    else {
      current = false;
      tui.type("a");
    }
    const result = await running;
    assert.deepEqual(result, exit === "hard cancel" ? { kind: "closed", reason: "close" } : { kind: "stale" });
    assert.equal(editor.disposed, 1);
    assert.equal(editor.focused, false);
    assert.equal(editor.onSubmit, undefined);
    lateSubmit?.("late answer");
    assert.equal(tui.isOpen, false);
  });
}

test("questionnaire keeps selector cancellation outside custom editing", async () => {
  const { tui, running } = run({ "tui.select.cancel": "ctrl+x" });
  await tui.waitForOpen();
  tui.send("\u0018");
  assert.deepEqual(await running, { kind: "closed", reason: "back" });
});

test("questionnaire preserves fragmented raw paste, expanded text, and limits with a custom editor", async () => {
  const { tui, running } = run({}, { maxTextLength: 4_000 });
  await tui.waitForOpen();
  openAnswer(tui);
  const raw = `\rraw\u001b]8;;https://example.invalid\u0007\u202e ${"a".repeat(1_100)}\r`;
  tui.send("\u001b[200~");
  tui.send(raw.slice(0, 10));
  tui.send(raw.slice(10));
  tui.send("\u001b[201~");
  for (const width of [1, 8, 40]) {
    for (const line of tui.resize({ width })) {
      assert.ok(visibleWidth(line) <= width);
      assert.equal(line.includes("\u202e"), false);
    }
  }
  tui.press("tui.input.submit");
  assert.equal(tui.isOpen, false);
  assert.deepEqual(await running, {
    kind: "submitted",
    answers: [{ questionId: "scope", answer: raw, wasCustom: true }],
  });

  const limited = run({}, { maxTextLength: 5 });
  await limited.tui.waitForOpen();
  openAnswer(limited.tui);
  limited.tui.type("too long");
  limited.tui.press("tui.input.submit");
  assert.match(limited.tui.render().join("\n"), /5 characters or fewer/u);
  assert.equal(limited.tui.isOpen, true);
  limited.tui.press("ctrl+c");
  await limited.running;
});

for (const custom of [false, true]) {
  test(`questionnaire treats key-like fragmented paste chunks as text (${custom ? "custom" : "default"} editor)`, async () => {
    const tui = createTuiHarness();
    const ctx = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom }).ctx as ExtensionContext;
    ctx.ui.getEditorComponent = () => (custom ? (host, theme, keys) => new ModalEditor(host, theme, keys) : undefined);
    const running = runQuestionnaire(ctx, { questions });
    await tui.waitForOpen();
    openAnswer(tui);
    const chunks = ["text", "\u001b", "\u0003", "\r", "\n", "tail"];
    tui.send("\u001b[200~");
    for (const chunk of chunks) {
      tui.send(chunk);
      assert.equal(tui.isOpen, true);
    }
    tui.send("\u001b[201~");
    tui.press("tui.input.submit");
    assert.equal(tui.isOpen, false);
    assert.deepEqual(await running, {
      kind: "submitted",
      answers: [{ questionId: "scope", answer: chunks.join(""), wasCustom: true }],
    });
  });
}

for (const transform of [false, true]) {
  test(`questionnaire supports the minimal public EditorComponent contract (${transform ? "transformed" : "raw"} submission)`, async () => {
    const tui = createTuiHarness();
    const ctx = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom }).ctx as ExtensionContext;
    let text = "";
    const editor: EditorComponent = {
      getText: () => text,
      setText(value) {
        text = value;
      },
      render: () => [text],
      invalidate() {},
      handleInput(data) {
        if (data === "!") this.onSubmit?.(transform ? text.toUpperCase() : text);
        else {
          text += data;
          this.onChange?.(text);
        }
      },
    };
    ctx.ui.getEditorComponent = () => () => editor;
    const running = runQuestionnaire(ctx, { questions });
    await tui.waitForOpen();
    openAnswer(tui);
    tui.type("minimal");
    const editorRow = tui.render().findIndex((line) => line.includes("minimal"));
    tui.mouse({ type: "click", x: 1, y: editorRow, button: "left" });
    tui.send("!");
    assert.deepEqual(await running, {
      kind: "submitted",
      answers: [{ questionId: "scope", answer: transform ? "MINIMAL" : "minimal", wasCustom: true }],
    });
  });
}

test("questionnaire reports custom factory failures and keeps non-TUI adapters independent", async () => {
  const tui = createTuiHarness();
  const ctx = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom }).ctx as ExtensionContext;
  const failure = new Error("editor failed");
  ctx.ui.getEditorComponent = () => () => {
    throw failure;
  };
  assert.deepEqual(await runQuestionnaire(ctx, { questions }), { kind: "error", error: failure });
  const rpc = createMockContext({ mode: "rpc", hasUI: true, select: async () => "1. Small" });
  (rpc.ctx as ExtensionContext).ui.getEditorComponent = () => assert.fail("RPC must not request a TUI editor");
  assert.equal((await runQuestionnaire(rpc.ctx, { questions })).kind, "submitted");
  const print = createMockContext({ mode: "print", hasUI: false });
  (print.ctx as ExtensionContext).ui.getEditorComponent = () => assert.fail("print must not request a TUI editor");
  assert.deepEqual(await runQuestionnaire(print.ctx, { questions }), { kind: "unsupported", mode: "print" });
});
