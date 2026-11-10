import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, test, vi } from "vitest";
import {
  fallbackPlanName,
  MAX_NAME_TASK_CHARS,
  NAMING_INSTRUCTIONS,
  requestPlanName,
  validPlanName,
} from "../src/plan-name.js";

function registry(output = "support-uploading-images", reasoning = false, thinkingLevelMap = {}) {
  const model = { provider: "test", id: "model", reasoning, thinkingLevelMap };
  const find = vi.fn(() => model);
  const result = vi.fn(async () => ({ stopReason: "stop", content: [{ type: "text", text: output }] }));
  const streamSimple = vi.fn(() => ({ result }));
  return {
    find,
    result,
    streamSimple,
    value: { find, streamSimple } as unknown as ExtensionContext["modelRegistry"],
  };
}
afterEach(() => vi.useRealTimers());

test("naming sends only the bounded initial task and fixed instructions, without tools", async () => {
  const fake = registry();
  const task = `Support uploading images ${"x".repeat(8000)}`;
  assert.equal(await requestPlanName(fake.value, task, {}, new AbortController().signal), "support-uploading-images");
  assert.deepEqual(fake.find.mock.calls, [["openai", "gpt-6-luna"]]);
  const [, context, options] = fake.streamSimple.mock.calls[0] as unknown as [
    unknown,
    Record<string, unknown>,
    Record<string, unknown>,
  ];
  assert.deepEqual(Object.keys(context).sort(), ["messages", "systemPrompt"]);
  assert.equal(context.systemPrompt, NAMING_INSTRUCTIONS);
  const messages = context.messages as Array<{ content: string; role: string }>;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content, task.slice(0, MAX_NAME_TASK_CHARS));
  assert.equal(options.maxTokens, 128);
  assert.equal(options.reasoning, undefined);
});

test("naming uses the lowest supported reasoning level", async () => {
  const fake = registry("name", true, { off: null, minimal: null });
  await requestPlanName(fake.value, "task", {}, new AbortController().signal);
  const options = (fake.streamSimple.mock.calls[0] as unknown as [unknown, unknown, { reasoning: string }])[2];
  assert.equal(options.reasoning, "low");
});

test("naming follows progress model unless independently overridden", async () => {
  const fake = registry();
  const progress = { model: { provider: "progress", id: "observer" } };
  await requestPlanName(fake.value, "task", { progress }, new AbortController().signal);
  assert.deepEqual(fake.find.mock.calls.at(-1), ["progress", "observer"]);
  await requestPlanName(
    fake.value,
    "task",
    { progress, naming: { model: { provider: "naming", id: "small" } } },
    new AbortController().signal,
  );
  assert.deepEqual(fake.find.mock.calls.at(-1), ["naming", "small"]);
});

test.each(["../escape", "Name", "a.md", "a--b", "", "a".repeat(65), "name\nexplanation", "\u001b[31mname"])(
  "invalid returned stem falls back: %j",
  async (output) => {
    const fake = registry(output);
    assert.equal(
      await requestPlanName(fake.value, "Support uploading images!", {}, new AbortController().signal),
      "support-uploading-images",
    );
  },
);

test("fallback is deterministic, bounded, normalized and never empty", () => {
  for (const task of ["", "你好", "Résumé — upload images", "x".repeat(10000), "../a\u0000b", "one ".repeat(1000)]) {
    assert.ok(validPlanName(fallbackPlanName(task)));
    assert.equal(fallbackPlanName(task), fallbackPlanName(task));
  }
  assert.equal(fallbackPlanName("Résumé — upload images"), "resume-upload-images");
});

test("provider setup and authentication failures fall back without exposing diagnostics", async () => {
  const fake = registry();
  fake.result.mockRejectedValue(new Error("credential failure"));
  assert.equal(await requestPlanName(fake.value, "Initial task", {}, new AbortController().signal), "initial-task");
  fake.find.mockImplementation(() => {
    throw new Error("unavailable model");
  });
  assert.equal(await requestPlanName(fake.value, "Initial task", {}, new AbortController().signal), "initial-task");
});

test("cancellation settles even if the provider ignores its signal", async () => {
  const fake = registry();
  fake.result.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = requestPlanName(fake.value, "Initial task", {}, controller.signal);
  controller.abort();
  assert.equal(await pending, "initial-task");
});

test("deadline settles and aborts a nonresponsive provider", async () => {
  vi.useFakeTimers();
  const fake = registry();
  fake.result.mockImplementation(() => new Promise(() => {}));
  const pending = requestPlanName(fake.value, "Initial task", {}, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(10000);
  assert.equal(await pending, "initial-task");
  const options = (fake.streamSimple.mock.calls[0] as unknown as [unknown, unknown, { signal: AbortSignal }])[2];
  assert.ok(options.signal.aborted);
  assert.equal(vi.getTimerCount(), 0);
});
