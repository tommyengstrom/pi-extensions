import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMermaidMarkdownTransformer, prepareMermaidMarkdownRenderer } from "../src/markdown.js";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};

const finalAssistant = {
  messageType: "assistant" as const,
  isStreaming: false,
  availableWidth: 80,
};

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: Date.now(),
    api: "anthropic-messages",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test("public Mermaid preparation ignores Markdown without a top-level fence", () => {
  assert.equal(prepareMermaidMarkdownRenderer("# Formula\n\n$x^2$"), undefined);
  assert.equal(
    prepareMermaidMarkdownRenderer("````markdown\n```mermaid\nflowchart LR\n A --> B\n```\n````"),
    undefined,
  );
});

test("public Mermaid transformer renders finalized messages and reflows by width", async () => {
  const source = "Before\n\n```mermaid\nflowchart LR\n A --> B\n```\n\nAfter";
  await prepareMermaidMarkdownRenderer(source);
  const transform = createMermaidMarkdownTransformer(theme);
  assert.ok(transform);

  const wide = transform(source, finalAssistant);
  assert.match(wide, /[┌╭].*[┐╮]/u);
  assert.doesNotMatch(wide, /flowchart LR/u);
  assert.match(wide, /Before/u);
  assert.match(wide, /After/u);

  const narrow = transform(source, { ...finalAssistant, availableWidth: 5 });
  assert.match(narrow, /```mermaid/u);
  assert.match(narrow, /flowchart LR/u);

  const user = transform(source, { messageType: "user", isStreaming: false, availableWidth: 80 });
  assert.match(user, /[┌╭].*[┐╮]/u);

  assert.equal(transform(source, { ...finalAssistant, isStreaming: true }), source);
  assert.equal(transform(source, { ...finalAssistant, messageType: "assistant-thinking" }), source);
});

test("public Mermaid transformer composes with Pi assistant rendering and remains width-safe", async () => {
  initTheme("dark", false);
  const source = "```mermaid\nflowchart LR\n A --> B\n```";
  await prepareMermaidMarkdownRenderer(source);
  const transform = createMermaidMarkdownTransformer(theme);
  assert.ok(transform);
  const component = new AssistantMessageComponent(assistantMessage(source), true, getMarkdownTheme(), "", 1, [
    transform,
  ]);

  const narrow = component.render(8);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 8));
  assert.match(stripVTControlCharacters(narrow.join("\n")), /flowch[\s\S]*art LR/u);
  const wide = component.render(80);
  assert.ok(wide.every((line) => visibleWidth(line) <= 80));
  assert.match(stripVTControlCharacters(wide.join("\n")), /[┌╭].*[┐╮]/u);
});

test("public Mermaid transformer keeps safe source for warnings and strips terminal controls", async () => {
  const malformed = "```mermaid\nflowchart LR\n A[Start --> B\n```";
  await prepareMermaidMarkdownRenderer(malformed);
  const transform = createMermaidMarkdownTransformer(theme);
  assert.ok(transform);

  const warning = transform(malformed, finalAssistant);
  assert.match(warning, /flowchart LR/u);
  assert.match(warning, /Mermaid diagram not rendered:/u);

  const unsafe = "```mermaid\nflowchart LR\n A[unsafe\u001b]8;;https://unsafe.example\u0007text] --> B\n```";
  const rendered = transform(unsafe, finalAssistant);
  assert.equal(rendered.includes("\u001b"), false);
  assert.equal(rendered.includes("\u0007"), false);
  assert.doesNotMatch(rendered, /https:\/\/unsafe\.example/u);
  assert.match(rendered, /unsafetext/u);
});
