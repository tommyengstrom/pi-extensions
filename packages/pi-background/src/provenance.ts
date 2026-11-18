import { readFileSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
export const ARTIFACT_TOOL_NAMES = [
  "artifact_create",
  "artifact_update",
  "artifact_status",
  "artifact_wait",
  "artifact_cancel",
] as const;
export const SUBAGENT_TOOL_NAMES = ["subagent", "subagent_query", "subagent_wait", "subagent_cancel"] as const;
/** Trust an installed implementation entrypoint, not an arbitrary same-name tool. */
export function verifiedSubagentTools(tools: readonly ToolInfo[]): string[] {
  return tools
    .filter((tool) => {
      if (
        !(SUBAGENT_TOOL_NAMES as readonly string[]).includes(tool.name) ||
        tool.exposure === "hidden" ||
        !isAbsolute(tool.sourceInfo.path)
      )
        return false;
      try {
        const file = realpathSync(tool.sourceInfo.path);
        const manifestPath = findPackageJSON(pathToFileURL(file).href);
        if (!manifestPath) return false;
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        return (
          manifest.name === "@narumitw/pi-herdr-core" &&
          Array.isArray(manifest.pi?.extensions) &&
          manifest.pi.extensions.some(
            (entry: unknown) =>
              typeof entry === "string" && realpathSync(resolve(dirname(manifestPath), entry)) === file,
          )
        );
      } catch {
        return false;
      }
    })
    .map((tool) => tool.name);
}
