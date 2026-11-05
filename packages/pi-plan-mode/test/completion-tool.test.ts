import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { planModeCompleted, renderPlanModeCompletion } from "../src/completion-tool.js";

test("completion rendering strips terminal controls without modifying the saved-plan payload", () => {
  initTheme("dark", false);
  const clipboard = "\u001b]52;c;SGVsbG8=\u0007";
  const plan = `# Safe heading\n\nBefore ${clipboard}after\n\n\u202eLast paragraph`;
  const result = planModeCompleted(plan, "/plans/test-01.md");
  const rendered = renderPlanModeCompletion(result).render(100).join("\n");
  assert.equal(rendered.includes(clipboard), false);
  assert.equal(rendered.includes("\u202e"), false);
  const visible = stripVTControlCharacters(rendered);
  assert.ok(visible.includes("Before after"));
  assert.ok(visible.includes("Last paragraph"));
  assert.ok(visible.includes("/plans/test-01.md"));
  assert.equal(result.details.plan, plan);
  assert.ok(result.content[0].text.includes(plan));
});
