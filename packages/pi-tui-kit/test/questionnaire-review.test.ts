import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type EditorComponent,
  isKeyRelease,
  isKeyRepeat,
  type KeybindingsConfig,
  KeybindingsManager,
  parseKey,
  type Terminal,
  TUI_KEYBINDINGS,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { runQuestionnaire } from "../src/questionnaire.js";
import { createTuiHarness } from "../src/testing/index.js";

const question = { id: "scope", header: "Scope", prompt: "How broad?", options: [{ label: "Small" }] };

for (const field of ["answer", "note"] as const) {
  for (const scenario of [
    { name: "raw", draft: "  answer  ", transform: (value: string) => value, expected: "  answer  ", limit: 100 },
    {
      name: "empty normalized value",
      draft: "   ",
      transform: (value: string) => value.trim(),
      expected: "",
      limit: 1,
    },
    { name: "trim", draft: "  answer  ", transform: (value: string) => value.trim(), expected: "answer", limit: 100 },
    {
      name: "shortened length limit",
      draft: "   ok   ",
      transform: (value: string) => value.trim(),
      expected: "ok",
      limit: 2,
    },
    {
      name: "trim start only",
      draft: "  answer  ",
      transform: (value: string) => value.trimStart(),
      expected: "answer  ",
      limit: 100,
    },
    {
      name: "asynchronous trim",
      draft: "  answer  ",
      transform: (value: string) => value.trim(),
      expected: "answer",
      limit: 100,
      async: true,
    },
  ]) {
    test(`custom ${field} submission remains authoritative: ${scenario.name}`, async () => {
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
          if (data === "!") {
            const value = scenario.transform(text);
            if (scenario.async) void Promise.resolve().then(() => this.onSubmit?.(value));
            else this.onSubmit?.(value);
          } else {
            text += data;
            this.onChange?.(text);
          }
        },
      };
      ctx.ui.getEditorComponent = () => () => editor;
      const running = runQuestionnaire(ctx, { questions: [question], allowNotes: true, maxTextLength: scenario.limit });
      await tui.waitForOpen();
      if (field === "answer") {
        tui.press("tui.select.down");
        tui.press("tui.select.confirm");
      } else tui.type("n");
      tui.type(scenario.draft);
      tui.send("!");
      await Promise.resolve();
      if (tui.isOpen) assert.doesNotMatch(tui.render().join("\n"), /characters or fewer/u);
      if (field === "answer" && !scenario.expected) {
        assert.match(tui.render().join("\n"), /Custom answer cannot be empty/u);
        tui.press("ctrl+c");
        assert.deepEqual(await running, { kind: "closed", reason: "close" });
        return;
      }
      if (field === "note") tui.press("tui.select.confirm");
      assert.equal(tui.isOpen, false);
      assert.deepEqual(await running, {
        kind: "submitted",
        answers: [
          field === "answer"
            ? { questionId: "scope", answer: scenario.expected, wasCustom: true }
            : {
                questionId: "scope",
                answer: "Small",
                wasCustom: false,
                optionIndex: 1,
                ...(scenario.expected ? { note: scenario.expected } : {}),
              },
        ],
      });
    });
  }
}

async function keyCycleRun(bindings: KeybindingsConfig = {}) {
  let input: (data: string) => void = () => {
    throw new Error("fake terminal not started");
  };
  const noop = () => {};
  const terminal: Terminal = {
    start(onInput) {
      input = onInput;
    },
    stop: noop,
    drainInput: async () => {},
    write: noop,
    columns: 80,
    rows: 30,
    kittyProtocolActive: true,
    moveBy: noop,
    hideCursor: noop,
    showCursor: noop,
    clearLine: noop,
    clearFromCursor: noop,
    clearScreen: noop,
    setTitle: noop,
    setProgress: noop,
    setProgramStatus: noop,
  };
  const host = new TuiMainScreen(terminal);
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
  const harness = createTuiHarness({ keybindings });
  const ctx = createMockContext({ mode: "tui", hasUI: true, custom: harness.custom }).ctx as ExtensionContext;
  ctx.ui.custom = (create, options) =>
    harness.custom(async (_tui, theme, keys, done) => {
      const component = await create(host, theme, keys, done);
      host.addChild(component);
      host.setFocus(component);
      return component;
    }, options);
  const events: string[] = [];
  const held = new Set<string>();
  let text = "";
  let disposed = 0;
  ctx.ui.getEditorComponent = () => () => {
    const editor: EditorComponent & { wantsKeyRelease: boolean; dispose(): void } = {
      wantsKeyRelease: true,
      getText: () => text,
      setText(value) {
        text = value;
      },
      render: () => [text],
      invalidate: noop,
      handleInput(data) {
        events.push(data);
        const key = parseKey(data)?.replace(/^(?:(?:shift|ctrl|alt|super)\+)+/u, "");
        if (isKeyRelease(data)) {
          if (key) held.delete(key);
          return;
        }
        if (key) held.add(key);
        if (!isKeyRepeat(data) && keybindings.matches(data, "tui.input.submit")) this.onSubmit?.("answer");
      },
      dispose() {
        disposed++;
        held.clear();
      },
    };
    return editor;
  };
  const running = runQuestionnaire(ctx, { questions: [question, { ...question, id: "second" }], allowNotes: true });
  await harness.waitForOpen();
  host.start();
  return {
    emit: (data: string) => input(data),
    harness,
    host,
    running,
    events,
    held,
    get disposed() {
      return disposed;
    },
  };
}

