import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { artifactScope } from "../src/artifacts.js";
import { importVisual, resolveVisual, visualLinks, visualWorkspace } from "../src/visuals.js";
import { pixelHash, pixelPng } from "./support.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ui-images-")));
  roots.push(root);
  const id = randomUUID();
  const workspace = join(root, "artifacts", id);
  const source = join(root, "screenshot.jpg"); // Name is not evidence of format.
  await writeFile(source, pixelPng);
  return {
    root,
    workspace,
    id,
    source,
    copy: (role = "before", path = source) => importVisual(workspace, role, path, () => true),
  };
}
test("imports verified bytes using the detected extension, keeps originals and prior revisions", async () => {
  const f = await fixture();
  const before = await f.copy();
  assert.equal(before, `[before.png](artifacts/${f.id}/visuals/before.png)`);
  const revisions = await Promise.all([f.copy("after"), f.copy("after")]);
  assert.equal(new Set(revisions).size, 2);
  for (const { filename } of visualLinks([before, ...revisions].join("\n"), f.workspace))
    assert.deepEqual(await readFile(await resolveVisual(f.workspace, filename, pixelHash)), pixelPng);
  assert.deepEqual(await readFile(f.source), pixelPng);
  // 1x1 JPEG, encoded from a solid blue pixel.
  const jpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCOALiMf//Z",
    "base64",
  );
  await writeFile(f.source, jpeg);
  assert.match(await f.copy(), /\[before\.jpg\]/);
  const pngPath = join(f.workspace, "visuals", "before.png");
  await writeFile(pngPath, jpeg);
  await assert.rejects(resolveVisual(f.workspace, "before.png", pixelHash), /changed/);
});
test("rejects non-images, damaged or oversized rasters, links, traversal, directories and stale publication", async () => {
  const f = await fixture();
  const alias = join(f.root, "alias");
  await symlink(f.source, alias);
  await assert.rejects(f.copy("before", alias));
  await assert.rejects(f.copy("before", `${f.root}/../${f.root.split("/").at(-1)}/screenshot.jpg`));
  await assert.rejects(f.copy("before", f.root));
  await assert.rejects(f.copy("../other"));
  let current = true;
  const pending = importVisual(f.workspace, "before", f.source, () => current);
  current = false;
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(realpath(f.workspace));
  for (const data of [
    Buffer.from("<svg/>"),
    pixelPng.subarray(0, 30),
    Buffer.concat([pixelPng.subarray(0, 33), pixelPng.subarray(-12)]),
  ]) {
    await writeFile(f.source, data);
    await assert.rejects(f.copy());
  }
  await truncate(f.source, 21 * 1024 * 1024);
  await assert.rejects(f.copy(), /20 MiB/);
});
test("only exact local links in the associated visual workspace are actions; open rechecks disk", async () => {
  const f = await fixture();
  const link = await f.copy();
  const target = `artifacts/${f.id}/visuals/before.png`;
  const outside = [
    "file:///tmp/before.png",
    `https://example.org/${target}`,
    `../${target}`,
    `/${target}`,
    `artifacts/${randomUUID()}/visuals/before.png`,
    target.replace("visuals/", "visuals/../"),
    `${target}?command=run`,
    "javascript:foo",
    target.replace("before.png", "before.svg"),
  ];
  const markdown = [...outside.map((url) => `[before.png](${url})`), `<img src="${target}">`, link, link].join("\n");
  assert.deepEqual(
    visualLinks(markdown, f.workspace).map((v) => v.relative),
    [target],
  );
  const artifacts = { version: 1 as const, workspace: { id: f.id, directory: f.workspace }, references: [] };
  assert.equal(visualWorkspace(f.root, artifacts), f.workspace);
  assert.equal(visualWorkspace(f.root, { ...artifacts, workspace: { id: f.id, directory: f.root } }), undefined);
  assert.match(
    artifactScope(artifacts, "artifact_create", { directory: join(f.workspace, "visuals", "child") }, f.root, true) ??
      "",
    /reserved/,
  );
  await assert.rejects(resolveVisual(f.workspace, "../before.png", pixelHash));
  assert.deepEqual(visualLinks(`Inline \`${link}\`\n\n\`\`\`md\n${link}\n\`\`\`\n\n<!-- ${link} -->`, f.workspace), []);
  const path = join(f.root, target);
  await rm(path);
  await symlink(f.source, path);
  await assert.rejects(resolveVisual(f.workspace, "before.png", pixelHash));
  await rm(join(f.workspace, "visuals"), { recursive: true });
  const elsewhere = join(f.root, "elsewhere");
  await mkdir(elsewhere);
  await symlink(elsewhere, join(f.workspace, "visuals"));
  await assert.rejects(f.copy());
  await assert.rejects(realpath(join(elsewhere, "before.png")));
});
