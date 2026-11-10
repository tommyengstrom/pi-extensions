// Copied into a separate npm-installed Pi host by scripts/test-packaging.mjs.
import assert from "node:assert/strict";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

assert.ok(process.env.PI_CODING_AGENT_DIR, "Set isolated agent directory before importing Pi");
const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const candidate = process.argv[2];
const agentDir = process.env.PI_CODING_AGENT_DIR;
await mkdir(agentDir, { recursive: true });
const loader = new DefaultResourceLoader({
  cwd: agentDir,
  agentDir,
  settingsManager: SettingsManager.inMemory({}),
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  additionalExtensionPaths: [candidate],
});
await loader.reload();
const loaded = loader.getExtensions();
try {
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 3);
  assert.ok(loaded.extensions.some((extension) => extension.tools.has("artifact_create")));
  assert.ok(loaded.extensions.some((extension) => extension.commands.has("plan")));
  const shortcuts = loaded.extensions.flatMap((extension) => [...extension.shortcuts.keys()]);
  assert.ok(shortcuts.includes("alt+,"));
  assert.ok(shortcuts.includes("alt+."));
} finally {
  loaded.runtime.invalidate("packaging discovery complete");
}

// Load the real lazy UI via Pi's Jiti mapping, never native-import it against
// physical host packages in the candidate. Test source and package-directory output.
const chunk = (await readdir(join(candidate, "packages/pi-plan-mode/dist/chunks"))).find((name) =>
  /^interactive-ui-.*\.ts$/u.test(name),
);
assert.ok(chunk, "Missing generated lazy UI chunk");
const probe = join(candidate, ".packaging-probe.ts");
await writeFile(
  probe,
  `
import assert from "node:assert/strict";
export default async function () {
  const source = await import("./packages/pi-plan-mode/src/interactive-ui.ts");
  const generated = await import(${JSON.stringify(`./packages/pi-plan-mode/dist/chunks/${chunk}`)});
  for (const ui of [source, generated]) await (${exerciseUi.toString()})(ui, assert);
}
`,
);
const probeLoader = new DefaultResourceLoader({
  cwd: agentDir,
  agentDir,
  settingsManager: SettingsManager.inMemory({}),
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  additionalExtensionPaths: [probe, join(candidate, "packages/pi-plan-mode"), join(candidate, "packages/pi-artifacts")],
});
try {
  await probeLoader.reload();
  const result = probeLoader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 3);
  assert.ok(result.extensions.some((extension) => extension.commands.has("plan")));
  assert.ok(result.extensions.some((extension) => extension.tools.has("artifact_update")));
} finally {
  probeLoader.getExtensions().runtime.invalidate("packaging UI complete");
  await rm(probe, { force: true });
}
console.log("Pi 1.5.0: all three extensions, package runtime, and lazy Plan UI/TUI Kit rendered successfully.");

async function exerciseUi(ui, assert) {
  let frames = 0;
  const theme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    underline: (text) => text,
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
      notify(message) {
        throw new Error(message);
      },
      async custom(factory) {
        const component = await factory(
          { terminal: { rows: 24 }, requestRender() {} },
          theme,
          { matches: () => false, getKeys: () => [] },
          () => {},
        );
        try {
          assert.ok(component.render(80).length > 0);
          frames++;
          return undefined; // Dismiss without a user action or model request.
        } finally {
          component.dispose?.();
        }
      },
    },
  };
  const lifecycle = { signal: new AbortController().signal, isCurrent: () => true };
  const revision = { title: "Packaging", path: "/unused/plan.md", series: "packaging", revision: 1 };
  await ui.reviewPlan(ctx, "# Packaging\n\nRuntime review", revision, lifecycle);
  await ui.selectSavedPlan(ctx, [revision], lifecycle);
  assert.equal(frames, 2, "Both document review and lazy menu must render");
}
