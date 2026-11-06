import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function thinkingShortcuts(pi: ExtensionAPI): void {
  function step(ctx: ExtensionContext, direction: -1 | 1): void {
    if (ctx.mode !== "tui") return;
    if (!ctx.model) {
      ctx.ui.notify("Thinking shortcuts are unavailable until a model is selected.", "info");
      return;
    }
    if (!ctx.model.reasoning) {
      ctx.ui.notify("This model does not support thinking.", "info");
      return;
    }

    // Resolve capabilities and state on every press: model changes and Pi's other
    // thinking controls must take effect without extension-owned session state.
    const levels = getSupportedThinkingLevels(ctx.model);
    const current = clampThinkingLevel(ctx.model, pi.getThinkingLevel());
    const index = levels.indexOf(current);
    const next = index < 0 ? undefined : levels[index + direction];
    if (next === undefined) {
      ctx.ui.notify(`Thinking is already at the ${direction < 0 ? "lowest" : "highest"} level (${current}).`, "info");
      return;
    }

    pi.setThinkingLevel(next);
    ctx.ui.notify(`Thinking: ${pi.getThinkingLevel()}`, "info");
  }

  pi.registerShortcut("alt+,", {
    description: "Decrease thinking effort",
    handler: (ctx) => step(ctx, -1),
  });
  pi.registerShortcut("alt+.", {
    description: "Increase thinking effort",
    handler: (ctx) => step(ctx, 1),
  });
}
