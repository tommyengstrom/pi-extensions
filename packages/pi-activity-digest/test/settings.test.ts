import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parseChange, readSettings, updateSettings } from "../src/settings.js";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "digest-settings-"));
  path = join(dir, "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("defaults without creating a file, then persists changes alongside unknown fields", () => {
  expect(readSettings(path)).toEqual({ size: 5, thinking: false });
  expect(readdirSync(dir)).toEqual([]);
  writeFileSync(path, JSON.stringify({ extra: { important: true } }));
  updateSettings(parseChange("size 3"), path);
  updateSettings(parseChange("thinking on"), path);
  expect(readSettings(path)).toEqual({ size: 3, thinking: true });
  expect(JSON.parse(readFileSync(path, "utf8")).extra).toEqual({ important: true });
  updateSettings(parseChange("thinking off"), path);
  expect(readSettings(path).thinking).toBe(false);
  expect(readdirSync(dir)).toEqual(["settings.json"]);
});

it.each([
  "size",
  "size 0",
  "size -3",
  "size 3.3",
  "size 1e3",
  "size 9007199254740992",
  "thinking yes",
  "thinking on now",
])("rejects %s", (args) => {
  expect(() => parseChange(args)).toThrow(/Use \/digest/);
});
it.each(["not JSON", "[]", "null", '{"size":false}', '{"thinking":0}', '{"size":null}'])(
  "never replaces malformed file %s",
  (input) => {
    writeFileSync(path, input);
    expect(() => updateSettings({ size: 2 }, path)).toThrow(/left untouched/);
    expect(readFileSync(path, "utf8")).toBe(input);
  },
);
