import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import {
  MAX_PLAN_MODE_INSTRUCTIONS_BYTES,
  planModeInstructionsPath,
  planModePromptPath,
  readPlanModeInstructions as readGuidance,
  readPlanModeBasePrompt,
} from "../src/planning-instructions.js";
import { DEFAULT_PLAN_MODE_PROMPT } from "../src/prompt.js";

const agentDir = vi.hoisted(() =>
  vi.fn<() => string>(() => {
    throw new Error("Tests must supply an explicit temporary instructions path");
  }),
);
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: agentDir }));

// Keep real temporary-file I/O, while allowing deterministic read failures and stat/read races.
vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs")>()) }));

afterEach(() => vi.restoreAllMocks());

describe.each([
  {
    name: "guidance",
    filename: "pi-plan-mode.md",
    pathFor: planModeInstructionsPath,
    read: readGuidance,
    fallback: "",
  },
  {
    name: "replacement",
    filename: "pi-plan-mode-prompt.md",
    pathFor: planModePromptPath,
    read: readPlanModeBasePrompt,
    fallback: DEFAULT_PLAN_MODE_PROMPT,
  },
])("$name Markdown", ({ filename, pathFor, read: readPlanModeInstructions, fallback }) => {
  function withInstructionsFile(run: (path: string, directory: string) => void) {
    const directory = fs.mkdtempSync(join(tmpdir(), "pi-plan-instructions-"));
    try {
      run(join(directory, filename), directory);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  test("the default path uses Pi's agent directory and the package Markdown basename", () => {
    withInstructionsFile((path, directory) => {
      agentDir.mockReturnValueOnce(directory);
      assert.equal(pathFor(), path);
      agentDir.mockReturnValueOnce(directory);
      assert.equal(readPlanModeInstructions(), fallback);
      assert.deepEqual(fs.readdirSync(directory), []);
    });
  });

  test("missing instructions and parents remain absent after a side-effect-free read", () => {
    withInstructionsFile((path, directory) => {
      assert.equal(readPlanModeInstructions(path), fallback);
      assert.equal(readPlanModeInstructions(join(directory, "absent", "instructions.md")), fallback);
      assert.deepEqual(fs.readdirSync(directory), []);
    });
  });

  test("empty and whitespace-only instructions are optional", () => {
    withInstructionsFile((path) => {
      for (const content of ["", " \t\r\n ", "\uFEFF\n"]) {
        fs.writeFileSync(path, content);
        assert.equal(readPlanModeInstructions(path), fallback);
        assert.equal(fs.readFileSync(path, "utf8"), content);
      }
    });
  });

  test("Markdown, Unicode, internal whitespace, and interpolation syntax are preserved without writes", () => {
    withInstructionsFile((path) => {
      const content =
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Verify that literal user text is never interpolated.
        "\n# Guidance 🧭\r\n\r\n- Explain ${HOME} and {{value}} literally.  \r\n\r\n```text\r\n  exact indentation\r\n```\n";
      fs.writeFileSync(path, content);
      assert.equal(readPlanModeInstructions(path), content.trim());
      assert.equal(fs.readFileSync(path, "utf8"), content);
      // No caching: a later explicit read observes the current file.
      fs.writeFileSync(path, "Updated guidance");
      assert.equal(readPlanModeInstructions(path), "Updated guidance");
    });
  });

  test("the 64 KiB limit counts bytes and accepts an exactly bounded UTF-8 file", () => {
    withInstructionsFile((path) => {
      assert.equal(MAX_PLAN_MODE_INSTRUCTIONS_BYTES, 64 * 1024);
      const content = "é".repeat(MAX_PLAN_MODE_INSTRUCTIONS_BYTES / 2);
      fs.writeFileSync(path, content);
      assert.equal(readPlanModeInstructions(path), content);
      fs.appendFileSync(path, "x");
      assert.throws(() => readPlanModeInstructions(path), /65536-byte \(64 KiB\) limit/);
    });
  });

  test("oversized and invalid UTF-8 files fail with path context and are not modified", () => {
    withInstructionsFile((path) => {
      for (const [content, message] of [
        [Buffer.alloc(MAX_PLAN_MODE_INSTRUCTIONS_BYTES + 1, 32), /64 KiB/],
        [Buffer.from([0xc3, 0x28]), /valid UTF-8/],
        [Buffer.from([0xe2, 0x82]), /valid UTF-8/],
      ] as const) {
        fs.writeFileSync(path, content);
        assert.throws(
          () => readPlanModeInstructions(path),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes(path));
            assert.match(error.message, message);
            return true;
          },
        );
        assert.deepEqual(fs.readFileSync(path), content);
      }
    });
  });

  test("non-regular files and invalid path components are errors rather than missing guidance", () => {
    withInstructionsFile((path, directory) => {
      assert.throws(() => readPlanModeInstructions(directory), /regular file|EISDIR/);
      fs.writeFileSync(path, "not a directory");
      assert.throws(() => readPlanModeInstructions(join(path, "child.md")), /ENOTDIR/);
    });
  });

  test("unreadable files surface their error instead of silently falling back", () => {
    withInstructionsFile((path) => {
      fs.writeFileSync(path, "Guidance");
      vi.spyOn(fs, "openSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      });
      assert.throws(() => readPlanModeInstructions(path), /Unable to read Plan-mode .*EACCES/);
    });
  });

  test("bounded reads reject growth after stat and close the descriptor", () => {
    withInstructionsFile((path) => {
      fs.writeFileSync(path, Buffer.alloc(MAX_PLAN_MODE_INSTRUCTIONS_BYTES + 100, 65));
      const stat = fs.statSync(path);
      stat.size = 0;
      vi.spyOn(fs, "fstatSync").mockReturnValueOnce(stat);
      const close = vi.spyOn(fs, "closeSync");
      assert.throws(() => readPlanModeInstructions(path), /64 KiB/);
      assert.equal(close.mock.calls.length, 1);
    });
  });

  test("every opened descriptor closes after success, validation failure, or read failure", () => {
    withInstructionsFile((path) => {
      for (const [content, valid] of [
        [Buffer.from("Guidance"), true],
        [Buffer.from([0xff]), false],
        [Buffer.alloc(MAX_PLAN_MODE_INSTRUCTIONS_BYTES + 1), false],
      ] as const) {
        fs.writeFileSync(path, content);
        const close = vi.spyOn(fs, "closeSync");
        if (valid) assert.equal(readPlanModeInstructions(path), "Guidance");
        else assert.throws(() => readPlanModeInstructions(path));
        assert.equal(close.mock.calls.length, 1);
        close.mockRestore();
      }
      fs.writeFileSync(path, "Guidance");
      const close = vi.spyOn(fs, "closeSync");
      vi.spyOn(fs, "readSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("EIO: read failed"), { code: "EIO" });
      });
      assert.throws(() => readPlanModeInstructions(path), /Unable to read Plan-mode .*EIO/);
      assert.equal(close.mock.calls.length, 1);
    });
  });
});
