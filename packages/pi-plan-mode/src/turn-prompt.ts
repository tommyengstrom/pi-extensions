import type { SystemMessage } from "@earendil-works/pi-ai";
import type { ContextWithSystemEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Pi refreshes native tool declarations between tool rounds, but builds extension prompt
 * sections only at run start. Project our changed sections for the rest of this run. */
export function turnPrompt(pi: ExtensionAPI) {
  type Message = ContextWithSystemEvent["messages"][number];
  const patches: { index: number; anchor?: Pick<Message, "role" | "timestamp">; patch: SystemMessage }[] = [];
  let off: (() => void) | undefined;
  return {
    change(sections: Record<string, string | null>) {
      const patch: SystemMessage = { role: "system", content: "", sections, timestamp: Date.now() };
      patches.push({ index: -1, patch });
      off ??= pi.on("context_with_system", ({ messages }) => {
        // Keep the delta at its original request boundary on subsequent calls. If
        // compaction or a context filter replaced the prefix, only current policy matters.
        if (
          patches.some(
            ({ index, anchor }) =>
              index >= 1 &&
              (messages[index - 1]?.role !== anchor?.role || messages[index - 1]?.timestamp !== anchor?.timestamp),
          )
        ) {
          patches.splice(0, patches.length - 1);
          patches[0].index = -1;
        }
        const projected = [...messages];
        for (const [i, item] of patches.entries()) {
          if (item.index < 0) {
            item.index = messages.length;
            const last = messages.at(-1);
            item.anchor = last && { role: last.role, timestamp: last.timestamp };
          }
          projected.splice(item.index + i, 0, item.patch);
        }
        return { messages: projected };
      });
    },
    reset() {
      off?.();
      off = undefined;
      patches.length = 0;
    },
  };
}
