import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { readOptionalMarkdown } from "./planning-instructions.js";
import { DEFAULT_PLAN_TEMPLATE } from "./templates.js";

function readPrompt(name: "explain" | "plan"): string {
  const packageJson = findPackageJSON(import.meta.url);
  if (!packageJson) throw new Error("Unable to locate the Plan-mode package prompts.");
  const path = join(dirname(packageJson), "prompts", `${name}.md`);
  const markdown = readOptionalMarkdown(path, `${name} prompt`);
  if (!markdown) throw new Error(`Missing or empty Plan-mode prompt: ${path}`);
  return markdown;
}

/** Complete prompts. Template bodies and user guidance are appended unchanged, not interpolated. */
export const DEFAULT_EXPLAIN_PROMPT = readPrompt("explain");
export const DEFAULT_PLAN_MODE_PROMPT = readPrompt("plan");

export function buildPlanModePrompt(extraInstructions = "", template: { content: string } = DEFAULT_PLAN_TEMPLATE) {
  return [DEFAULT_PLAN_MODE_PROMPT, template.content.trim(), extraInstructions.trim()].filter(Boolean).join("\n\n");
}
