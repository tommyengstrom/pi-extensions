import assert from "node:assert/strict";
import { test } from "vitest";
import { planHash } from "../src/plan-store.js";
import { MAX_PLAN_MODE_INSTRUCTIONS_BYTES } from "../src/planning-instructions.js";
import { DEFAULT_EXPLAIN_PROMPT } from "../src/prompt.js";
import { PLAN_STATE_ENTRY, restorePlanState } from "../src/state.js";
import { DEFAULT_PLAN_TEMPLATE, resolvePlanTemplate } from "../src/templates.js";
import { planDocument } from "./support.js";

function workflow(base: Record<string, unknown> = {}) {
  return {
    version: 3,
    id: "22222222-2222-4222-8222-222222222222",
    projectRoot: "/project",
    storage: { kind: "repo" },
    instructions: "Captured guidance",
    previousTools: ["read", "write"],
    ...base,
  };
}
function entry(data: unknown) {
  return { type: "custom", customType: PLAN_STATE_ENTRY, data };
}
function restore(base: Record<string, unknown>) {
  return restorePlanState([entry({ kind: "planning", workflow: workflow(base) })]);
}

test("absent template fields default to decision-brief and valid captured templates preserve exact text", () => {
  const detailed = resolvePlanTemplate("detailed-spec");
  for (const [input, expectedId, expectedPrompt] of [
    [{}, DEFAULT_PLAN_TEMPLATE.id, DEFAULT_PLAN_TEMPLATE.content],
    [{ basePrompt: "legacy v3 basePrompt" }, DEFAULT_PLAN_TEMPLATE.id, DEFAULT_PLAN_TEMPLATE.content],
    [{ template: "detailed-spec" }, "detailed-spec", detailed.content],
    [
      { template: "custom-template", templatePrompt: "# Custom\r\n\n  Literal Markdown  " },
      "custom-template",
      "# Custom\r\n\n  Literal Markdown  ",
    ],
    [{ template: "custom-template", templatePrompt: "é".repeat(32768) }, "custom-template", "é".repeat(32768)],
  ] as const) {
    const state = restore(input);
    assert.equal(state.kind, "planning");
    if (state.kind !== "planning") throw new Error("Expected planning");
    assert.equal(state.workflow.template, expectedId);
    assert.equal(state.workflow.templatePrompt, expectedPrompt);
    assert.equal("basePrompt" in state.workflow, false);
    assert.equal("previousTools" in state.workflow, false);
    assert.equal(state.workflow.instructions, "Captured guidance");
    assert.equal(state.workflow.version, 3);
  }
});

test("invalid persisted template fields reject the workflow rather than substituting defaults", () => {
  for (const template of [null, false, 42, {}, [], "", "UpperCase", "invalid_name", "a".repeat(65)])
    assert.throws(() => restore({ template }), /Invalid/);
  for (const templatePrompt of [
    null,
    false,
    42,
    {},
    [],
    "",
    " \n\t",
    "é".repeat(MAX_PLAN_MODE_INSTRUCTIONS_BYTES / 2 + 1),
  ])
    assert.throws(() => restore({ templatePrompt }), /Invalid/);
});

test("ready restores a document locator and hash without embedding Markdown or ancestry", () => {
  const document = planDocument();
  const hash = planHash("# Current plan");
  const state = restorePlanState([
    entry({ kind: "ready", workflow: workflow({ name: document.name, document, hash }), document }),
  ]);
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") throw new Error("Expected ready");
  assert.deepEqual(state.document, document);
  assert.deepEqual(state.workflow.document, document);
  assert.equal(state.workflow.hash, hash);
  assert.equal("parent" in state.workflow, false);
  assert.equal("series" in state.workflow, false);
  assert.equal("plan" in state.workflow, false);
});

test("latest explicit idle or malformed entry wins; prose never reconstructs planning", () => {
  const valid = entry({ kind: "planning", workflow: workflow() });
  assert.deepEqual(restorePlanState([valid, entry({ kind: "idle" })]), { kind: "idle" });
  for (const data of [{ kind: "ready" }, { kind: "unknown" }, null])
    assert.throws(() => restorePlanState([valid, entry(data)]), /Invalid|Legacy/);
  assert.deepEqual(restorePlanState([{ type: "message", message: { role: "assistant", content: "# Plan" } }]), {
    kind: "idle",
  });
});

test("Explain restores independently of v3 workflows and rejects malformed restrictions", () => {
  const restriction = {
    version: 1,
    id: "explain-id",
    tools: ["grep"],
    prompt: DEFAULT_EXPLAIN_PROMPT,
  };
  const original = { kind: "explain", restriction };
  const restored = restorePlanState([
    entry({ ...original, restriction: { ...restriction, previousTools: ["write"] } }),
  ]);
  assert.deepEqual(restored, original);
  assert.notEqual(restored, original);
  assert.equal("workflow" in restored, false);
  for (const invalid of [
    { version: 2 },
    { id: "" },
    { tools: null },
    { prompt: "" },
    { prompt: "é".repeat(MAX_PLAN_MODE_INSTRUCTIONS_BYTES) },
  ])
    assert.throws(
      () => restorePlanState([entry({ kind: "explain", restriction: { ...restriction, ...invalid } })]),
      /Invalid Explain/,
    );
  assert.deepEqual(restorePlanState([entry(original), entry({ kind: "idle" })]), { kind: "idle" });
});

test("invalid version, storage, hashes and tool lists cannot restore current ownership", () => {
  for (const invalid of [
    { version: 2 },
    { id: "" },
    { storage: { kind: "other" } },
    { hash: "not-a-hash" },
    { tools: [null] },
    { instructions: "é".repeat(MAX_PLAN_MODE_INSTRUCTIONS_BYTES) },
    { document: { ...planDocument(), path: "" } },
  ])
    assert.throws(() => restore(invalid), /Invalid|Legacy/);
});
