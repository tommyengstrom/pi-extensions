#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "pi-packaging-"));
const candidate = join(temporary, "candidate");
const host = join(temporary, "host");
const bin = join(temporary, "bin");
const installArgs = ["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"];
const forbidden = new Set([
  "typescript",
  "@types/node",
  "vitest",
  "@biomejs/biome",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "typebox",
]);

async function executable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(directory, name);
    try {
      await access(path);
      return await realpath(path);
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error(`Required executable not found: ${name}`);
}

try {
  await mkdir(bin);
  await mkdir(host);
  await mkdir(join(temporary, "home"));
  // An allowlisted PATH, not a Bun shim: even a shell cannot discover Bun.
  for (const name of ["node", "npm", "sh", "git", "env"]) {
    await symlink(name === "node" ? process.execPath : await executable(name), join(bin, name));
  }
  const userconfig = join(temporary, "npmrc");
  const globalconfig = join(temporary, "global-npmrc");
  await writeFile(userconfig, "");
  await writeFile(globalconfig, "");
  const env = {
    PATH: bin,
    HOME: join(temporary, "home"),
    TMPDIR: temporary,
    CI: "1",
    PI_CODING_AGENT_DIR: join(temporary, "agent"),
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_cache: join(temporary, "npm-cache"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_ignore_scripts: "false",
    npm_config_script_shell: join(bin, "sh"),
  };
  function run(command, args, cwd) {
    console.log(`Packaging: ${command} ${args.join(" ")} (${cwd})`);
    execFileSync(command, args, { cwd, env, stdio: "inherit", timeout: 180_000 });
  }
  execFileSync(join(bin, "sh"), ["-c", "! command -v bun"], { env });
  // Include current edits and new non-ignored files, never dependencies/build output.
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  for (const path of new Set(paths)) {
    if (
      path.split("/").some((part) => ["node_modules", "dist", ".git", ".pi"].includes(part)) ||
      [".npmrc", "package-lock.json"].includes(path)
    )
      continue;
    const source = join(root, path);
    try {
      await access(source);
    } catch {
      continue;
    } // Tracked deletion in the candidate.
    assert.ok((await lstat(source)).isFile(), `Candidate source must be a regular file: ${path}`);
    await mkdir(dirname(join(candidate, path)), { recursive: true });
    await copyFile(source, join(candidate, path));
  }
  const manifest = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"));
  await writeFile(
    join(host, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "@earendil-works/pi-coding-agent": "1.5.0" },
      overrides: manifest.overrides,
    }),
  );
  await copyFile(join(root, "test/packaging-host.mjs"), join(host, "smoke.mjs"));
  run(join(bin, "npm"), installArgs, host);

  for (const phase of ["cold", "repeat", "update-cleanup"]) {
    if (phase === "update-cleanup") {
      for (const packageName of ["pi-tui-kit", "pi-plan-mode", "pi-artifacts", "pi-thinking-shortcuts"]) {
        for (const name of ["dist", "node_modules"]) {
          await rm(join(candidate, "packages", packageName, name), { recursive: true, force: true });
        }
      }
      await rm(join(candidate, "node_modules"), { recursive: true, force: true });
      await rm(join(candidate, "package-lock.json"), { force: true });
    }
    console.log(`Packaging phase: ${phase}`);
    run(join(bin, "npm"), installArgs, candidate);
    const kit = join(candidate, "packages/pi-tui-kit");
    assert.equal(await realpath(join(candidate, "node_modules/@narumitw/pi-tui-kit")), await realpath(kit));
    const kitManifest = JSON.parse(await readFile(join(kit, "package.json"), "utf8"));
    for (const entry of Object.values(kitManifest.exports)) await access(join(kit, entry.import));
    await access(join(candidate, "packages/pi-plan-mode/dist/index.ts"));
    await assert.rejects(access(join(kit, "dist/stale.js")));
    await assert.rejects(access(join(candidate, "packages/pi-plan-mode/dist/stale.ts")));
    await inspectTree(candidate);
    run(process.execPath, [join(host, "smoke.mjs"), candidate], host);
    // A subsequent install must replace output, not merely skip existing dist.
    await writeFile(join(kit, "dist/stale.js"), "stale");
    await writeFile(join(candidate, "packages/pi-plan-mode/dist/stale.ts"), "stale");
  }
  console.log("Packaging smoke passed: cold, repeat, and update-style production installs and Pi loading.");
} catch (error) {
  console.error("Packaging smoke FAILED (network/install/loader failures are not a pass):", error);
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function inspectTree(directory) {
  // Do not follow workspace links; inspect all physical package locations, including nested deps.
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    try {
      const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
      assert.ok(!forbidden.has(manifest.name), `Unexpected physical dependency: ${manifest.name} at ${path}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await inspectTree(path);
  }
}
