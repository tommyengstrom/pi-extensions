import { expect, test } from "vitest";
import { canonical } from "../src/capabilities.js";
import { terminalText } from "../src/terminal-text.js";

test("display output removes terminal controls, links and bidi overrides", () => {
  expect(terminalText("\u001b[31mred\u001b[0m\n\u001b]8;;https://invalid\u0007link\u001b]8;;\u0007\r\u202espoof")).toBe(
    "red\nlinkspoof",
  );
  expect(terminalText("x".repeat(60_000))).toHaveLength(50_000);
});
test("optional SDK fields normalize across private JSON IPC without allowing closures", () => {
  expect(canonical({ id: "model", headers: undefined })).toBe(canonical({ id: "model" }));
  expect(() => canonical({ execute: () => {} })).toThrow(/not reproducible/);
});
