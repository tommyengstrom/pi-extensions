import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { type MenuLifecycle, reviewPlan, selectPlanTools, selectSavedPlan } from "../src/interactive-ui.js";
import type { PlanRevision } from "../src/plan-store.js";
import { builtinTool, createMockContext, extensionTool } from "./support.js";

function owner() {
  const controller = new AbortController();
  let isCurrent = true;
  return {
    controller,
    replace() {
      isCurrent = false;
    },
    lifecycle: { signal: controller.signal, isCurrent: () => isCurrent } satisfies MenuLifecycle,
  };
}

const revision: PlanRevision = { series: "alpha", revision: 2, path: "/plans/alpha-v2.md", title: "Alpha" };
const oldRevision: PlanRevision = { ...revision, revision: 1, path: "/plans/alpha-v1.md" };
const otherRevision: PlanRevision = { series: "beta", revision: 1, path: "/plans/beta-v1.md", title: "Beta" };

function coreTool(name: string): ToolInfo {
  return {
    ...builtinTool(name),
    description: `Use ${name}`,
    parameters: { type: "object", properties: {} },
    exposure: "direct",
    sourceInfo: { source: "builtin", path: `builtin:${name}`, scope: "temporary", origin: "top-level" },
  } as ToolInfo;
}

function customTool(name: string): ToolInfo {
  return { ...coreTool(name), ...extensionTool(name) } as ToolInfo;
}

function tuiContext(tui: ReturnType<typeof createTuiHarness>) {
  return createMockContext({ mode: "tui", custom: tui.custom }).ctx;
}

function rpcContext(rpc: ReturnType<typeof createRpcHarness>) {
  return createMockContext({ mode: "rpc", select: rpc.ui.select, custom: rpc.ui.custom }).ctx;
}

function frame(tui: ReturnType<typeof createTuiHarness>): string {
  return stripVTControlCharacters(tui.render().join("\n"));
}

test("review shows Markdown, metadata and all actions immediately; fresh is always first and requires confirmation", async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const tui = createTuiHarness({ rows: 32 });
    const running = reviewPlan(
      tuiContext(tui),
      "# Full plan\n\nImplement **everything**.",
      revision,
      owner().lifecycle,
    );
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await tui.waitForOpen();
    assert.match(frame(tui), /Full plan/u);
    assert.match(frame(tui), /everything/u);
    assert.match(frame(tui), /\/plans\/alpha-v2\.md/u);
    assert.match(frame(tui), /Revision: 2/u);
    assert.equal(settled, false);
    const actions = frame(tui);
    assert.match(actions, /> Implement in fresh session/u);
    assert.ok(actions.indexOf("Implement in fresh session") < actions.indexOf("Implement here"));
    assert.ok(actions.indexOf("Implement here") < actions.indexOf("Save for later"));
    assert.match(actions, /Continue planning/u);
    assert.equal(settled, false);
    // Choosing here on the first opening must not affect the next opening's default.
    if (attempt === 0) tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    assert.equal(await running, attempt === 0 ? "here" : "fresh");
  }
});

test("review has the whole document available for scrolling and remains width-safe", async () => {
  const tui = createTuiHarness({ width: 70, rows: 20 });
  const plan = ["# Start", ...Array.from({ length: 70 }, (_, index) => `Step ${index + 1}`), "Final sentinel"].join(
    "\n\n",
  );
  const running = reviewPlan(tuiContext(tui), plan, revision, owner().lifecycle);
  await tui.waitForOpen();
  frame(tui); // Establish the viewport, as the host's initial render does.
  tui.press("end");
  assert.match(frame(tui), /Final sentinel/u);
  for (const width of [1, 8, 30, 70]) {
    assert.ok(tui.render(width).every((line) => visibleWidth(line) <= width));
  }
  tui.press("tui.select.cancel");
  assert.equal(await running, undefined);
});

test("Escape from any selected review action returns no action", async () => {
  for (const index of [0, 1, 2, 3]) {
    const tui = createTuiHarness();
    const running = reviewPlan(tuiContext(tui), "Plan", revision, owner().lifecycle);
    await tui.waitForOpen();
    for (let i = 0; i < index; i++) tui.press("tui.select.down");
    tui.press("tui.select.cancel");
    assert.equal(await running, undefined);
  }
});

