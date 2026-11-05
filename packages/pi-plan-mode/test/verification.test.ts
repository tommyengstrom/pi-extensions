import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterAll, test, vi } from "vitest";
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
const { AgentSession, ModelRuntime, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
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
  options: {
    badTool?: boolean;
    cancel?: boolean;
    invalid?: boolean;
    tools?: string[];
    firstTool?: string;
    stopReason?: "error" | "aborted" | "length";
    errorMessage?: string;
    repeatTools?: boolean;
    toolsPerTurn?: number;
    reportText?: string;
  } = {},
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
    const tool =
      options.repeatTools ||
      (requests.length === 1 && options.stopReason !== "error" && options.stopReason !== "aborted");
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: tool
        ? Array.from(
            { length: options.toolsPerTurn ?? 1 },
            (_, index): ToolCall => ({
              type: "toolCall" as const,
              id: `inspect-${requests.length}-${index}`,
              name: options.badTool ? "write" : (options.firstTool ?? "read"),
              arguments: options.badTool ? { path: join(cwd, "should-not-exist"), content: "bad" } : { path },
            }),
          )
        : [{ type: "text", text: options.reportText ?? (options.invalid ? "not JSON" : JSON.stringify(report)) }],
      stopReason: tool ? "toolUse" : (options.stopReason ?? "stop"),
      errorMessage: options.errorMessage,
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
    if (options.cancel) controller.abort(new Error("User cancelled the check"));
    if (message.stopReason === "error" || message.stopReason === "aborted")
      stream.push({ type: "error", reason: message.stopReason, error: message });
    else
      stream.push({
        type: "done",
        reason: tool ? "toolUse" : options.stopReason === "length" ? "length" : "stop",
        message,
      });
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

test("provider failures retain bounded safe error details, model, stage, and stop reason", async () => {
  const f = await fixture({
    stopReason: "error",
    errorMessage: `HTTP 429: rate limit\u001b[31m\nRetry after 30s ${"x".repeat(3000)}`,
  });
  await assert.rejects(runVerification(f), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /failed while running checker/);
    assert.match(error.message, /model: plan-check-offline\/checker/);
    assert.match(error.message, /turns started: 1\/60/);
    assert.match(error.message, /last stop reason: error/);
    assert.match(error.message, /HTTP 429: rate limit/);
    assert.match(error.message, /Retry after 30s/);
    assert.match(error.message, /truncated/);
    assert.ok(!error.message.includes("\u001b"));
    assert.ok(error.message.length < 3000);
    assert.ok(error.cause instanceof Error);
    return true;
  });
  for (const path of f.artifacts) await assert.rejects(stat(path), /ENOENT/);
  const noDetail = await fixture({ stopReason: "error" });
  await assert.rejects(runVerification(noDetail), /provider supplied no error detail/);
});

test("caller cancellation and provider aborts have distinct diagnostics", async () => {
  const cancelled = await fixture({ cancel: true });
  await assert.rejects(runVerification(cancelled), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    assert.match(error.message, /cancelled by its caller: User cancelled the check/);
    return true;
  });
  const aborted = await fixture({ stopReason: "aborted", errorMessage: "Upstream request interrupted" });
  await assert.rejects(
    runVerification(aborted),
    /aborted response, without a parent cancellation: Upstream request interrupted/,
  );
  for (const path of [...cancelled.artifacts, ...aborted.artifacts]) await assert.rejects(stat(path), /ENOENT/);
});

test("turn and tool-call limits report the limit instead of an incidental abort or invalid JSON", async () => {
  for (const [toolsPerTurn, limit] of [
    [1, "60-turn"],
    [5, "200-tool-call"],
  ] as const) {
    const f = await fixture({ repeatTools: true, toolsPerTurn });
    await assert.rejects(runVerification(f), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`exceeded the ${limit} limit`));
      assert.match(error.message, /last inspection tool: read/);
      assert.match(error.message, /choose a different checker model/);
      return true;
    });
    for (const path of f.artifacts) await assert.rejects(stat(path), /ENOENT/);
  }
});

test("report failures distinguish empty, invalid JSON, schema, and output-token truncation without leaking text", async () => {
  for (const [options, expected] of [
    [{ reportText: "" }, /returned no report text/],
    [{ reportText: "PRIVATE_TRANSCRIPT_EVIDENCE not JSON" }, /did not return valid JSON/],
    [{ reportText: '{"summary":"PRIVATE_TRANSCRIPT_EVIDENCE"}' }, /Invalid adherence report schema/],
    [{ stopReason: "length", reportText: '{"summary":"PRIVATE_TRANSCRIPT_EVIDENCE' }, /output-token limit/],
  ] as const) {
    const f = await fixture(options);
    await assert.rejects(runVerification(f), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /validating checker report/);
      assert.match(error.message, expected);
      assert.match(error.message, /Report length: \d+ characters/);
      assert.ok(!error.message.includes("PRIVATE_TRANSCRIPT_EVIDENCE"));
      return true;
    });
    for (const path of f.artifacts) await assert.rejects(stat(path), /ENOENT/);
  }
});

test("missing assistant messages and rejected prompt calls retain distinct causes", async () => {
  const f = await fixture();
  const prompt = vi.spyOn(AgentSession.prototype, "prompt");
  try {
    prompt.mockResolvedValueOnce(undefined);
    await assert.rejects(runVerification(f), /last stop reason: none.*produced no assistant response/);
    prompt.mockRejectedValueOnce(new Error("Connection refused by proxy"));
    await assert.rejects(runVerification(f), /running checker.*Connection refused by proxy/);
  } finally {
    prompt.mockRestore();
  }
});

test("tool-source loading failures identify the failing extension and underlying error", async () => {
  const f = await fixture();
  const path = join(f.cwd, "broken-inspection.ts");
  await writeFile(path, 'throw new Error("Inspection configuration missing");');
  f.implementation.toolIdentities.push({ name: "inspect", source: "extension", path, exposure: "direct" });
  await assert.rejects(runVerification(f), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /loading inspection tool sources/);
    assert.match(error.message, /broken-inspection\.ts/);
    assert.match(error.message, /Inspection configuration missing/);
    assert.match(error.message, /turns started: 0\/60/);
    return true;
  });
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
