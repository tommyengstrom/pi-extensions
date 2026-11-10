import {
  builtinTool as baseBuiltinTool,
  extensionTool as baseExtensionTool,
  createMockPi as createBaseMockPi,
} from "../../../test/support.js";
import type { PlanDocument } from "../src/plan-store.js";

export {
  createCustomSelectorHarness,
  createMockContext,
  driveCustomSelector,
} from "../../../test/support.js";

/** A document locator, not a cached copy of its Markdown. */
export function planDocument(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "test-plan",
    path: "/plans/test-plan.md",
    title: "Test plan",
    ...overrides,
  };
}

export function builtinTool(name: string) {
  return {
    ...baseBuiltinTool(name),
    exposure: "direct",
    sourceInfo: { source: "builtin", scope: "builtin", path: `builtin:${name}` },
  };
}

export function extensionTool(name: string) {
  return { ...baseExtensionTool(name), exposure: "direct" };
}

/** Model the current host: registration is visible even for default-inactive helpers. */
export function createMockPi(options: Parameters<typeof createBaseMockPi>[0] = {}) {
  const mock = createBaseMockPi(options);
  const allTools = mock.rawPi.getAllTools;
  mock.rawPi.getAllTools = () => [
    ...allTools(),
    ...mock.tools.map((tool) => ({ ...extensionTool(String(tool.name)), ...tool })),
  ];
  Object.assign(mock.rawPi, {
    getCommands: () =>
      [...mock.commands.keys()].map((name) => ({
        name,
        source: "extension",
        sourceInfo: extensionTool("plan_mode_complete").sourceInfo,
      })),
  });
  return mock;
}
