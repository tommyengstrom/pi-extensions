import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEditToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionToolContext,
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "vitest";
import { PLAN_MODE_MAX_CHARS } from "../src/completion-tool.js";
import {
  applyPlanEdits,
  PLAN_MODE_EDIT_PARAMS,
  PLAN_MODE_EDIT_TOOL_NAME,
  type PlanEditInput,
  planModeEdited,
} from "../src/edit-tool.js";
import type { PlanRevision } from "../src/plan-store.js";

const cwd = join(tmpdir(), "pi-plan-edit-virtual");
const revision: PlanRevision = {
  series: "test",
  revision: 1,
  path: join(cwd, "test-01.md"),
  title: "Test",
};
const ctx = { cwd } as ExtensionToolContext;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function edit(oldText: string, newText: string, path = revision.path): PlanEditInput {
  return { path, edits: [{ oldText, newText }] };
}

test("edit parameters are exactly the current SDK schema, with no legacy or plan-only fields", () => {
  assert.equal(PLAN_MODE_EDIT_TOOL_NAME, "plan_mode_edit");
  assert.strictEqual(PLAN_MODE_EDIT_PARAMS, createEditToolDefinition(cwd).parameters);
  assert.deepEqual(Object.keys(PLAN_MODE_EDIT_PARAMS.properties).sort(), ["edits", "path"]);
  assert.deepEqual(PLAN_MODE_EDIT_PARAMS.required, ["path", "edits"]);
  assert.deepEqual(Object.keys(PLAN_MODE_EDIT_PARAMS.properties.edits.items.properties).sort(), ["newText", "oldText"]);
  assert.deepEqual(PLAN_MODE_EDIT_PARAMS.properties.edits.items.required, ["oldText", "newText"]);
});

test("SDK resolves relative, absolute, dot-segment, @, and home paths before the access guard", async () => {
  for (const path of ["test-01.md", revision.path, "./nested/../test-01.md", "@test-01.md"]) {
    const result = await applyPlanEdits(ctx, edit("before", "after", path), revision, "before");
    assert.equal(result.plan, "after");
  }
  const homeRevision = { ...revision, path: join(homedir(), "pi-plan-edit-virtual", "test-01.md") };
  const result = await applyPlanEdits(
    ctx,
    edit("before", "after", "~/pi-plan-edit-virtual/test-01.md"),
    homeRevision,
    "before",
  );
  assert.equal(result.plan, "after");
  for (const path of ["other.md", "../test-01.md", `${revision.path}.extra`, "~/other.md"]) {
    await assert.rejects(
      applyPlanEdits(ctx, edit("before", "after", path), revision, "before"),
      /Only the selected plan revision/,
    );
  }
});

test("multiple disjoint edits use the original snapshot and preserve SDK diff and patch", async () => {
  const plan = "# Plan\n\nFirst step\n\nMiddle step\n\nLast step";
  const input: PlanEditInput = {
    path: revision.path,
    edits: [
      { oldText: "Last step", newText: "Final step" },
      { oldText: "First step", newText: "Middle step" },
      { oldText: "Middle step", newText: "Second step" },
    ],
  };
  const result = await applyPlanEdits(ctx, input, revision, plan);
  assert.equal(result.plan, "# Plan\n\nMiddle step\n\nSecond step\n\nFinal step");
  assert.equal(result.firstChangedLine, 3);
  let sdkPlan: string | undefined;
  const sdkResult = await createEditToolDefinition(cwd, {
    operations: {
      access: async () => {},
      readFile: async () => Buffer.from(plan),
      writeFile: async (_path, content) => {
        sdkPlan = content;
      },
    },
  }).execute("reference", input, undefined, undefined, ctx);
  assert.equal(result.plan, sdkPlan);
  assert.deepEqual(
    { diff: result.diff, patch: result.patch, firstChangedLine: result.firstChangedLine },
    sdkResult.details,
  );
  assert.match(result.patch, /^--- /);
  assert.ok(result.patch.includes("-First step"));
  assert.ok(result.patch.includes("+Final step"));
});

