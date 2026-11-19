import type { WorkerOverrides } from "@narumitw/pi-background";

export interface CompletionCheck extends WorkerOverrides {
  name: string;
  type: "subagent";
  prompt: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && !!value.trim();
}
const efforts = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function checks(value: unknown, path: string): CompletionCheck[] | undefined {
  if (!Array.isArray(value)) throw new Error(`${path} must be a list of named subagent checks`);
  for (const [i, item] of value.entries()) {
    const at = `${path}[${i}]`;
    if (!object(item)) throw new Error(`${at} must be an object`);
    const extra = Object.keys(item).find(
      (k) => !["name", "type", "prompt", "model", "effort", "remove_tools"].includes(k),
    );
    if (extra !== undefined) throw new Error(`${at}: unknown field ${extra}`);
    if (item.type !== "subagent") throw new Error(`${at}.type must be subagent`);
    for (const field of ["name", "prompt"])
      if (!text(item[field])) throw new Error(`${at}.${field} must be a nonblank string`);
    if ("model" in item && (!text(item.model) || !/^[^\s/]+\/[^\s]+$/.test(item.model)))
      throw new Error(`${at}.model must be provider/model`);
    if ("effort" in item && !efforts.includes(item.effort as string))
      throw new Error(`${at}.effort must be one of ${efforts.join(", ")}`);
    if (
      "remove_tools" in item &&
      !(Array.isArray(item.remove_tools) && item.remove_tools.every((n) => text(n) && /^[\w.-]+$/.test(n)))
    )
      throw new Error(`${at}.remove_tools must be a list of tool names`);
  }
  return value.length ? structuredClone(value) : undefined;
}
export function templateChecks(header: Record<string, unknown>, id: string) {
  const path = `Invalid plan template ${id}`;
  if ("on_implementation_complete" in header)
    throw new Error(
      `${path}: migrate on_implementation_complete to a named check under hooks.on_implementation_complete`,
    );
  if (!("hooks" in header)) return undefined;
  if (!object(header.hooks)) throw new Error(`${path}: hooks must be an object`);
  for (const key of Object.keys(header.hooks))
    if (key !== "on_implementation_complete") throw new Error(`${path}: unknown hook event ${key}`);
  return "on_implementation_complete" in header.hooks
    ? checks(header.hooks.on_implementation_complete, `${path}: hooks.on_implementation_complete`)
    : undefined;
}

/** Normalize only captured session metadata, never old template headers. */
export function restoreChecks(snapshot: { completionPrompt?: unknown; completionChecks?: unknown }) {
  if (snapshot.completionPrompt !== undefined) {
    if (!text(snapshot.completionPrompt) || snapshot.completionChecks !== undefined)
      throw new Error("Invalid captured completionPrompt");
    snapshot.completionChecks = [{ name: "Completion task", type: "subagent", prompt: snapshot.completionPrompt }];
  }
  delete snapshot.completionPrompt;
  if (snapshot.completionChecks !== undefined)
    snapshot.completionChecks = checks(snapshot.completionChecks, "completionChecks");
}
