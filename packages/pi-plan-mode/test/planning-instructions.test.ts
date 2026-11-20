import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test, vi } from "vitest";
import {
  MAX_PLAN_MODE_INSTRUCTIONS_BYTES,
  planModeInstructionsPath,
  readPlanModeInstructions,
} from "../src/planning-instructions.js";
import {
  BUILTIN_PLAN_TEMPLATES,
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE_ID,
  listPlanTemplates,
  parseUserTemplate,
  planModeTemplatesDir,
  resolvePlanTemplate,
  validTemplateName,
} from "../src/templates.js";

const agentDir = vi.hoisted(() =>
  vi.fn<() => string>(() => {
    throw new Error("Tests must supply an explicit temporary instructions path");
  }),
);
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: agentDir,
}));

// Keep real temporary-file I/O, while allowing deterministic read failures and stat/read races.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));

afterEach(() => vi.restoreAllMocks());

describe("guidance Markdown", () => {
  function withInstructionsFile(run: (path: string, directory: string) => void) {
    const directory = fs.mkdtempSync(join(tmpdir(), "pi-plan-instructions-"));
    try {
      run(join(directory, "pi-plan-mode.md"), directory);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  test("the default path uses Pi's agent directory and the package Markdown basename", () => {
    withInstructionsFile((path, directory) => {
      agentDir.mockReturnValueOnce(directory);
      assert.equal(planModeInstructionsPath(), path);
      agentDir.mockReturnValueOnce(directory);
      assert.equal(readPlanModeInstructions(), "");
      assert.deepEqual(fs.readdirSync(directory), []);
    });
  });

  test("missing instructions and parents remain absent after a side-effect-free read", () => {
    withInstructionsFile((path, directory) => {
      assert.equal(readPlanModeInstructions(path), "");
      assert.equal(readPlanModeInstructions(join(directory, "absent", "instructions.md")), "");
      assert.deepEqual(fs.readdirSync(directory), []);
    });
  });

  test("empty and whitespace-only instructions are optional", () => {
    withInstructionsFile((path) => {
      for (const content of ["", " \t\r\n ", "\uFEFF\n"]) {
        fs.writeFileSync(path, content);
        assert.equal(readPlanModeInstructions(path), "");
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
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
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

describe("plan templates catalog and user .md templates", () => {
  test("built-in catalog includes the opt-in ui template and defaults to decision-brief", () => {
    assert.equal(DEFAULT_PLAN_TEMPLATE_ID, "decision-brief");
    assert.equal(DEFAULT_PLAN_TEMPLATE.id, "decision-brief");
    assert.deepEqual(
      BUILTIN_PLAN_TEMPLATES.map((template) => template.id),
      ["decision-brief", "detailed-spec", "checklist", "minimal", "ui"],
    );
    for (const template of BUILTIN_PLAN_TEMPLATES) {
      assert.equal(template.completionChecks, undefined);
      assert.equal(validTemplateName(template.id), true);
      assert.equal(template.source, "builtin");
      const path = fileURLToPath(new URL(`../templates/${template.id}.md`, import.meta.url));
      const markdown = fs.readFileSync(path, "utf8");
      assert.ok(markdown.startsWith(`---\nlabel: ${template.label}\ndescription: ${template.description}\n---\n`));
      assert.equal(template.content, markdown.slice(markdown.indexOf("\n---\n") + 5).trim());
      assert.ok(template.content.startsWith("# [Plan title]\n<!--"));
      assert.match(template.content, /^## Verification\n<!--/m);
      assert.match(template.content, /At most 250 characters\./);
      assert.doesNotMatch(template.content, /Structure the completed|^- `##|^> |^label:|^description:/m);
      // Every section is real Markdown and carries its semantics in a comment.
      const headings = template.content.match(/^#{1,3} .+$/gm) ?? [];
      for (const heading of headings) assert.ok(template.content.includes(`${heading}\n<!--`));
      assert.ok(template.label.length > 0);
      assert.ok(template.description.length > 0);
      assert.match(template.content, /## Verification/);
      assert.match(template.content, /rough range of changed lines/);
    }
  });

  test.each([
    ["on_implementation_complete: Do the old task", /migrate/],
    ["hooks: null", /hooks must/],
    ["hooks: {on_plan_complete: []}", /unknown hook event/],
    ["hooks: {on_implementation_complete: false}", /list/],
    ["hooks: {on_implementation_complete: [null]}", /object/],
    ["hooks: {on_implementation_complete: [{name: A, prompt: P}]}", /type/],
    ["hooks: {on_implementation_complete: [{type: bash}]}", /type/],
    ["hooks: {on_implementation_complete: [{type: subagent}]}", /name/],
    ["hooks: {on_implementation_complete: [{type: subagent, name: A, prompt: ' '}]}", /prompt/],
    ...[
      ["model: bare", /provider\/model/],
      ["effort: huge", /effort/],
      ["remove_tools: bash", /remove_tools/],
      ["extra: true", /unknown field/],
    ].map(([field, pattern]) => [
      `hooks: {on_implementation_complete: [{name: A, prompt: P, type: subagent, ${field}}]}`,
      pattern,
    ]),
  ] as [string, RegExp][])("rejects invalid hook header %s", (header, pattern) => {
    assert.throws(() => parseUserTemplate("example", `---\n${header}\n---\n# Plan`), pattern);
  });
  test("an empty list opts out", () => {
    assert.equal(
      parseUserTemplate("example", "---\nhooks: {on_implementation_complete: []}\n---\n# Plan").completionChecks,
      undefined,
    );
  });

  test("frontmatter supplies picker metadata while the exact skeleton and comments remain model-visible", () => {
    const body = "# [Plan title]\r\n\r\n## Overview\r\n<!-- At most 250 characters. -->\r\n\r\n## Verification";
    const template = parseUserTemplate(
      "custom",
      `---\r\nlabel: Custom spec\r\ndescription: Team specification\r\n---\r\n\r\n${body}\r\n`,
    );
    assert.equal(template.label, "Custom spec");
    assert.equal(template.description, "Team specification");
    assert.equal(template.content, body);
    const defaults = parseUserTemplate("my-template", "---\nfuture: true\n---\n# [Plan title]");
    assert.equal(defaults.label, "My template");
    assert.equal(defaults.description, "Custom user template");
  });

  test.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("empty %s frontmatter uses default metadata and preserves the body", (_name, eol) => {
    const directory = fs.mkdtempSync(join(tmpdir(), "pi-template-empty-header-"));
    try {
      // A later Markdown rule must not be mistaken for the header's closing delimiter.
      for (const rule of [[], ["", "---"]]) {
        const body = [
          "# [Plan title]",
          "",
          "## Changes",
          "<!-- Keep literal. -->",
          ...rule,
          "",
          "## Verification",
        ].join(eol);
        const markdown = ["---", "---", "", body, ""].join(eol);
        const expected = {
          id: "empty-header",
          label: "Empty header",
          description: "Custom user template",
          content: body,
          source: "user",
        };
        const path = join(directory, "empty-header.md");
        fs.writeFileSync(path, markdown);
        assert.deepEqual(parseUserTemplate("empty-header", markdown), expected);
        assert.deepEqual(resolvePlanTemplate("empty-header", directory), expected);
        assert.deepEqual(
          listPlanTemplates(directory).find((template) => template.id === "empty-header"),
          expected,
        );
        assert.equal(fs.readFileSync(path, "utf8"), markdown);
      }
      assert.throws(() => parseUserTemplate("empty-header", ["---", "---", ""].join(eol)), /body must not be empty/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("invalid frontmatter and metadata-only templates fail without rewriting files", () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "pi-template-header-"));
    try {
      for (const markdown of [
        "---\nlabel: Missing end",
        "---\n- not\n- an object\n---\n# Plan",
        "---\nlabel: false\n---\n# Plan",
        "---\ndescription: []\n---\n# Plan",
        "---\nlabel: ' '\n---\n# Plan",
        "---\nlabel: [broken\n---\n# Plan",
        "---\nlabel: No body\n---\n",
      ]) {
        const path = join(directory, "custom.md");
        fs.writeFileSync(path, markdown);
        assert.throws(() => resolvePlanTemplate("custom", directory));
        assert.throws(() => listPlanTemplates(directory));
        assert.equal(fs.readFileSync(path, "utf8"), markdown);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("user templates directory defaults to <getAgentDir()>/pi-plan-mode-templates without creating it", () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "pi-plan-templates-"));
    try {
      agentDir.mockReturnValue(directory);
      const templatesDir = planModeTemplatesDir();
      assert.equal(templatesDir, join(directory, "pi-plan-mode-templates"));
      assert.deepEqual(
        listPlanTemplates().map((template) => template.id),
        ["decision-brief", "detailed-spec", "checklist", "minimal", "ui"],
      );
      assert.equal(resolvePlanTemplate("decision-brief").id, "decision-brief");
      assert.deepEqual(fs.readdirSync(directory), []);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("user .md templates extend the catalog, override built-ins, and extract heading/blockquote metadata", () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "pi-plan-templates-"));
    const templatesDir = join(directory, "pi-plan-mode-templates");
    fs.mkdirSync(templatesDir, { recursive: true });
    try {
      fs.writeFileSync(
        join(templatesDir, "adr-brief.md"),
        "# ADR Brief\n> Architecture decision record with context and consequences\n\n- `## Context`\n- `## Decision`\n- `## Consequences`",
      );
      fs.writeFileSync(join(templatesDir, "plain-custom.md"), "Use `## Summary` and `## Steps`.");
      fs.writeFileSync(
        join(templatesDir, "decision-brief.md"),
        "# Custom Decision Brief\n\n> Overridden default template\n\nUse `## Custom Overview`.",
      );

      const listed = listPlanTemplates(templatesDir);
      assert.deepEqual(
        listed.map((template) => template.id),
        ["decision-brief", "detailed-spec", "checklist", "minimal", "ui", "adr-brief", "plain-custom"],
      );

      const overridden = resolvePlanTemplate("decision-brief", templatesDir);
      assert.equal(overridden.source, "user");
      assert.equal(overridden.label, "Custom Decision Brief");
      assert.equal(overridden.description, "Overridden default template");
      assert.match(overridden.content, /## Custom Overview/);

      const adr = resolvePlanTemplate("adr-brief", templatesDir);
      assert.equal(adr.source, "user");
      assert.equal(adr.label, "ADR Brief");
      assert.equal(adr.description, "Architecture decision record with context and consequences");

      const plain = resolvePlanTemplate("plain-custom", templatesDir);
      assert.equal(plain.source, "user");
      assert.equal(plain.label, "Plain custom");
      assert.equal(plain.description, "Custom user template");
      assert.equal(plain.content, "Use `## Summary` and `## Steps`.");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("invalid template names, unknown IDs, and empty/corrupt user template files fail clearly", () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "pi-plan-templates-"));
    const templatesDir = join(directory, "pi-plan-mode-templates");
    fs.mkdirSync(templatesDir, { recursive: true });
    try {
      for (const invalid of ["", "UpperCase", "with_underscore", "with space", "-leading", "trailing-"]) {
        assert.equal(validTemplateName(invalid), false);
        assert.throws(() => resolvePlanTemplate(invalid, templatesDir), /Invalid plan template name/);
      }
      assert.throws(() => resolvePlanTemplate("nonexistent", templatesDir), /Unknown plan template "nonexistent"/);

      fs.writeFileSync(join(templatesDir, "empty-template.md"), "   \n\t ");
      assert.throws(() => resolvePlanTemplate("empty-template", templatesDir), /must not be empty/);
      assert.throws(() => listPlanTemplates(templatesDir), /must not be empty/);

      fs.rmSync(join(templatesDir, "empty-template.md"));
      fs.writeFileSync(join(templatesDir, "Bad_Name.md"), "# Invalid filename");
      assert.throws(() => listPlanTemplates(templatesDir), /Invalid Plan-mode template filename/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
