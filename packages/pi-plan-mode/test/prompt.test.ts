import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { buildPlanModePrompt, DEFAULT_EXPLAIN_PROMPT, DEFAULT_PLAN_MODE_PROMPT } from "../src/prompt.js";
import { BUILTIN_PLAN_TEMPLATES, DEFAULT_PLAN_TEMPLATE } from "../src/templates.js";

const explainFile = readFileSync(new URL("../prompts/explain.md", import.meta.url), "utf8").trim();
const planFile = readFileSync(new URL("../prompts/plan.md", import.meta.url), "utf8").trim();

test("the two prompt files are loaded complete and are not assembled from fragments", () => {
  assert.equal(DEFAULT_EXPLAIN_PROMPT, explainFile);
  assert.equal(DEFAULT_PLAN_MODE_PROMPT, planFile);
  assert.match(explainFile, /^\[EXPLAIN MODE ACTIVE]\n# Explain Mode/);
  assert.match(planFile, /^\[PLAN MODE ACTIVE]\n# Plan Mode/);
  assert.equal(explainFile.includes(planFile), false);
  assert.equal(planFile.includes("[EXPLAIN MODE ACTIVE]"), false);
  assert.ok(planFile.trim().split(/\s+/).length <= 250);
});

test("planning appends the template and user guidance unchanged after the plan prompt", () => {
  assert.equal(buildPlanModePrompt(), `${planFile}\n\n${DEFAULT_PLAN_TEMPLATE.content.trim()}`);
  for (const template of BUILTIN_PLAN_TEMPLATES) {
    const prompt = buildPlanModePrompt("", template);
    assert.equal(prompt, `${planFile}\n\n${template.content.trim()}`);
    assert.equal(prompt.includes(`## Plan template (${template.id})`), false);
  }
  const custom = {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal Markdown must not be expanded.
    content: "# Custom ADR\r\n\r\n```text\r\n  ${HOME} {{value}}\r\n```",
  };
  const guidance =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal Markdown must not be expanded.
    "\n# Repository-specific detail\n\n```text\n${HOME} {{value}}\n```\n";
  assert.equal(buildPlanModePrompt(guidance, custom), `${planFile}\n\n${custom.content.trim()}\n\n${guidance.trim()}`);
  assert.equal(buildPlanModePrompt(" \n\t ", custom), `${planFile}\n\n${custom.content.trim()}`);
});

test("the plan file owns template-following and workflow rules without prescribing an outline", () => {
  assert.match(planFile, /Follow the active template below/);
  assert.match(planFile, /Include every section in order/);
  assert.match(planFile, /Follow its HTML comments when gathering evidence, resolving questions, and filling sections/);
  assert.match(planFile, /Do not mutate the codebase or external systems/);
  assert.match(planFile, /extension-assigned filename and same file path/);
  assert.match(planFile, /directly and alone as the final action, never nested or batched/);
  assert.match(planFile, /explicit approval through plan review/);
  assert.match(planFile, /update only associated artifacts/);
  assert.doesNotMatch(planFile, /Phase [123]|Explore first|## Overview|## Verification|## User planning guidance/);
  const custom = { content: "# [Title]\n<!-- Ask first. -->\n\n## Findings" };
  assert.equal(buildPlanModePrompt("", custom), `${planFile}\n\n${custom.content}`);
  assert.equal(buildPlanModePrompt("", custom), buildPlanModePrompt("", custom));
});
