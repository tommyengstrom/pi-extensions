import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfinedMutations, directoryIdentity } from "../src/confined-tools.js";

let temporary: string;
let root: string;
let staging: string;
let outside: string;
let owned: boolean;
let onCheck: (() => void) | undefined;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "pi-artifact-mutations-"));
  root = join(temporary, "output");
  staging = join(temporary, "control");
  outside = join(temporary, "outside");
  await Promise.all([mkdir(root), mkdir(staging), mkdir(outside)]);
  owned = true;
  onCheck = undefined;
});

afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

function backend(limits?: ConstructorParameters<typeof ConfinedMutations>[0]["limits"]) {
  return new ConfinedMutations({
    root: directoryIdentity(root),
    staging: directoryIdentity(staging),
    limits,
    assertOwned() {
      if (!owned) throw new Error("Lost ownership");
      onCheck?.();
    },
  });
}

function write(backend: ConfinedMutations, path: string, content: string, signal?: AbortSignal) {
  return backend
    .tools()[0]
    .execute("test", { path, content }, signal, undefined, { cwd: root } as ExtensionToolContext);
}

function edit(backend: ConfinedMutations, path: string, oldText: string, newText: string, signal?: AbortSignal) {
  return backend
    .tools()[1]
    .execute("test", { path, edits: [{ oldText, newText }] }, signal, undefined, { cwd: root } as ExtensionToolContext);
}

