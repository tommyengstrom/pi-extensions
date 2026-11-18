import { access, readFile, realpath } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Resolve the public installed SDK export, including a Git package with no copied host deps. */
export async function resolveSdkEntry(hostEntry = process.argv[1]): Promise<string> {
  const candidates: string[] = [];
  try {
    candidates.push(import.meta.resolve("@earendil-works/pi-coding-agent"));
  } catch {
    /* Host mapping may be Jiti-only. */
  }
  if (hostEntry) {
    try {
      const entry = pathToFileURL(await realpath(hostEntry)).href;
      const manifestPath = findPackageJSON(entry);
      if (manifestPath) {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        const target = manifest.exports?.["."]?.import;
        if (
          manifest.name === "@earendil-works/pi-coding-agent" &&
          manifest.version === "1.5.1" &&
          typeof target === "string" &&
          target.startsWith("./")
        )
          candidates.push(pathToFileURL(resolve(dirname(manifestPath), target)).href);
      }
    } catch {
      /* A standalone executable or unsupported host is rejected below. */
    }
  }
  for (const candidate of candidates) {
    try {
      const manifestPath = findPackageJSON(candidate);
      if (!manifestPath) continue;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest.name !== "@earendil-works/pi-coding-agent" || manifest.version !== "1.5.1") continue;
      await access(fileURLToPath(candidate));
      return candidate;
    } catch {
      /* Try the actual host entrypoint next. */
    }
  }
  throw new Error(
    "Cannot locate the public installed Pi 1.5.1 Node SDK. Run under the installed Node Pi CLI; bundled standalone executables are unsupported.",
  );
}