test("RPC review offers all actions with the first document page and preserves pagination", async () => {
  const actions = ["Implement in fresh session", "Implement here", "Save for later", "Continue planning"];
  const rpc = createRpcHarness([
    { kind: "select", options: [...actions, "Next", "Close"], response: "Next" },
    { kind: "select", options: [...actions, "Previous", "Close"], response: "Save for later" },
  ]);
  const plan = Array.from({ length: 10 }, (_, index) => `Line ${index + 1}`).join("\n");
  assert.equal(await reviewPlan(rpcContext(rpc), plan, revision, owner().lifecycle), "save");
  assert.match(rpc.dialogs[0]?.title ?? "", /Path: \/plans\/alpha-v2\.md[\s\S]*Line 1[\s\S]*Page 1\/2/u);
  assert.match(rpc.dialogs[1]?.title ?? "", /Line 10[\s\S]*Page 2\/2/u);
  rpc.assertConsumed();
});

test("RPC action results are explicit, including continue and cancellation", async () => {
  for (const [label, expected] of [
    ["Implement in fresh session", "fresh"],
    ["Implement here", "here"],
    ["Save for later", "save"],
    ["Continue planning", "continue"],
    [undefined, undefined],
  ] as const) {
    const rpc = createRpcHarness([{ kind: "select", response: label }]);
    assert.equal(await reviewPlan(rpcContext(rpc), "Plan", revision, owner().lifecycle), expected);
    rpc.assertConsumed();
  }
});

test("saved browser groups series and defaults to the newest numeric revision without sorting the input", async () => {
  const tui = createTuiHarness({ rows: 32 });
  const newest: PlanRevision = { ...revision, revision: 10, path: "/plans/alpha-v10.md" };
  const revisions = [oldRevision, otherRevision, newest, revision];
  const running = selectSavedPlan(tuiContext(tui), revisions, owner().lifecycle);
  await tui.waitForOpen();
  assert.match(frame(tui), /Alpha — alpha/u);
  assert.match(frame(tui), /Beta — beta/u);
  assert.doesNotMatch(frame(tui), /Revision 1 — Alpha/u);
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  assert.match(frame(tui), /[→›] Revision 10 \(latest\)/u);
  assert.match(frame(tui), /Revision 2/u);
  assert.match(frame(tui), /Revision 1/u);
  tui.press("tui.select.confirm");
  assert.equal(await running, newest);
  assert.deepEqual(revisions, [oldRevision, otherRevision, newest, revision]);
});

test("same-named series from different stores remain separate and selectable in RPC", async () => {
  const legacy = { ...revision, path: "/legacy/plans/alpha-v2.md" };
  const rpc = createRpcHarness([
    {
      kind: "select",
      options: ["Alpha — alpha · /plans", "Alpha — alpha · /legacy/plans", "Done"],
      response: "Alpha — alpha · /legacy/plans",
    },
    { kind: "select", options: ["Revision 2 (latest) — Alpha", "Back"], response: "Revision 2 (latest) — Alpha" },
  ]);
  assert.equal(await selectSavedPlan(rpcContext(rpc), [revision, oldRevision, legacy], owner().lifecycle), legacy);
  rpc.assertConsumed();
});

test("RPC browser permits an older revision and never persists its selection", async () => {
  for (const selected of [oldRevision, revision]) {
    const rpc = createRpcHarness([
      { kind: "select", options: ["Alpha — alpha", "Beta — beta", "Done"], response: "Alpha — alpha" },
      {
        kind: "select",
        options: ["Revision 2 (latest) — Alpha", "Revision 1 — Alpha", "Back"],
        response: selected === oldRevision ? "Revision 1 — Alpha" : "Revision 2 (latest) — Alpha",
      },
    ]);
    assert.equal(
      await selectSavedPlan(rpcContext(rpc), [oldRevision, otherRevision, revision], owner().lifecycle),
      selected,
    );
    rpc.assertConsumed();
  }
});

test("saved browser cancellation and empty catalogs do not choose a plan", async () => {
  const rpc = createRpcHarness([{ kind: "select", response: undefined }]);
  assert.equal(await selectSavedPlan(rpcContext(rpc), [revision], owner().lifecycle), undefined);
  rpc.assertConsumed();
  const emptyRpc = createRpcHarness([]);
  assert.equal(await selectSavedPlan(rpcContext(emptyRpc), [], owner().lifecycle), undefined);
  emptyRpc.assertConsumed();
});

