import { existsSync } from "node:fs";
import type { ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { IMPLEMENTATION_ENTRY, type ImplementationState } from "./implementation-state.js";

export function implementationPrompt(plan: string) {
  return `Implement the approved plan below. Planning is finished. Re-read files as needed and carry the work through implementation and verification.\n\n${plan}`;
}

/** Only the reviewed plan and plain tracking data cross; no source history is copied. */
export async function startFreshImplementation(
  ctx: ExtensionCommandContext,
  plan: string,
  implementation?: ImplementationState,
) {
  const prompt = implementationPrompt(plan);
  const parentSession = ctx.sessionManager.getSessionFile();
  return ctx.newSession({
    ...(parentSession && existsSync(parentSession) ? { parentSession } : {}),
    ...(implementation
      ? {
          setup: async (manager: SessionManager) => {
            manager.appendCustomEntry(IMPLEMENTATION_ENTRY, implementation);
          },
        }
      : {}),
    withSession: async (replacement) => {
      try {
        await replacement.sendUserMessage(prompt);
      } catch {
        // The new session exists even when its first request fails. Never use the old ctx here.
        try {
          replacement.ui.setEditorText(prompt);
          replacement.ui.notify(
            "Fresh session created, but implementation did not start. The request is in the editor; submit it or reopen the saved plan.",
            "error",
          );
        } catch {
          // A further session replacement makes this context stale too. The plan file is durable.
        }
      }
    },
  });
}
