import { access, readFile, realpath } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Resolve the public installed SDK export, including a Git package with no copied host deps. */
export async function resolvePiCli(hostEntry = process.argv[1]): Promise<string> {
  const manifestPath = findPackageJSON(await resolveSdkEntry(hostEntry));
  if (!manifestPath) throw new Error("Cannot resolve installed Pi CLI");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== "1.5.1" || typeof manifest.bin?.pi !== "string")
    throw new Error("Worker requires installed Pi CLI 1.5.1");
  const cli = resolve(dirname(manifestPath), manifest.bin.pi);
  await access(cli);
  return cli;
}

export async function resolveSdkEntry(hostEntry = process.argv[1]): Promise<string> {
  const candidates: string[] = [];
  if (hostEntry) {
    try {
      const entry = pathToFileURL(await realpath(hostEntry)).href;
      const manifestPath = findPackageJSON(entry);
      if (manifestPath) {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        const target = manifest.exports?.["."]?.import;
        if (
          manifest.name === "@earendil-works/pi-coding-agent" &&
          typeof target === "string" &&
          target.startsWith("./")
        )
          candidates.push(pathToFileURL(resolve(dirname(manifestPath), target)).href);
      }
    } catch {
      /* A standalone executable or unsupported host is rejected below. */
    }
  }
  try {
    candidates.push(import.meta.resolve("@earendil-works/pi-coding-agent"));
  } catch {
    /* Host mapping may be Jiti-only. */
  }
  for (const candidate of candidates) {
    try {
      const manifestPath = findPackageJSON(candidate);
      if (!manifestPath) continue;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest.name !== "@earendil-works/pi-coding-agent") continue;
      await access(fileURLToPath(candidate));
      return candidate;
    } catch {
      /* Try the next available package. */
    }
  }
  throw new Error(
    "Cannot locate the installed Pi Node SDK export. Run under the installed Node Pi CLI; bundled standalone executables are unsupported.",
  );
}
