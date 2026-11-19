import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ThinkingContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { groups } from "../src/model.js";

const settings = { size: 3, thinking: true };
const assistant = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage => ({
  role: "assistant",
  content,
  stopReason,
  timestamp: 1,
  api: "openai-responses",
  provider: "openai",
  model: "test",
  usage: {
    input: 0,
    output: 0,
    totalTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const call = (id: string, name = "read", args: ToolCall["arguments"] = {}): ToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
const thought = (thinking: string, redacted = false): ThinkingContent => ({
  type: "thinking",
  thinking,
  redacted,
  thinkingSignature: "SECRET",
});
const result = (toolCallId: string, isError = false): ToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName: "read",
  isError,
  timestamp: 2,
  content: [{ type: "text", text: "SECRET output" }],
});

const a = call("a", "grep");
const b = call("b", "read", { path: "src/settings.ts" });
const t = thought("Compare defaults");

describe("ordered branch replay", () => {
  it("publishes at capacity, before any results arrive", () => {
    expect(groups([assistant([t, a, b])], settings, true)).toEqual([
      {
        items: [
          { description: "Thinking: Compare defaults", status: "done" },
          { description: "Search contents", status: "running" },
          { description: "Read src/settings.ts", status: "running" },
        ],
        pending: false,
        headline: "1 thought, 1 search, 1 read · 2 running",
      },
    ]);
  });

  it.each([
    { size: 1, thinking: true, lengths: [1, 1, 1], pending: false },
    { size: 2, thinking: true, lengths: [2, 1], pending: true },
    { size: 4, thinking: true, lengths: [3], pending: true },
    { size: 4, thinking: false, lengths: [1, 1], pending: true },
  ])("regroups the same history with size=$size thinking=$thinking", ({ size, thinking, lengths, pending }) => {
    const digest = groups([assistant([a, t, b])], { size, thinking }, true);
    expect(digest.map((g) => g.items.length)).toEqual(lengths);
    expect(digest.map((g) => g.pending)).toEqual(lengths.map((_, i) => pending && i === lengths.length - 1));
  });

  it("splits at prose and user messages, not at result messages or loop turns", () => {
    const messages: AgentMessage[] = [
      assistant([a]),
      result("a"),
      assistant([b, { type: "text", text: "Next" }, call("c")]),
      { role: "user", content: "Follow-up", timestamp: 4 },
      assistant([call("d")]),
    ];
    const digest = groups(messages, settings, true);
    expect(digest.map((g) => [g.items.length, g.pending])).toEqual([
      [2, false],
      [1, false],
      [1, true],
    ]);
  });

  it.each(["stop", "length", "aborted", "error"] as const)("closes a short group on %s", (reason) => {
    expect(groups([assistant([t], reason)], settings, true)[0]).toMatchObject({
      pending: false,
      headline: "Thinking: Compare defaults",
    });
  });

  it("closes at end offsets including EOF; late results still address the original item", () => {
    const messages = [assistant([a, b]), assistant([call("c")]), result("b", true), result("a")];
    const digest = groups(messages, settings, true, new Set([0, 1, messages.length]));
    expect(digest.map((g) => [g.pending, g.items.map((i) => i.status)])).toEqual([
      [false, ["done", "failed"]],
      [false, ["failed"]],
    ]);
    expect(digest[0]?.headline).toBe("1 search, 1 read · 1 failed");
    expect(groups(messages, settings, false, new Set([1]))).toEqual(digest);
  });

  it("ignores nested execution records and unmatched results", () => {
    const nested = {
      ...result("a"),
      nestedCalls: { complete: true, calls: [{ id: "nested", name: "bash", status: "error" as const }] },
    };
    const digest = groups([result("orphan"), assistant([a]), nested, result("nested", true)], settings, false);
    expect(digest).toEqual([
      { items: [{ description: "Search contents", status: "done" }], pending: false, headline: "Search contents" },
    ]);
  });

  it("rebuilds from replacement stream snapshots rather than accumulating deltas", () => {
    const partial = (text: string) => [assistant([thought(text)], "pending")];
    expect(groups(partial("Com"), settings, true)[0]?.pending).toBe(true);
    expect(groups(partial("Compare"), settings, true)[0]?.items).toEqual([
      { description: "Thinking: Compare", status: "done" },
    ]);
    const complete = [assistant([thought("Compare")], "stop")];
    expect(groups(complete, settings, true)).toEqual(groups(complete, settings, false));
  });
});

describe("local display policy", () => {
  it.each([true, false])(
    "ignores unavailable and redacted content without making a boundary (thinking=%s)",
    (thinking) => {
      const hidden = [thought("SECRET", true), thought(""), thought(" \n ")];
      expect(groups([assistant(hidden)], { size: 3, thinking }, false)).toEqual([]);
      const digest = groups([assistant([a, ...hidden, b])], { size: 3, thinking }, false);
      expect(digest).toHaveLength(1);
      expect(digest[0]?.items).toHaveLength(2);
      expect(JSON.stringify(digest)).not.toContain("SECRET");
    },
  );

  it("uses bounded single-line previews; omits arbitrary names, arguments, and raw outputs", () => {
    const controls = "\x1b]0;SECRET\x07\x1b[31m\u202e";
    const messages = [
      assistant([
        call("a", `${controls}unknown`, { payload: "SECRET" }),
        call("b", "bash", { command: "SECRET" }),
        call("c", "write", { path: `${controls}src/\n${"x".repeat(1000)}`, content: "SECRET" }),
        thought(`${controls}OK`),
      ]),
      result("c"),
    ];
    const digest = groups(messages, settings, false);
    const descriptions = digest.flatMap((g) => g.items.map((i) => i.description));
    expect(descriptions).toEqual([
      "Tool call",
      "Run command",
      expect.stringMatching(/^Write src\/ x+…$/u),
      "Thinking: OK",
    ]);
    expect(descriptions.every((d) => d.length <= 80)).toBe(true);
    expect(JSON.stringify(digest)).not.toContain("SECRET");
  });
});
