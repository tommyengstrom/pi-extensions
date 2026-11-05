import assert from "node:assert/strict";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { test } from "vitest";
import { defaultPlanTools, PLAN_HELPER_NAMES, resolvePlanTools } from "../src/tool-policy.js";

function builtin(name: string, overrides: Partial<ToolInfo> = {}): ToolInfo {
  return {
    name,
    description: name,
    parameters: Type.Object({}),
    exposure: "direct",
    sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" },
    ...overrides,
  };
}

function extension(name: string, overrides: Partial<ToolInfo> = {}): ToolInfo {
  return builtin(name, {
    sourceInfo: { path: "/extensions/custom.ts", source: "extension", scope: "user", origin: "top-level" },
    ...overrides,
  });
}

const helpers = () => PLAN_HELPER_NAMES.map((name) => extension(name));

test("defaults select only canonical read, grep, find, and ls, in stable order", () => {
  const tools = ["write", "ls", "bash", "read", "edit", "find", "powershell", "grep"].map((name) => builtin(name));
  assert.deepEqual(defaultPlanTools(tools), ["read", "grep", "find", "ls"]);
  assert.deepEqual(resolvePlanTools([...tools, ...helpers()]), {
    allowed: ["read", "grep", "find", "ls", ...PLAN_HELPER_NAMES],
    active: ["read", "grep", "find", "ls", ...PLAN_HELPER_NAMES],
    unavailable: [],
  });
});

test("defaults never trust same-name overrides, annotations, or incomplete builtin provenance", () => {
  for (const name of ["read", "grep", "find", "ls"]) {
    const source = builtin(name).sourceInfo;
    for (const tool of [
      extension(name, { annotations: { readOnlyHint: true } }),
      builtin(name, { sourceInfo: { ...source, source: "sdk" } }),
      builtin(name, { sourceInfo: { ...source, path: "builtin:other-extension" } }),
      builtin(name, { sourceInfo: { ...source, path: "" } }),
      builtin(name, { exposure: "hidden" }),
    ]) {
      assert.deepEqual(defaultPlanTools([tool]), [], name);
    }
  }
  assert.deepEqual(defaultPlanTools([extension("read_only", { annotations: { readOnlyHint: true } })]), []);
});

test("explicit tools are trusted, including shells, writes, and overrides", () => {
  const tools = [builtin("bash"), builtin("powershell"), builtin("write"), extension("read"), extension("custom")];
  const selected = tools.map((tool) => tool.name);
  assert.deepEqual(resolvePlanTools([...tools, ...helpers()], selected), {
    allowed: [...selected, ...PLAN_HELPER_NAMES],
    active: [...selected, ...PLAN_HELPER_NAMES],
    unavailable: [],
  });
});

test("an explicit empty selection does not fall back to defaults", () => {
  assert.deepEqual(resolvePlanTools([builtin("read"), ...helpers()], []), {
    allowed: [...PLAN_HELPER_NAMES],
    active: [...PLAN_HELPER_NAMES],
    unavailable: [],
  });
});

test("helpers must actually be registered and reachable", () => {
  assert.deepEqual(resolvePlanTools([], []), {
    allowed: [],
    active: [],
    unavailable: [...PLAN_HELPER_NAMES],
  });
  assert.deepEqual(
    resolvePlanTools([extension(PLAN_HELPER_NAMES[0], { exposure: "hidden" }), extension(PLAN_HELPER_NAMES[1])], []),
    {
      allowed: [PLAN_HELPER_NAMES[1]],
      active: [PLAN_HELPER_NAMES[1]],
      unavailable: [PLAN_HELPER_NAMES[0]],
    },
  );
});

test("hidden and unknown tools are unavailable, with exact names and stable deduplication", () => {
  assert.deepEqual(
    resolvePlanTools(
      [builtin("read"), extension("hidden", { exposure: "hidden" }), ...helpers()],
      ["missing", "read", "hidden", "read", "missing", " read", "READ", PLAN_HELPER_NAMES[0]],
    ),
    {
      allowed: ["read", ...PLAN_HELPER_NAMES],
      active: ["read", ...PLAN_HELPER_NAMES],
      unavailable: ["missing", "hidden", " read", "READ"],
    },
  );
});

test("direct/model-only are activated; codemode/deferred are allowed without forced activation", () => {
  const tools = [
    extension("direct", { exposure: "direct" }),
    extension("orchestrator", { exposure: "model-only" }),
    extension("script_tool", { exposure: "codemode" }),
    extension("searchable", { exposure: "deferred" }),
    ...helpers(),
  ];
  assert.deepEqual(
    resolvePlanTools(
      tools,
      tools.map((tool) => tool.name),
    ),
    {
      allowed: ["direct", "orchestrator", "script_tool", "searchable", ...PLAN_HELPER_NAMES],
      active: ["direct", "orchestrator", ...PLAN_HELPER_NAMES],
      unavailable: [],
    },
  );
});

test("orchestrator selection does not grant any nested tool names or namespace wildcards", () => {
  const tools = [
    extension("codemode", { exposure: "model-only", reachesTools: () => "all" }),
    extension("mcp__docs__read", {
      exposure: "codemode",
      namespace: { name: "mcp__docs" },
      annotations: { readOnlyHint: true },
    }),
    extension("mcp__docs__write", { exposure: "deferred", namespace: { name: "mcp__docs" } }),
    builtin("bash"),
    ...helpers(),
  ];
  const selected = ["codemode", "mcp__docs__read", "mcp__docs", "mcp__docs__*"];
  const resolved = resolvePlanTools(tools, selected);
  assert.deepEqual(resolved, {
    allowed: ["codemode", "mcp__docs__read", ...PLAN_HELPER_NAMES],
    active: ["codemode", ...PLAN_HELPER_NAMES],
    unavailable: ["mcp__docs", "mcp__docs__*"],
  });
  // The same exact-name set is used by core for top-level and nested tool_call events.
  const allowed = new Set(resolved.allowed);
  for (const name of ["codemode", "mcp__docs__read", ...PLAN_HELPER_NAMES]) assert.equal(allowed.has(name), true);
  for (const name of ["mcp__docs__write", "bash"]) assert.equal(allowed.has(name), false);
});

test("resolving selections does not mutate the catalogue or caller's selection", () => {
  const tools = Object.freeze([builtin("read"), ...helpers()]);
  const selected = Object.freeze(["read", "read"]);
  const result = resolvePlanTools(tools, selected);
  result.allowed.push("bash");
  assert.deepEqual(selected, ["read", "read"]);
  assert.deepEqual(resolvePlanTools(tools, selected).allowed, ["read", ...PLAN_HELPER_NAMES]);
});
