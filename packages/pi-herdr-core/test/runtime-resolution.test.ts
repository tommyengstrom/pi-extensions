import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { resolveSdkEntry } from "../src/runtime-resolution.js";

it.each(["1.5.2", "1.6.0"])("uses the running Pi %s SDK ahead of the workspace dependency", async (version) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sdk-"));
  try {
    const sdk = join(dir, "sdk.js");
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, exports: { ".": { import: "./sdk.js" } } }),
    );
    await writeFile(sdk, "");
    await writeFile(join(dir, "cli.js"), "");
    const cli = join(dir, "pi");
    await symlink("cli.js", cli);

    expect(await resolveSdkEntry(cli)).toBe(pathToFileURL(sdk).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