for (const [name, bindings, submit, repeat, release] of [
  ["default", {}, "\u001b[13;1:1u", "\u001b[13;1:2u", "\u001b[13;1:3u"],
  ["remapped submit", { "tui.input.submit": "ctrl+s" }, "\u001b[115;5:1u", "\u001b[115;5:2u", "\u001b[115;1:3u"],
] as const) {
  for (const flow of ["answer", "note"] as const) {
    test(`real Pi TUI balances custom editor key cycles across ${flow} transitions (${name})`, async (t) => {
      const run = await keyCycleRun(bindings);
      t.onTestFinished(() => run.host.stop());
      const openPress = flow === "answer" ? "\u001b[13;1:1u" : "n";
      const openRelease = flow === "answer" ? "\u001b[13;1:3u" : "\u001b[110;1:3u";
      if (flow === "answer") {
        run.emit("\u001b[1;1:1B");
        run.emit("\u001b[1;1:3B");
      }
      run.emit(openPress);
      run.emit(openRelease);
      assert.equal(run.harness.isOpen, true);
      assert.deepEqual(run.events, [], "selector-owned opening cycle must not leak to editor");
      run.emit("\u001b[97;1:1u");
      run.emit(submit);
      run.emit(repeat);
      run.emit(release);
      run.emit("\u001b[97;1:3u");
      assert.deepEqual(run.events, ["\u001b[97;1:1u", submit, repeat, release, "\u001b[97;1:3u"]);
      assert.equal(run.held.size, 0, "submission must not leave stale held keys");
      const beforeReopen = run.events.length;
      run.emit("n");
      run.emit("\u001b[110;1:3u");
      assert.equal(run.events.length, beforeReopen, "reopening note must not introduce orphan release");
      run.emit("\u0003");
      assert.deepEqual(await run.running, { kind: "closed", reason: "close" });
      assert.equal(run.disposed, 2);
    });
  }
}

test("real Pi TUI ignores unowned releases and opening repeats without cancelling or submitting", async (t) => {
  const run = await keyCycleRun();
  t.onTestFinished(() => run.host.stop());
  run.emit("n");
  for (const data of ["\u001b[99;5:3u", "\u001b[27;1:3u", "\u001b[13;1:3u", "\u001b[110;1:2u"]) run.emit(data);
  assert.equal(run.harness.isOpen, true);
  assert.deepEqual(run.events, []);
  run.emit("\u0003");
  assert.deepEqual(await run.running, { kind: "closed", reason: "close" });
});

test("real Pi TUI forwards ordinary text containing release/repeat-like substrings", async (t) => {
  const run = await keyCycleRun();
  t.onTestFinished(() => run.host.stop());
  run.emit("n");
  for (const text of ["text:3u", "text:2F"]) run.emit(text);
  assert.deepEqual(run.events, ["text:3u", "text:2F"]);
  run.emit("\u0003");
  await run.running;
});

test("real Pi TUI drains old editor key cycles after a new editor opens", async (t) => {
  const run = await keyCycleRun();
  t.onTestFinished(() => run.host.stop());
  run.emit("n");
  run.emit("\u001b[97;1:1u");
  run.emit("\u001b[13;1:1u");
  run.emit("n");
  assert.equal(run.disposed, 0, "old editor remains alive while it owns pending releases");
  run.emit("\u001b[13;1:3u");
  assert.equal(run.disposed, 0);
  run.emit("\u001b[97;1:3u");
  assert.equal(run.disposed, 1, "retired editor is disposed once its final cycle drains");
  assert.equal(run.held.size, 0);
  run.emit("\u0003");
  await run.running;
  assert.equal(run.disposed, 2);
});

test("real Pi TUI retains submission releases after note editor closes", async (t) => {
  const run = await keyCycleRun();
  t.onTestFinished(() => run.host.stop());
  run.emit("n");
  run.emit("\u001b[97;1:1u");
  run.emit("\u001b[13;1:1u");
  run.emit("\u001b[13;1:3u");
  run.emit("\u001b[97;1:3u");
  assert.equal(run.held.size, 0);
  assert.deepEqual(run.events.slice(-2), ["\u001b[13;1:3u", "\u001b[97;1:3u"]);
  run.emit("\u0003");
  await run.running;
});

for (const pair of [
  ["CSI-u", "\u001b[120;6:1u", "\u001b[120;1:3u"],
  ["arrow", "\u001b[1;6:1A", "\u001b[1;1:3A"],
  ["functional", "\u001b[3;6:1~", "\u001b[3;1:3~"],
  ["home", "\u001b[1;6:1H", "\u001b[1;1:3H"],
  ["unnamed CSI-u", "\u001b[1040;6:1u", "\u001b[1040;1:3u"],
  ["unnamed functional", "\u001b[15;6:1~", "\u001b[15;1:3~"],
  ["end", "\u001b[1;6:1F", "\u001b[1;1:3F"],
  ["legacy letter", "x", "\u001b[120;1:3u"],
  ["alternate/base layout", "\u001b[1072::97;6:1u", "\u001b[1072::97;1:3u"],
  ["shifted identity", "\u001b[65;2:1u", "\u001b[97;1:3u"],
  ["unnamed modifier", "\u001b[120;17:1u", "\u001b[120;1:3u"],
] as const) {
  test(`custom editor receives balanced ${pair[0]} cycles when modifiers change`, async (t) => {
    const run = await keyCycleRun();
    t.onTestFinished(() => run.host.stop());
    run.emit("n");
    run.emit(pair[1]);
    run.emit(pair[2]);
    assert.deepEqual(run.events, [pair[1], pair[2]]);
    run.emit("\u0003");
    await run.running;
  });
}