describe("confined native mutation tools", () => {
  it("uses native write and edit schemas, guidance, matching and diffs", async () => {
    const fs = backend();
    expect(fs.tools().map((tool) => tool.name)).toEqual(["write", "edit"]);
    expect(fs.tools().every((tool) => tool.promptGuidelines?.length)).toBe(true);
    await write(fs, "mockup/index.html", "<h1>Checkout</h1>\n<p>first</p>\n");
    const result = await edit(fs, "mockup/index.html", "first", "second");
    expect(result.details).toMatchObject({ patch: expect.stringContaining("+<p>second</p>") });
    await edit(fs, "mockup/index.html", "second", "third");
    expect(await readFile(join(root, "mockup/index.html"), "utf8")).toContain("third");
    expect(fs.outputPaths()).toEqual([join(root, "mockup/index.html")]);
    expect(await readdir(staging)).toEqual([]);
  });

  it("preserves BOM and CRLF through native editing", async () => {
    const fs = backend();
    await write(fs, "text.txt", "\uFEFFone\r\ntwo\r\n");
    await edit(fs, "text.txt", "two", "three");
    expect(await readFile(join(root, "text.txt"), "utf8")).toBe("\uFEFFone\r\nthree\r\n");
  });

  it("rejects ambiguous native edits without changing the file", async () => {
    const fs = backend();
    await write(fs, "text.txt", "duplicate duplicate");
    await expect(edit(fs, "text.txt", "duplicate", "new")).rejects.toThrow();
    expect(await readFile(join(root, "text.txt"), "utf8")).toBe("duplicate duplicate");
  });

  it.each(["../escape.txt", "nested/../../escape.txt"])("rejects traversal: %s", async (path) => {
    const fs = backend();
    await expect(write(fs, path, "no")).rejects.toThrow(/escapes/);
    expect(await readdir(root)).toEqual([]);
    expect(existsSync(join(temporary, "escape.txt"))).toBe(false);
  });

  it("rejects outside absolute paths but accepts inside absolute paths", async () => {
    const fs = backend();
    await expect(write(fs, join(outside, "bad.txt"), "no")).rejects.toThrow(/escapes/);
    await write(fs, join(root, "good.txt"), "yes");
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects symlink directory and file redirection", async () => {
    const fs = backend();
    await writeFile(join(outside, "original.txt"), "original");
    await symlink(outside, join(root, "escape"));
    await expect(write(fs, "escape/nested/new.txt", "bad")).rejects.toThrow();
    await rm(join(root, "escape"));
    await symlink(join(outside, "original.txt"), join(root, "link.txt"));
    await expect(write(fs, "link.txt", "bad")).rejects.toThrow();
    await expect(edit(fs, "link.txt", "original", "bad")).rejects.toThrow();
    expect(await readFile(join(outside, "original.txt"), "utf8")).toBe("original");
  });

  it("replaces a hard-linked entry without mutating its other names", async () => {
    const fs = backend();
    await writeFile(join(outside, "original.txt"), "original");
    await link(join(outside, "original.txt"), join(root, "hard.txt"));
    await edit(fs, "hard.txt", "original", "changed");
    expect(await readFile(join(outside, "original.txt"), "utf8")).toBe("original");
    expect(await readFile(join(root, "hard.txt"), "utf8")).toBe("changed");
    expect((await stat(join(root, "hard.txt"))).nlink).toBe(1);
  });

  it("rejects nonregular targets", async () => {
    const fs = backend();
    await mkdir(join(root, "directory"));
    await expect(write(fs, "directory", "bad")).rejects.toThrow(/regular/);
    await expect(edit(fs, "directory", "a", "b")).rejects.toThrow(/regular/);
  });

  it("rejects a replaced root even at the same pathname", async () => {
    const fs = backend();
    await rename(root, `${root}-old`);
    await mkdir(root);
    await expect(write(fs, "bad.txt", "no")).rejects.toThrow(/replaced/);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects a redirected root", async () => {
    const fs = backend();
    await rename(root, `${root}-old`);
    await symlink(outside, root);
    await expect(write(fs, "bad.txt", "no")).rejects.toThrow(/redirected/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects overlapping control and output trees", () => {
    expect(
      () =>
        new ConfinedMutations({
          root: directoryIdentity(root),
          staging: directoryIdentity(temporary),
          assertOwned() {},
        }),
    ).toThrow(/overlap/);
  });

  it("fails closed on a staging filesystem mismatch", () => {
    expect(
      () =>
        new ConfinedMutations({
          root: directoryIdentity(root),
          staging: { ...directoryIdentity(staging), device: "-1" },
          assertOwned() {},
        }),
    ).toThrow();
  });

  it("enforces file and total UTF-8 byte bounds", async () => {
    const fs = backend({ fileBytes: 8, totalBytes: 12 });
    await expect(write(fs, "big.txt", "€€€")).rejects.toThrow(/file size/);
    await write(fs, "one.txt", "12345678");
    await expect(write(fs, "two.txt", "12345")).rejects.toThrow(/total size/);
    await write(fs, "one.txt", "1234");
    await write(fs, "two.txt", "12345678");
    expect(await readdir(staging)).toEqual([]);
  });

  it("bounds entries including hidden entries and directories", async () => {
    const fs = backend({ entries: 2 });
    await write(fs, ".hidden", "one");
    await write(fs, "second", "two");
    await expect(write(fs, "third", "three")).rejects.toThrow(/entry limit/);
    await expect(write(fs, "nested/file", "four")).rejects.toThrow(/entry limit/);
    expect(fs.outputPaths()).toHaveLength(2);
  });

  it("bounds directory depth", async () => {
    const fs = backend({ depth: 1 });
    await expect(write(fs, "one/two/file", "bad")).rejects.toThrow(/depth/);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects malformed UTF-8 edit input without replacing it", async () => {
    const fs = backend();
    const malformed = Buffer.from([0xff, 0xfe]);
    await writeFile(join(root, "binary"), malformed);
    await expect(edit(fs, "binary", "x", "y")).rejects.toThrow();
    expect(await readFile(join(root, "binary"))).toEqual(malformed);
  });

  it("detects a conflicting change between native edit read and publication", async () => {
    const fs = backend();
    await write(fs, "text.txt", "old");
    let changed = false;
    onCheck = () => {
      if (!changed && readdirSync(staging).length) {
        changed = true;
        writeFileSync(join(root, "text.txt"), "external");
      }
    };
    await expect(edit(fs, "text.txt", "old", "new")).rejects.toThrow(/changed during/);
    expect(changed).toBe(true);
    expect(await readFile(join(root, "text.txt"), "utf8")).toBe("external");
    expect(await readdir(staging)).toEqual([]);
  });

  it("cleans staging and preserves partial output on cancellation before publication", async () => {
    const fs = backend();
    await write(fs, "text.txt", "old");
    const controller = new AbortController();
    onCheck = () => {
      if (readdirSync(staging).some((name) => statSync(join(staging, name)).size > 0)) controller.abort();
    };
    await expect(edit(fs, "text.txt", "old", "new", controller.signal)).rejects.toThrow();
    await fs.drain();
    expect(await readFile(join(root, "text.txt"), "utf8")).toBe("old");
    expect(await readdir(staging)).toEqual([]);
  });

  it("rechecks lease ownership after staging opens", async () => {
    const fs = backend();
    onCheck = () => {
      if (readdirSync(staging).length) {
        owned = false;
        throw new Error("Lost ownership");
      }
    };
    await expect(write(fs, "text.txt", "no")).rejects.toThrow(/ownership/);
    await fs.drain();
    expect(await readdir(root)).toEqual([]);
    expect(await readdir(staging)).toEqual([]);
  });

  it("serializes publication across different filenames for total-size accounting", async () => {
    const fs = backend({ fileBytes: 8, totalBytes: 8 });
    const results = await Promise.allSettled([write(fs, "one", "12345678"), write(fs, "two", "12345678")]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(fs.outputPaths()).toHaveLength(1);
    expect(await readdir(staging)).toEqual([]);
  });

  it("does not poison the mutation queue after an aborted operation", async () => {
    const fs = backend();
    const controller = new AbortController();
    controller.abort();
    await expect(write(fs, "cancelled", "no", controller.signal)).rejects.toThrow();
    await write(fs, "next", "yes");
    expect(fs.outputPaths()).toEqual([join(root, "next")]);
  });
});