test("canonical core tools need no trust prompt; fixed helpers are excluded", async () => {
  const rpc = createRpcHarness([{ kind: "select", response: "Apply tool selection" }]);
  const names = ["read", "grep", "find", "ls"];
  const selected = [...names, "plan_mode_question", "plan_mode_complete"];
  const tools = [...names, "bash", "plan_mode_question", "plan_mode_complete"].map(coreTool);
  assert.deepEqual(await selectPlanTools(rpcContext(rpc), tools, selected, owner().lifecycle), names);
  const choices = rpc.dialogs[0]?.options?.join("\n") ?? "";
  assert.match(choices, /\[x\] read/u);
  assert.match(choices, /\[ \] bash/u);
  assert.doesNotMatch(choices, /plan_mode_question|plan_mode_complete/u);
  assert.deepEqual(selected, [...names, "plan_mode_question", "plan_mode_complete"]);
  rpc.assertConsumed();
});

test("nondefault shells, extension tools, and core-name overrides require explicit trust", async () => {
  for (const tool of [coreTool("bash"), coreTool("powershell"), customTool("read"), customTool("deploy")]) {
    const rpc = createRpcHarness([
      { kind: "select", response: "Apply tool selection" },
      { kind: "select", options: ["Trust selected tools", "Cancel changes"], response: "Trust selected tools" },
    ]);
    assert.deepEqual(await selectPlanTools(rpcContext(rpc), [tool], [tool.name], owner().lifecycle), [tool.name]);
    const warning = rpc.dialogs[1]?.title ?? "";
    assert.match(warning, /trusted and may mutate files or external state/u);
    assert.match(warning, /shell tools and overrides/u);
    assert.match(warning, /not a sandbox/u);
    rpc.assertConsumed();
  }
});

test("builtin-looking metadata without exact canonical provenance still requires trust", async () => {
  const tool = { ...coreTool("read"), sourceInfo: { ...coreTool("read").sourceInfo, path: "builtin:extension" } };
  const rpc = createRpcHarness([
    { kind: "select", response: "Apply tool selection" },
    { kind: "select", response: "Cancel changes" },
  ]);
  assert.equal(await selectPlanTools(rpcContext(rpc), [tool], ["read"], owner().lifecycle), undefined);
  rpc.assertConsumed();
});

test("unknown and hidden configured names survive an edit with an explanation and trust confirmation", async () => {
  const hidden: ToolInfo = { ...customTool("hidden-tool"), exposure: "hidden" };
  const rpc = createRpcHarness([
    { kind: "select", response: "Apply tool selection" },
    { kind: "select", response: "Trust selected tools" },
  ]);
  const result = await selectPlanTools(
    rpcContext(rpc),
    [coreTool("read"), hidden],
    ["read", "missing", "hidden-tool"],
    owner().lifecycle,
  );
  assert.deepEqual(result, ["read", "missing", "hidden-tool"]);
  assert.match(rpc.dialogs[0]?.title ?? "", /retained unchanged/u);
  assert.match(rpc.dialogs[0]?.options?.join("\n") ?? "", /\[-\] missing.*unavailable/u);
  assert.match(rpc.dialogs[1]?.title ?? "", /missing, hidden-tool/u);
  rpc.assertConsumed();
});

test("TUI tool toggles are local until explicit completion and trust; Escape discards them", async () => {
  const tui = createTuiHarness({ rows: 32 });
  const selected = ["read"];
  const running = selectPlanTools(tuiContext(tui), [coreTool("read"), coreTool("bash")], selected, owner().lifecycle);
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  assert.match(frame(tui), /\[x\] bash/u);
  assert.deepEqual(selected, ["read"]);
  tui.press("tui.select.cancel");
  assert.equal(await running, undefined);
  assert.deepEqual(selected, ["read"]);
});

test("TUI tool completion opens a separate mutation warning before returning names", async () => {
  const tui = createTuiHarness({ rows: 32 });
  const running = selectPlanTools(tuiContext(tui), [coreTool("bash")], ["bash"], owner().lifecycle);
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  await tui.waitForOpen();
  assert.match(frame(tui), /Trust nondefault planning tools/u);
  assert.match(frame(tui), /may mutate files/u);
  tui.press("tui.select.confirm");
  assert.deepEqual(await running, ["bash"]);
});

test("empty selections remain empty, and cancellation is not an empty selection", async () => {
  for (const response of ["Apply tool selection", undefined]) {
    const rpc = createRpcHarness([{ kind: "select", response }]);
    assert.deepEqual(
      await selectPlanTools(rpcContext(rpc), [coreTool("read")], [], owner().lifecycle),
      response ? [] : undefined,
    );
    rpc.assertConsumed();
  }
});

