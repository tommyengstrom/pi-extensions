import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterAll, test } from "vitest";
import type { VerificationReport } from "../src/verification.js";

// Initialize before any Pi/extension imports.
const root = mkdtempSync(join(tmpdir(), "plan-verification-test-"));
const agentDir = join(root, "agent");
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
afterAll(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const { ModelRuntime, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } = await import(
  "@earendil-works/pi-ai"
);
const { createMockContext } = await import("./support.js");
const { createImplementation, snapshot } = await import("../src/implementation-state.js");
const { runVerification, parseVerificationReport } = await import("../src/verification.js");
const { implementationTranscript } = await import("../src/implementation-transcript.js");

const report: VerificationReport = {
  status: "adherent",
  summary: "The requirement is implemented.",
  requirements: [{ requirement: "Use blue", revision: "2", status: "implemented", evidence: "color.ts:1" }],
  changes: [],
  deviations: [],
  limitations: [],
};

async function fixture(
  options: { badTool?: boolean; cancel?: boolean; invalid?: boolean; tools?: string[]; firstTool?: string } = {},
) {
  const cwd = join(root, `project-${Math.random()}`);
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(cwd, "AGENTS.md"), "Project rule: preserve color compatibility.");
  await writeFile(join(cwd, "color.ts"), 'export const color = "blue";');
  const requests: Message[][] = [];
  const artifacts: string[] = [];
  const controller = new AbortController();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const streamSimple: NonNullable<ProviderConfig["streamSimple"]> = (model, context) => {
    requests.push(structuredClone(context.messages));
    const user = context.messages.find((item) => item.role === "user");
    const text = user
      ? typeof user.content === "string"
        ? user.content
        : user.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
      : "";
    const path = /Path: (.+implementation\.md)/.exec(text)?.[1];
    assert.ok(path);
    if (requests.length === 1) artifacts.push(path);
    const tool = requests.length === 1;
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: tool
        ? [
            {
              type: "toolCall",
              id: "inspect",
              name: options.badTool ? "write" : (options.firstTool ?? "read"),
              arguments: options.badTool ? { path: join(cwd, "should-not-exist"), content: "bad" } : { path },
            },
          ]
        : [{ type: "text", text: options.invalid ? "not JSON" : JSON.stringify(report) }],
      stopReason: tool ? "toolUse" : "stop",
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    if (options.cancel) controller.abort();
    stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
    stream.end();
    return stream;
  };
  modelRuntime.registerProvider("plan-check-offline", {
    api: "openai-completions",
    apiKey: "offline",
    baseUrl: "https://offline.invalid",
    streamSimple,
    models: [
      {
        id: "checker",
        name: "Checker",
        reasoning: false,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const model = modelRuntime.getModel("plan-check-offline", "checker");
  assert.ok(model);
  const { ctx } = createMockContext({ cwd, hasUI: false, model, modelRegistry: new ModelRegistry(modelRuntime) });
  Object.assign(ctx, { isProjectTrusted: () => true, thinkingLevel: "off" });
  const implementation = createImplementation(
    {
      projectRoot: cwd,
      plansDirectory: "plans",
      previousTools: ["read", "write"],
      toolIdentities: (options.tools ?? ["read", "grep", "find", "ls"]).map((name) => ({
        name,
        source: "builtin",
        path: `builtin:${name}`,
        exposure: "direct",
      })),
    },
    snapshot({ series: "colors", revision: 1, path: join(cwd, "plan.md"), title: "Colors" }, "# Colors\n\nUse blue."),
  );
  const transcript = implementationTranscript(
    [
      { type: "custom", customType: "pi-plan-implementation", data: { id: implementation.id, phase: "implementing" } },
      { id: "request", type: "message", message: { role: "user", content: "Please use blue." } },
      {
        id: "rationale",
        type: "message",
        message: { role: "assistant", content: "TRANSCRIPT ONLY RATIONALE — changed color because requested." },
      },
    ],
    implementation.id,
  );
  return {
    ctx: ctx as ExtensionContext,
    cwd,
    implementation,
    transcript,
    signal: controller.signal,
    requests,
    artifacts,
    settings: { automatic: true },
    streamSimple,
  };
}

test("real fresh SDK checker delegates current provider, loads project instructions and reads transcript on demand", async () => {
  const f = await fixture();
  const result = await runVerification(f);
  assert.equal(result.report.status, "adherent");
  assert.equal(result.model.provider, "plan-check-offline");
  assert.equal(result.usage?.totalTokens, 4);
  assert.equal(f.requests.length, 2);
  const first = JSON.stringify(f.requests[0]);
  assert.ok(first.includes("Please use blue."));
  assert.equal(first.includes("TRANSCRIPT ONLY RATIONALE"), false);
  assert.match(getCurrentSystemPrompt(f.requests[0]), /Project rule: preserve color compatibility/);
  assert.deepEqual(
    getCurrentTools(f.requests[0])
      .map((tool) => tool.name)
      .sort(),
    ["find", "grep", "ls", "read"],
  );
  assert.ok(JSON.stringify(f.requests[1]).includes("TRANSCRIPT ONLY RATIONALE"));
  await assert.rejects(stat(f.artifacts[0]), /ENOENT/);
  assert.equal(await readFile(join(f.cwd, "color.ts"), "utf8"), 'export const color = "blue";');
});

test("unselected mutation tools cannot execute and errors cannot produce an adherent verdict", async () => {
  const f = await fixture({ badTool: true });
  const result = await runVerification(f);
  assert.equal(result.report.status, "inconclusive");
  await assert.rejects(stat(join(f.cwd, "should-not-exist")), /ENOENT/);
});

test("an explicit checker model uses its configured provider without changing the main model", async () => {
  const f = await fixture();
  const main = f.ctx.model;
  assert.ok(main);
  f.ctx.modelRegistry.registerProvider("other-offline", {
    api: main.api,
    apiKey: "offline",
    baseUrl: "https://offline.invalid",
    streamSimple: f.streamSimple,
    models: [{ ...main, id: "other" }],
  });
  const result = await runVerification({
    ...f,
    settings: { automatic: true, model: { provider: "other-offline", id: "other" } },
  });
  assert.deepEqual(result.model, { provider: "other-offline", id: "other" });
  assert.equal(f.ctx.model, main);
});

test("invalid output and cancellation clean up transcript artifacts", async () => {
  for (const options of [{ invalid: true }, { cancel: true }]) {
    const f = await fixture(options);
    await assert.rejects(runVerification(f));
    for (const path of f.artifacts) await assert.rejects(stat(path), /ENOENT/);
  }
});

test("missing transcript access and unknown explicit models fail without fallback", async () => {
  const f = await fixture({ tools: ["grep"] });
  await assert.rejects(runVerification(f), /requires the planning read tool/);
  await assert.rejects(
    runVerification({ ...f, settings: { automatic: true, model: { provider: "missing", id: "missing" } } }),
    /model is unavailable/,
  );
  assert.equal(f.requests.length, 0);
});

test("reconstructed model-only orchestrators retain deferred callees and nested permission checks", async () => {
  for (const forbidden of [false, true]) {
    const f = await fixture({ firstTool: "inspect_router" });
    const extension = join(f.cwd, "inspection-extension.ts");
    await writeFile(
      extension,
      `export default function(pi) {
      pi.registerTool({ name: "inspect_router", label: "Router", description: "Inspect", exposure: "model-only", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        async execute(id, args, signal, update, ctx) { return ctx.executeTool("inspect_deferred", args, {signal}); } });
      pi.registerTool({ name: "inspect_deferred", label: "Deferred", description: "Inspect", exposure: "deferred", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        async execute(id, args, signal, update, ctx) { return ctx.executeTool(${JSON.stringify(forbidden ? "write" : "read")}, ${forbidden ? `{path: ${JSON.stringify(join(f.cwd, "must-not-exist"))}, content: "bad"}` : "args"}, {signal}); } });
    }`,
    );
    f.implementation.toolIdentities.push(
      { name: "inspect_router", source: "extension", path: extension, exposure: "model-only" },
      { name: "inspect_deferred", source: "extension", path: extension, exposure: "deferred" },
    );
    const result = await runVerification(f);
    assert.equal(result.report.status, forbidden ? "inconclusive" : "adherent");
    const declared = getCurrentTools(f.requests[0]).map((tool) => tool.name);
    assert.ok(declared.includes("inspect_router"));
    assert.equal(declared.includes("inspect_deferred"), false);
    await assert.rejects(stat(join(f.cwd, "must-not-exist")), /ENOENT/);
  }
});

test("report validation rejects contradictory passes and distinguishes plan-update failures", () => {
  assert.throws(
    () => parseVerificationReport(JSON.stringify({ ...report, limitations: ["Missing history"] })),
    /adherent report/,
  );
  const deviation = {
    deviation: "Unrecorded user change",
    kind: "plan_update",
    rationale: "User requested blue",
    authorization: "request",
    evidence: "color.ts:1",
  };
  assert.equal(
    parseVerificationReport(JSON.stringify({ ...report, status: "deviations_found", deviations: [deviation] }))
      .deviations[0].kind,
    "plan_update",
  );
});
