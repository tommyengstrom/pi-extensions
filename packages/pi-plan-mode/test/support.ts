import {
  builtinTool as baseBuiltinTool,
  extensionTool as baseExtensionTool,
  createMockPi as createBaseMockPi,
} from "../../../test/support.js";

export {
  createCustomSelectorHarness,
  createMockContext,
  driveCustomSelector,
} from "../../../test/support.js";

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
  return mock;
}
