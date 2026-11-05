import assert from "node:assert/strict";
import { test } from "vitest";
import { buildPlanModePrompt, PLAN_MODE_EXTRA_INSTRUCTIONS_PREFIX } from "../src/prompt.js";

test("user guidance is appended deterministically with unchanged Markdown", () => {
  const extra =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Verify that literal user text is never interpolated.
    "\n# Repository-specific detail\n\nWhen supported, explain the migration.\n\n```text\n${HOME} {{value}}\n  preserve indentation\n```\n";
  const base = buildPlanModePrompt();
  const prompt = buildPlanModePrompt(extra);
  assert.equal(prompt, base + PLAN_MODE_EXTRA_INSTRUCTIONS_PREFIX + extra.trim());
  assert.equal(buildPlanModePrompt(extra), prompt);
  assert.equal(buildPlanModePrompt(""), base);
  assert.equal(buildPlanModePrompt(" \n\t "), base);
});
