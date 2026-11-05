import assert from "node:assert/strict";
import { test } from "vitest";
import { MAX_PLAN_MODE_INSTRUCTIONS_BYTES } from "../src/planning-instructions.js";
import { DEFAULT_PLAN_MODE_PROMPT } from "../src/prompt.js";
import { PLAN_STATE_ENTRY, restorePlanState } from "../src/state.js";

function restore(base: Record<string, unknown>) {
  return restorePlanState([
    {
      type: "custom",
      customType: PLAN_STATE_ENTRY,
      data: {
        kind: "planning",
        workflow: {
          projectRoot: "/project",
          plansDirectory: "plans",
          instructions: "Captured guidance",
          previousTools: ["read", "write"],
          ...base,
        },
      },
    },
  ]);
}

test("legacy base snapshots default once in memory and valid snapshots preserve exact text", () => {
  for (const basePrompt of [
    undefined,
    DEFAULT_PLAN_MODE_PROMPT,
    "# Custom\r\n\n  Literal Markdown  ",
    "é".repeat(32768),
  ]) {
    const state = restore(basePrompt === undefined ? {} : { basePrompt });
    assert.equal(state.kind, "planning");
    assert.equal(state.workflow.basePrompt, basePrompt ?? DEFAULT_PLAN_MODE_PROMPT);
    assert.equal(state.workflow.instructions, "Captured guidance");
  }
});

test("invalid persisted base snapshots reject the workflow rather than substituting defaults", () => {
  for (const basePrompt of [
    null,
    false,
    42,
    {},
    [],
    "",
    " \n\t",
    "é".repeat(MAX_PLAN_MODE_INSTRUCTIONS_BYTES / 2 + 1),
  ]) {
    assert.deepEqual(restore({ basePrompt }), { kind: "idle" });
  }
});
