// Copied into a separate npm-installed Pi host by scripts/test-packaging.mjs.
import assert from "node:assert/strict";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  assert.equal(loaded.extensions.length, 4);
  assert.ok(loaded.extensions.some((extension) => extension.tools.has("artifact_create")));
  assert.ok(loaded.extensions.some((extension) => extension.commands.has("plan")));
  const herdr = loaded.extensions.find((extension) => extension.commands.has("subagent"));
  assert.ok(herdr);
  for (const name of ["subagent", "subagent_query", "subagent_wait", "subagent_cancel"])
    assert.ok(herdr.tools.has(name));
  assert.equal(herdr.tools.has("subagent_steer"), false);
  await access(join(candidate, "packages/pi-herdr-core/src/worker-guard.ts"));
  const shortcuts = loaded.extensions.flatMap((extension) => [...extension.shortcuts.keys()]);
  assert.ok(shortcuts.includes("alt+,"));
  assert.ok(shortcuts.includes("alt+."));
  await assert.rejects(access(join(agentDir, "pi-herdr-core")), "Mere loading must not create job storage");
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
import {execFileSync} from "node:child_process";
import {resolvePiCli} from "./packages/pi-herdr-core/src/runtime-resolution.ts";
import workerGuard from "./packages/pi-herdr-core/src/worker-guard.ts";
export default async function () {
  assert.equal(typeof workerGuard, 'function');
  const cli = await resolvePiCli(${JSON.stringify(fileURLToPath(new URL("./node_modules/.bin/pi", import.meta.url)))});
  assert.match(execFileSync(process.execPath,[cli,'--version'],{ encoding:'utf8' }), /1\\.5\\.1/);
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
  // Reverse relative extension load order from the root manifest.
  additionalExtensionPaths: [
    probe,
    join(candidate, "packages/pi-herdr-core"),
    join(candidate, "packages/pi-artifacts"),
    join(candidate, "packages/pi-plan-mode"),
  ],
});
try {
  await probeLoader.reload();
  const result = probeLoader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 4);
  assert.ok(result.extensions.some((extension) => extension.commands.has("plan")));
  assert.ok(result.extensions.some((extension) => extension.tools.has("artifact_update")));
  assert.ok(result.extensions.some((extension) => extension.tools.has("subagent_wait")));
} finally {
  probeLoader.getExtensions().runtime.invalidate("packaging UI complete");
  await rm(probe, { force: true });
}
console.log(
  "Pi 1.5.1: all four extensions, worker source, package runtime, and lazy Plan UI/TUI Kit rendered successfully.",
);

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
          return undefined;
        } finally {
          component.dispose?.();
        }
      },
    },
  };
  const lifecycle = { signal: new AbortController().signal, isCurrent: () => true };
  const revision = { id: "packaging", name: "packaging", title: "Packaging", path: "/unused/plan.md" };
  await ui.reviewPlan(ctx, "# Packaging\n\nRuntime review", revision, lifecycle);
  await ui.selectSavedPlan(ctx, [revision], lifecycle);
  assert.equal(frames, 2, "Both document review and lazy menu must render");
}