test("owner abort dismisses open TUI adapters and discards their results", async () => {
  for (const open of [
    (ctx: ReturnType<typeof tuiContext>, lifecycle: MenuLifecycle) => reviewPlan(ctx, "Plan", revision, lifecycle),
    (ctx: ReturnType<typeof tuiContext>, lifecycle: MenuLifecycle) => selectSavedPlan(ctx, [revision], lifecycle),
    (ctx: ReturnType<typeof tuiContext>, lifecycle: MenuLifecycle) =>
      selectPlanTools(ctx, [coreTool("read")], [], lifecycle),
  ]) {
    const tui = createTuiHarness();
    const session = owner();
    const running = open(tuiContext(tui), session.lifecycle);
    await tui.waitForOpen();
    session.controller.abort();
    assert.equal(await running, undefined);
    assert.equal(tui.isOpen, false);
  }
});

test("owner abort dismisses an RPC trust prompt without accepting the selection", async () => {
  const session = owner();
  const rpc = createRpcHarness([
    { kind: "select", response: "Apply tool selection" },
    { kind: "select", waitForAbort: true },
  ]);
  const running = selectPlanTools(rpcContext(rpc), [coreTool("bash")], ["bash"], session.lifecycle);
  await rpc.waitForCall();
  await rpc.waitForCall();
  session.controller.abort();
  assert.equal(await running, undefined);
  rpc.assertConsumed();
});

test("stale RPC responses cannot advance review or return tool selections", async () => {
  for (const operation of ["review", "tools"]) {
    const session = owner();
    let calls = 0;
    const ctx = createMockContext({
      mode: "rpc",
      select: async () => {
        calls += 1;
        session.replace();
        return operation === "review" ? "Implement here" : "Apply tool selection";
      },
    }).ctx;
    const result =
      operation === "review"
        ? await reviewPlan(ctx, "Plan", revision, session.lifecycle)
        : await selectPlanTools(ctx, [coreTool("read")], ["read"], session.lifecycle);
    assert.equal(result, undefined);
    assert.equal(calls, 1);
  }
});

test("a session replacement racing final revision or trust selection discards the result", async () => {
  for (const operation of ["saved", "tools"]) {
    const session = owner();
    let calls = 0;
    const ctx = createMockContext({
      mode: "rpc",
      select: async () => {
        calls += 1;
        if (calls === 1) return operation === "saved" ? "Alpha — alpha" : "Apply tool selection";
        session.replace();
        return operation === "saved" ? "Revision 2 (latest) — Alpha" : "Trust selected tools";
      },
    }).ctx;
    const result =
      operation === "saved"
        ? await selectSavedPlan(ctx, [revision], session.lifecycle)
        : await selectPlanTools(ctx, [coreTool("bash")], ["bash"], session.lifecycle);
    assert.equal(result, undefined);
    assert.equal(calls, 2);
  }
});

test("print/JSON, pre-aborted owners, and stale owners never open UI", async () => {
  for (const mode of ["print", "json", "rpc"] as const) {
    const session = owner();
    if (mode === "rpc") session.controller.abort();
    const rpc = createRpcHarness([]);
    const ctx = createMockContext({ mode, select: rpc.ui.select, custom: rpc.ui.custom }).ctx;
    assert.equal(await reviewPlan(ctx, "Plan", revision, session.lifecycle), undefined);
    assert.equal(await selectSavedPlan(ctx, [revision], session.lifecycle), undefined);
    assert.equal(await selectPlanTools(ctx, [coreTool("read")], [], session.lifecycle), undefined);
    rpc.assertConsumed();
  }
  const session = owner();
  session.replace();
  const rpc = createRpcHarness([]);
  assert.equal(await reviewPlan(rpcContext(rpc), "Plan", revision, session.lifecycle), undefined);
  rpc.assertConsumed();
});

test("display sanitization does not change returned revision paths", async () => {
  const unsafe: PlanRevision = { ...revision, title: "Alpha\u001b[31m", path: "/plans/alpha\u001b[31m.md" };
  const rpc = createRpcHarness([
    { kind: "select", response: "Alpha — alpha" },
    { kind: "select", response: "Revision 2 (latest) — Alpha" },
  ]);
  assert.equal(await selectSavedPlan(rpcContext(rpc), [unsafe], owner().lifecycle), unsafe);
  for (const dialog of rpc.dialogs) {
    assert.equal((dialog.title + dialog.options?.join("\n")).includes("\u001b"), false);
  }
  rpc.assertConsumed();
});
