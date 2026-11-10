import { existsSync } from "node:fs";
import type { ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { IMPLEMENTATION_ENTRY, type ImplementationState } from "./implementation-state.js";
import { type PlanDocument, planHash } from "./plan-store.js";

export function implementationPrompt(plan: string, document?: PlanDocument) {
  const references = document?.artifacts?.references ?? [];
  return [
    "Implement the reviewed plan below. Planning is finished. Re-read files as needed and carry the work through implementation and verification.",
    document
      ? `Current mutable plan: ${JSON.stringify(document.path)}. Record user-requested changes in this same file before implementing them. Read the current plan after compaction; do not assume the kickoff text is still current.`
      : "",
    plan,
    references.length
      ? `Live review artifacts (current files, not historical snapshots):\n${references
          .map((reference) =>
            JSON.stringify({
              artifactId: reference.artifactId,
              jobId: reference.jobId,
              directory: reference.directory,
              paths: reference.paths,
              status: reference.status,
              omitted: document?.artifacts?.omittedJobIds?.includes(reference.jobId) ?? false,
            }),
          )
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
/** Transfer only reviewed plan, artifact references and plain tracking metadata. */
export async function startFreshImplementation(
  ctx: ExtensionCommandContext,
  plan: string,
  implementation?: ImplementationState,
) {
  if (implementation && implementation.hash !== planHash(plan))
    throw new Error("Fresh handoff contents do not match the reviewed plan.");
  const tracked = implementation ? structuredClone(implementation) : undefined;
  const prompt = implementationPrompt(plan, tracked?.document);
  const parentSession = ctx.sessionManager.getSessionFile();
  return ctx.newSession({
    ...(parentSession && existsSync(parentSession) ? { parentSession } : {}),
    ...(tracked
      ? {
          setup: async (manager: SessionManager) => {
            manager.appendCustomEntry(IMPLEMENTATION_ENTRY, tracked);
          },
        }
      : {}),
    withSession: async (replacement) => {
      try {
        await replacement.sendUserMessage(prompt);
      } catch {
        // The replacement owns all further operations. Captured old session APIs
        // must not be used even when the initial replacement request fails.
        try {
          replacement.ui.setEditorText(prompt);
          replacement.ui.notify(
            "Fresh session created, but implementation did not start. The request is in the editor; submit it or reopen the saved plan.",
            "error",
          );
        } catch {
          /* A further replacement owns the UI; the plan remains durable. */
        }
      }
    },
  });
}