test("SDK rejects duplicate, missing, sequential-only, overlapping, and nested matches", async () => {
  const cases: Array<{ plan: string; edits: PlanEditInput["edits"]; error: RegExp }> = [
    { plan: "same\nsame", edits: [{ oldText: "same", newText: "next" }], error: /occurrences/ },
    { plan: "before", edits: [{ oldText: "absent", newText: "next" }], error: /Could not find/ },
    {
      plan: "before",
      edits: [
        { oldText: "before", newText: "after" },
        { oldText: "after", newText: "next" },
      ],
      error: /Could not find/,
    },
    {
      plan: "abcdef",
      edits: [
        { oldText: "abcd", newText: "one" },
        { oldText: "cdef", newText: "two" },
      ],
      error: /overlap/,
    },
    {
      plan: "abcdef",
      edits: [
        { oldText: "abcdef", newText: "one" },
        { oldText: "bc", newText: "two" },
      ],
      error: /overlap/,
    },
  ];
  for (const { plan, edits, error } of cases) {
    await assert.rejects(applyPlanEdits(ctx, { path: revision.path, edits }, revision, plan), error);
  }
});

test("SDK fuzzy matching rewrites touched lines but preserves untouched Unicode and whitespace", async () => {
  const plan = "# Plan\nKeep “quotes” — and spaces  \nChange “Ａ” — now  \nEnd";
  const result = await applyPlanEdits(ctx, edit('Change "A" - now', "Changed"), revision, plan);
  assert.equal(result.plan, "# Plan\nKeep “quotes” — and spaces  \nChanged\nEnd");
  assert.equal(result.diff, generateDiffString(plan, result.plan).diff);
  assert.equal(result.patch, generateUnifiedPatch(revision.path, plan, result.plan));
  await assert.rejects(applyPlanEdits(ctx, edit('"same"', "changed"), revision, '“same”\n"same"'), /occurrences/);
});

test("diff and patch compare the original body with the normalized body that will be stored", async () => {
  const plan = "# Plan\n\nBefore";
  const candidate = "  \n# Plan\n\nAfter  \n\n";
  const expected = "# Plan\n\nAfter";
  const result = await applyPlanEdits(ctx, edit(plan, candidate), revision, plan);
  assert.equal(result.plan, expected);
  assert.deepEqual(result, {
    plan: expected,
    ...generateDiffString(plan, expected),
    patch: generateUnifiedPatch(revision.path, plan, expected),
  });
  assert.notEqual(result.patch, generateUnifiedPatch(revision.path, plan, candidate));
  assert.equal(result.firstChangedLine, 3);
});

test("SDK line-ending matching and completion normalization both apply", async () => {
  const result = await applyPlanEdits(
    ctx,
    edit("First\nSecond", "First\nRevised"),
    revision,
    "\ufeff# Plan\r\nFirst\r\nSecond\r\n",
  );
  assert.equal(result.plan, "# Plan\r\nFirst\r\nRevised");
  assert.equal(result.patch, generateUnifiedPatch(revision.path, "\ufeff# Plan\r\nFirst\r\nSecond\r\n", result.plan));
});

test("invalid edits, identical replacements, normalized no-ops, empty and oversized plans reject", async () => {
  await assert.rejects(applyPlanEdits(ctx, { path: revision.path, edits: [] }, revision, "before"), /at least one/);
  await assert.rejects(applyPlanEdits(ctx, edit("", "after"), revision, "before"), /must not be empty/);
  await assert.rejects(applyPlanEdits(ctx, edit("before", "before"), revision, "before"), /No changes/);
  await assert.rejects(
    applyPlanEdits(ctx, edit("before", " before \n"), revision, "before"),
    /no changes after normalization/,
  );
  await assert.rejects(applyPlanEdits(ctx, edit("before", " \n"), revision, "before"), /must not be empty/);
  await assert.rejects(
    applyPlanEdits(ctx, edit("before", "x".repeat(PLAN_MODE_MAX_CHARS + 1)), revision, "before"),
    /must not exceed/,
  );
});

test("surrogate replacements reject before UTF-8 publication, including encoding-equivalent no-ops", async () => {
  for (const replacement of [JSON.parse('"\\ud800"'), "\udfff"]) {
    await assert.rejects(applyPlanEdits(ctx, edit("before", replacement), revision, "before"), /well-formed Unicode/);
    // UTF-8 would otherwise replace the lone surrogate with the existing U+FFFD.
    await assert.rejects(applyPlanEdits(ctx, edit("\ufffd", replacement), revision, "\ufffd"), /well-formed Unicode/);
  }
  const result = await applyPlanEdits(ctx, edit("before", "\ud83d\ude00"), revision, "before");
  assert.equal(result.plan, "😀");
  assert.equal(Buffer.from(result.plan, "utf8").toString("utf8"), result.plan);
  assert.equal(result.patch, generateUnifiedPatch(revision.path, "before", result.plan));
});

