import assert from "node:assert/strict";
import { test, vi } from "vitest";

const loader = vi.hoisted(() => ({ calls: 0 }));

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return { ...actual, Marked: undefined };
});

vi.mock("grok-mermaid", () => {
  loader.calls += 1;
  return { render: () => null };
});

import { createMermaidMarkdownTransformer, prepareMermaidMarkdownRenderer } from "../src/markdown.js";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};

test("public Mermaid helpers degrade when rich Markdown is unavailable", () => {
  const source = "```mermaid\nflowchart LR\n A --> B\n```";
  assert.equal(prepareMermaidMarkdownRenderer(source), undefined);
  assert.equal(createMermaidMarkdownTransformer(theme), undefined);
  assert.equal(loader.calls, 0);
});
