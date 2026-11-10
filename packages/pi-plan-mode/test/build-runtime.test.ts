import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { listFiles, registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-plan-mode",
  forbiddenEagerInputs: ["src/interactive-ui.ts"],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
  allowedEagerExternals: [
    "@narumitw/pi-tui-kit/terminal-text",
    "@narumitw/pi-tui-kit/terminal-document",
    "@narumitw/pi-tui-kit/key-matching",
  ],
});

test("generated interactive UI is loadable and keeps TUI Kit external", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-plan-mode-build-test-"));
  try {
    const output = join(root, "dist");
    const metadata = await builder.buildRuntime({ outputDirectory: output });
    const interactiveUiPath = (await listFiles(output)).find((path) =>
      /^chunks\/interactive-ui-[A-Z0-9]+\.ts$/u.test(path),
    );
    assert.ok(interactiveUiPath);
    const interactiveUi = await import(
      `${pathToFileURL(join(output, interactiveUiPath)).href}?test=${crypto.randomUUID()}`
    );
    assert.equal(typeof interactiveUi.reviewPlan, "function");
    const kitImports = Object.values(metadata.outputs ?? {})
      .flatMap((chunk) => chunk.imports ?? [])
      .filter(
        (imported) => imported.path === "@narumitw/pi-tui-kit" || imported.path.startsWith("@narumitw/pi-tui-kit/"),
      );
    assert.ok(kitImports.length > 0);
    assert.ok(kitImports.every((imported) => imported.external));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("generated entrypoint loads through Pi Jiti and runs in a real AgentSession", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-plan-mode-build-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  try {
    const {
      createAgentSession,
      DefaultResourceLoader,
      ExtensionRunner,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = await import("@earendil-works/pi-coding-agent");
    const output = join(root, "dist");
    await builder.buildRuntime({ outputDirectory: output });
    await mkdir(agentDir, { recursive: true });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [join(output, "index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    ({ session } = await createAgentSession({
      cwd: root,
      agentDir,
      settingsManager,
      modelRuntime,
      sessionManager: SessionManager.inMemory(root),
      resourceLoader: loader,
    }));
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    const runner = session.extensionRunner;
    assert.ok(runner instanceof ExtensionRunner);
    assert.ok(runner.getCommand("plan"));
    assert.equal(runner.hasHandlers("context"), false);
    assert.equal(runner.hasHandlers("context_with_system"), false);
    for (const name of ["plan_mode_question", "plan_mode_complete", "plan_mode_edit"]) {
      assert.equal(runner.getToolDefinition(name)?.defaultActive, false);
      assert.equal(session.getActiveToolNames().includes(name), false);
    }
    const previousTools = session.getActiveToolNames();
    await session.prompt("/plan start");
    assert.deepEqual(
      new Set(session.getActiveToolNames()),
      new Set(["read", "grep", "find", "ls", "plan_mode_question", "plan_mode_complete", "plan_mode_edit"]),
    );
    const complete = runner.getToolDefinition("plan_mode_complete");
    assert.ok(complete);
    const signal = new AbortController().signal;
    const plan = "# Generated runtime\n\nImplement the generated-runtime fix.";
    const result = await complete.execute(
      "complete-generated-plan",
      { plan },
      signal,
      undefined,
      runner.createToolContext("complete-generated-plan", signal),
    );
    assert.equal(result.terminate, true);
    const files = (await listFiles(join(agentDir, "pi-plan-mode"))).filter((path) => path.endsWith(".md"));
    assert.equal(files.length, 1);
    const savedFile = files[0];
    assert.ok(savedFile);
    assert.match(savedFile, /\/untitled-plan\.md$/u);
    const savedPath = join(agentDir, "pi-plan-mode", savedFile);
    const saved = await readFile(savedPath, "utf8");
    assert.match(saved, /^<!-- pi-plan-document-v3:/);
    assert.equal(saved.slice(saved.indexOf(" -->\n") + 5), plan);
    const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    assert.ok(text.includes(plan));
    assert.ok(text.includes(savedPath));
    await session.prompt("/plan exit");
    assert.deepEqual(session.getActiveToolNames(), previousTools);
    assert.deepEqual(errors, []);
  } finally {
    try {
      if (session) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { force: true, recursive: true });
    }
  }
});