test("raw candidates cannot bypass the pre-diff plan limit with whitespace that normalization would remove", async () => {
  const padded = `after${"\n ".repeat(PLAN_MODE_MAX_CHARS)}`;
  assert.equal(padded.trim(), "after");
  await assert.rejects(
    applyPlanEdits(ctx, edit("before", padded), revision, "before"),
    /must not exceed.*including whitespace/,
  );
  const bounded = `after${" ".repeat(PLAN_MODE_MAX_CHARS - 5)}`;
  const result = await applyPlanEdits(ctx, edit("before", bounded), revision, "before");
  assert.equal(result.plan, "after");
  assert.equal(result.diff, generateDiffString("before", "after").diff);
});

test("an actual source file is never read or overwritten, including on failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-edit-"));
  directories.push(directory);
  const source = { ...revision, path: join(directory, "test-01.md") };
  const sentinel = "DISK SENTINEL: not the supplied plan body";
  await writeFile(source.path, sentinel);
  const result = await applyPlanEdits(ctx, edit("before", "after", source.path), source, "before");
  assert.equal(result.plan, "after");
  await assert.rejects(applyPlanEdits(ctx, edit("before", "", source.path), source, "before"), /must not be empty/);
  assert.equal(await readFile(source.path, "utf8"), sentinel);
});

test("cancellation rejects before execution, via context, and while queued by the SDK", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(applyPlanEdits(ctx, edit("before", "after"), revision, "before", controller.signal), /abort/i);
  await assert.rejects(
    applyPlanEdits({ ...ctx, signal: controller.signal }, edit("before", "after"), revision, "before"),
    /abort/i,
  );

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const blocker = withFileMutationQueue(revision.path, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const queuedController = new AbortController();
  const pending = applyPlanEdits(ctx, edit("before", "after"), revision, "before", queuedController.signal);
  const rejected = assert.rejects(pending, /abort/i);
  queuedController.abort();
  release.resolve();
  await blocker;
  await rejected;
  assert.equal((await applyPlanEdits(ctx, edit("before", "after"), revision, "before")).plan, "after");
});

test("edited result reports new path, preserved source, and diff without a full-plan payload", () => {
  const clipboard = "\u001b]52;c;SGVsbG8=\u0007";
  const result = {
    plan: "FULL PLAN MUST NOT BE INCLUDED",
    diff: `-1 before\n+1 after${clipboard}\u202e`,
    patch: "raw unified patch",
    firstChangedLine: 1,
  };
  const next = { ...revision, revision: 2, path: join(cwd, "test-02.md") };
  for (const terminate of [true, false]) {
    const output = planModeEdited(next, revision.path, result, terminate);
    assert.equal(output.terminate, terminate);
    assert.ok(output.content[0].text.includes(next.path));
    assert.ok(output.content[0].text.includes(`Source preserved: ${revision.path}`));
    assert.ok(output.content[0].text.includes("+1 after"));
    assert.equal(output.content[0].text.includes(clipboard), false);
    assert.equal(output.content[0].text.includes("\u202e"), false);
    assert.equal(JSON.stringify(output).includes(result.plan), false);
    assert.deepEqual(output.details, {
      revision: next,
      sourcePath: revision.path,
      diff: result.diff,
      patch: result.patch,
      firstChangedLine: 1,
    });
  }
});

test("edited result bounds model-visible diffs at the line and UTF-8 byte limits", () => {
  const atLineLimit = Array.from({ length: DEFAULT_MAX_LINES }, (_, index) => `+${index + 1} line`).join("\n");
  const render = (diff: string) =>
    planModeEdited(revision, revision.path, { plan: "unused", diff, patch: "raw patch" }, false);
  const untruncated = render(atLineLimit);
  assert.ok(untruncated.content[0].text.endsWith(atLineLimit));
  assert.equal(untruncated.content[0].text.includes("[Diff truncated;"), false);

  for (const diff of [
    `${atLineLimit}\n+2001 omitted`,
    Array.from({ length: 60 }, (_, index) => `+${index + 1} ${"😀".repeat(250)}`).join("\n"),
  ]) {
    const result = render(diff);
    const text = result.content[0].text;
    assert.ok(text.endsWith("[Diff truncated; full diff is available in tool details.]"));
    const visibleDiff = text.slice(text.indexOf("\n\n") + 2, text.lastIndexOf("\n[Diff truncated;"));
    assert.ok(visibleDiff.split("\n").length <= DEFAULT_MAX_LINES);
    assert.ok(Buffer.byteLength(visibleDiff, "utf8") <= DEFAULT_MAX_BYTES);
    assert.ok(visibleDiff.isWellFormed());
    assert.equal(visibleDiff.includes("\ufffd"), false);
    assert.ok(visibleDiff.length < diff.length);
    assert.equal(result.details.diff, diff);
    assert.equal(result.details.patch, "raw patch");
  }
});
