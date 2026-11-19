import { readdirSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type CompletionCheck, templateChecks } from "./completion-checks.js";
import { readOptionalMarkdown } from "./planning-instructions.js";

export interface PlanTemplate {
  id: string;
  label: string;
  description: string;
  content: string;
  completionChecks?: CompletionCheck[];
  source: "builtin" | "user";
}

export const DEFAULT_PLAN_TEMPLATE_ID = "decision-brief";

export function validTemplateName(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}

// Resolve from the owning package, not cwd or the module's depth: the built
// runtime can place this module in dist/chunks while source loads from src.
const packageJson = findPackageJSON(import.meta.url);
if (!packageJson) throw new Error("Unable to locate the Plan-mode package templates.");
const builtinTemplatesDir = join(dirname(packageJson), "templates");

function readBuiltinTemplate(id: string): PlanTemplate {
  const path = join(builtinTemplatesDir, `${id}.md`);
  const markdown = readOptionalMarkdown(path, "built-in template");
  if (!markdown) throw new Error(`Missing or empty built-in plan template: ${path}`);
  return { ...parseUserTemplate(id, markdown), source: "builtin" };
}

export const DEFAULT_PLAN_TEMPLATE = readBuiltinTemplate(DEFAULT_PLAN_TEMPLATE_ID);
export const BUILTIN_PLAN_TEMPLATES: readonly PlanTemplate[] = [
  DEFAULT_PLAN_TEMPLATE,
  ...["detailed-spec", "checklist", "minimal"].map(readBuiltinTemplate),
];

export function planModeTemplatesDir(): string {
  return join(getAgentDir(), "pi-plan-mode-templates");
}

function defaultLabelFromId(id: string): string {
  const spaced = id.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function parseUserTemplate(id: string, rawMarkdown: string): PlanTemplate {
  const markdown = rawMarkdown.trim();
  if (/^---\r?\n/.test(markdown)) {
    const header = /^---\r?\n(?:[^\n]*\n)*?---(?:\r?\n|$)/.exec(markdown);
    if (!header) throw new Error(`Invalid plan template ${id}: unclosed frontmatter header`);
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(header[0]);
    if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter))
      throw new Error(`Invalid plan template ${id}: frontmatter must be an object`);
    for (const key of ["label", "description"] as const) {
      if (key in frontmatter && (typeof frontmatter[key] !== "string" || !frontmatter[key].trim()))
        throw new Error(`Invalid plan template ${id}: ${key} must be a nonempty string`);
    }
    // Only metadata is parsed: preserve literal body Markdown, including comments
    // and line endings, in the workflow's model-visible template snapshot.
    const content = markdown.slice(header[0].length).trim();
    if (!content) throw new Error(`Invalid plan template ${id}: template body must not be empty`);
    const completionChecks = templateChecks(frontmatter, id);
    return {
      id,
      label: (frontmatter.label as string | undefined)?.trim() ?? defaultLabelFromId(id),
      description: (frontmatter.description as string | undefined)?.trim() ?? "Custom user template",
      content,
      ...(completionChecks ? { completionChecks } : {}),
      source: "user",
    };
  }
  // Preserve compatibility with existing headerless and heading/blockquote templates.
  const content = markdown;
  const lines = content.split(/\r?\n/);
  let label = defaultLabelFromId(id);
  let description = "Custom user template";
  let nextLineIndex = 0;

  const headingMatch = /^#\s+(.+?)\s*$/.exec(lines[0] ?? "");
  if (headingMatch?.[1]) {
    label = headingMatch[1].trim();
    nextLineIndex = 1;
    while (nextLineIndex < lines.length && lines[nextLineIndex]?.trim() === "") {
      nextLineIndex++;
    }
  }

  const quoteMatch = /^>\s*(.+?)\s*$/.exec(lines[nextLineIndex] ?? "");
  if (quoteMatch?.[1]) {
    description = quoteMatch[1].trim();
  }

  return {
    id,
    label,
    description,
    content,
    source: "user",
  };
}

function readUserTemplateFile(id: string, path: string): PlanTemplate | undefined {
  const text = readOptionalMarkdown(path, "template");
  if (text === undefined) return undefined;
  if (!text) {
    throw new Error(`Unable to read Plan-mode template at ${JSON.stringify(path)}: template file must not be empty`);
  }
  return parseUserTemplate(id, text);
}

export function listPlanTemplates(templatesDir = planModeTemplatesDir()): PlanTemplate[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(templatesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read Plan-mode templates directory at ${JSON.stringify(templatesDir)}: ${reason}`, {
        cause: error,
      });
    }
  }

  const userTemplates = new Map<string, PlanTemplate>();
  for (const entry of entries) {
    if (entry.startsWith(".") || !entry.endsWith(".md")) continue;
    const id = entry.slice(0, -3);
    if (!validTemplateName(id)) {
      throw new Error(
        `Invalid Plan-mode template filename ${JSON.stringify(entry)} in ${JSON.stringify(templatesDir)}: expected lowercase kebab-case <id>.md`,
      );
    }
    const loaded = readUserTemplateFile(id, join(templatesDir, entry));
    if (loaded) userTemplates.set(id, loaded);
  }

  const builtinIds = new Set(BUILTIN_PLAN_TEMPLATES.map((template) => template.id));
  const merged = BUILTIN_PLAN_TEMPLATES.map((builtin) => userTemplates.get(builtin.id) ?? builtin);
  const extras = [...userTemplates.values()]
    .filter((template) => !builtinIds.has(template.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  return [...merged, ...extras];
}

export function resolvePlanTemplate(
  id: string = DEFAULT_PLAN_TEMPLATE_ID,
  templatesDir = planModeTemplatesDir(),
): PlanTemplate {
  if (!validTemplateName(id)) {
    throw new Error(`Invalid plan template name ${JSON.stringify(id)}: expected lowercase kebab-case.`);
  }
  const userTemplate = readUserTemplateFile(id, join(templatesDir, `${id}.md`));
  if (userTemplate) return userTemplate;
  const builtin = BUILTIN_PLAN_TEMPLATES.find((template) => template.id === id);
  if (builtin) return builtin;
  const available = listPlanTemplates(templatesDir)
    .map((template) => template.id)
    .join(", ");
  throw new Error(`Unknown plan template ${JSON.stringify(id)}. Available templates: ${available}`);
}
