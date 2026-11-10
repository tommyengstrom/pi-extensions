import assert from "node:assert/strict";
import { test } from "vitest";
import { planHash } from "../src/plan-store.js";
import { MAX_PLAN_MODE_INSTRUCTIONS_BYTES } from "../src/planning-instructions.js";
import { DEFAULT_PLAN_MODE_PROMPT } from "../src/prompt.js";
import { PLAN_STATE_ENTRY, restorePlanState } from "../src/state.js";
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

test("absent base prompts default once in memory and valid captured prompts preserve exact text", () => {
  for (const basePrompt of [
    undefined,
    DEFAULT_PLAN_MODE_PROMPT,
    "# Custom\r\n\n  Literal Markdown  ",
    "é".repeat(32768),
  ]) {
    const state = restore(basePrompt === undefined ? {} : { basePrompt });
    assert.equal(state.kind, "planning");
    if (state.kind !== "planning") throw new Error("Expected planning");
    assert.equal(state.workflow.basePrompt, basePrompt ?? DEFAULT_PLAN_MODE_PROMPT);
    assert.equal(state.workflow.instructions, "Captured guidance");
    assert.equal(state.workflow.version, 3);
  }
});

test("invalid persisted base prompts reject the workflow rather than substituting defaults", () => {
  for (const basePrompt of [null, false, 42, {}, [], "", " \n\t", "é".repeat(MAX_PLAN_MODE_INSTRUCTIONS_BYTES / 2 + 1)])
    assert.throws(() => restore({ basePrompt }), /Invalid/);
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

test("invalid version, storage, hashes and tool lists cannot restore current ownership", () => {
  for (const invalid of [
    { version: 2 },
    { id: "" },
    { storage: { kind: "other" } },
    { hash: "not-a-hash" },
    { previousTools: [42] },
    { tools: [null] },
    { instructions: "é".repeat(MAX_PLAN_MODE_INSTRUCTIONS_BYTES) },
    { document: { ...planDocument(), path: "" } },
  ])
    assert.throws(() => restore(invalid), /Invalid|Legacy/);
});
