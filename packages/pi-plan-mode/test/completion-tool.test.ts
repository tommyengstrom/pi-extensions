import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { normalizePlanModeCompletion, planModeCompleted, renderPlanModeCompletion } from "../src/completion-tool.js";

test("completion normalization rejects malformed UTF-16 rather than changing it on UTF-8 publication", () => {
  for (const plan of ["\ud800", "\udfff", "# Plan\n\ud800text", JSON.parse('"\\ud800"')]) {
    const result = normalizePlanModeCompletion({ plan });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /well-formed Unicode/);
  }
  for (const plan of ["# Plan\n\ud83d\ude00", "# Plan\n\ufffd"]) {
    assert.deepEqual(normalizePlanModeCompletion({ plan }), { ok: true, plan });
    assert.equal(Buffer.from(plan, "utf8").toString("utf8"), plan);
  }
});

test("completion rendering strips terminal controls without modifying the saved-plan payload", () => {
  initTheme("dark", false);
  const clipboard = "\u001b]52;c;SGVsbG8=\u0007";
  const plan = `# Safe heading\n\nBefore ${clipboard}after\n\n\u202eLast paragraph`;
  const result = planModeCompleted(plan, "/plans/test.md");
  const rendered = renderPlanModeCompletion(result).render(100).join("\n");
  assert.equal(rendered.includes(clipboard), false);
  assert.equal(rendered.includes("\u202e"), false);
  const visible = stripVTControlCharacters(rendered);
  assert.ok(visible.includes("Before after"));
  assert.ok(visible.includes("Last paragraph"));
  assert.ok(visible.includes("/plans/test.md"));
  assert.equal(result.details.plan, plan);
  assert.ok(result.content[0].text.includes(plan));
});
