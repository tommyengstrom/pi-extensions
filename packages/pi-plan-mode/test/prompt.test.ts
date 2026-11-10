import assert from "node:assert/strict";
import { test } from "vitest";
import { buildPlanModePrompt, DEFAULT_PLAN_MODE_PROMPT, PLAN_MODE_EXTRA_INSTRUCTIONS_PREFIX } from "../src/prompt.js";

test("the default asks for approximate changed-line ranges, including scope changes", () => {
  assert.equal(buildPlanModePrompt(), DEFAULT_PLAN_MODE_PROMPT);
  assert.match(DEFAULT_PLAN_MODE_PROMPT, /rough range of changed lines in every completed implementation plan/);
  assert.match(
    DEFAULT_PLAN_MODE_PROMPT,
    /additions plus deletions across source, tests, and documentation—not net file growth/,
  );
  assert.match(DEFAULT_PLAN_MODE_PROMPT, /Avoid false precision or mandatory per-file accounting/);
  assert.match(DEFAULT_PLAN_MODE_PROMPT, /Update the estimate when .*materially change scope/);
});

test("a replacement is the entire base, with only optional guidance appended", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal Markdown must not be expanded.
  const replacement = "# My protocol\r\n\r\n```text\r\n  ${HOME} {{value}}\r\n```";
  assert.equal(buildPlanModePrompt("", replacement), replacement);
  assert.equal(buildPlanModePrompt(" \n\t ", replacement), replacement);
  assert.equal(
    buildPlanModePrompt(" Extra guidance ", replacement),
    `${replacement}${PLAN_MODE_EXTRA_INSTRUCTIONS_PREFIX}Extra guidance`,
  );
  assert.ok(!buildPlanModePrompt("", replacement).includes("CODEX-LIKE"));
  assert.ok(!buildPlanModePrompt("", replacement).includes("changed lines"));
});

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

test("the default describes SDK edit inputs, same-file updates and explicit implementation approval", () => {
  assert.match(DEFAULT_PLAN_MODE_PROMPT, /plan_mode_edit.*path.*edits.*oldText.*newText/);
  assert.match(DEFAULT_PLAN_MODE_PROMPT, /never a delta or change-reason field/);
  assert.match(DEFAULT_PLAN_MODE_PROMPT, /same (?:file|path)|in.place/i);
  assert.doesNotMatch(
    DEFAULT_PLAN_MODE_PROMPT,
    /source is preserved|new numbered revision|same series|returned new path/i,
  );
  assert.match(DEFAULT_PLAN_MODE_PROMPT, /do not echo the full plan/i);
  assert.match(DEFAULT_PLAN_MODE_PROMPT, /edit.*ready.*ends the turn/);
  assert.match(DEFAULT_PLAN_MODE_PROMPT, /alone as the final action/);
  assert.match(DEFAULT_PLAN_MODE_PROMPT, /explicit initial implementation choice/);
  assert.match(DEFAULT_PLAN_MODE_PROMPT, /complete Markdown plan|complete plan as Markdown/);
});
