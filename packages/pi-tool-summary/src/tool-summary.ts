import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Summaries } from "./provider/summaries.js";
import { createRenderer } from "./ui/renderer.js";

class View {
  native = false;
  // A branch change or transcript rebuild can unmount a row without a disposal hook.
  private readonly rows = new Map<string, Set<WeakRef<() => void>>>();
  private summaries?: Summaries;

  bind(ctx: ExtensionContext) {
    this.summaries = new Summaries(ctx.modelRegistry, (id) => this.refresh(id));
  }
  schedule(id: string, name: string, args: unknown, turn?: AbortSignal) {
    if (!this.native) this.summaries?.schedule(id, name, args, turn);
  }
  watch(id: string, invalidate: () => void) {
    const refs = this.rows.get(id) ?? new Set<WeakRef<() => void>>();
    refs.add(new WeakRef(invalidate));
    this.rows.set(id, refs);
  }
  private refresh(id: string) {
    const refs = this.rows.get(id);
    if (!refs) return;
    for (const ref of refs) {
      const invalidate = ref.deref();
      if (invalidate) invalidate();
      else refs.delete(ref);
    }
    if (!refs.size) this.rows.delete(id);
  }
  label(id: string) {
    return this.summaries?.label(id);
  }
  toggle() {
    this.native = !this.native;
    for (const id of this.rows.keys()) this.refresh(id);
  }
  dispose() {
    this.rows.clear();
    this.summaries?.dispose();
  }
}

export default function toolSummary(pi: ExtensionAPI) {
  // On /resume Pi can construct historical TUI rows before session_start.
  // Give those rows a local-only view; bind provider work only after startup.
  let view: View | undefined = new View();
  let owner: ExtensionContext["sessionManager"] | undefined;
  pi.registerToolRenderer(createRenderer(() => view));
  pi.on("session_start", (_, ctx) => {
    if (owner || ctx.mode !== "tui") {
      view?.dispose();
      view = undefined;
    }
    owner = ctx.sessionManager;
    if (ctx.mode === "tui") {
      view ??= new View();
      view.bind(ctx);
    }
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (ctx.mode === "tui" && owner === ctx.sessionManager && event.parentToolCallId === undefined)
      view?.schedule(event.toolCallId, event.toolName, event.args, ctx.signal);
  });
  pi.registerCommand("tool-view", {
    description: "Toggle summarized or native collapsed tool calls",
    handler: async (_, ctx) => {
      if (view && ctx.mode === "tui" && owner === ctx.sessionManager) {
        view.toggle();
        ctx.ui.notify(`Compact tool view: ${view.native ? "native" : "summarized"}`, "info");
      }
    },
  });
  pi.on("session_shutdown", (_, ctx) => {
    if (owner !== ctx.sessionManager) return;
    view?.dispose();
    view = undefined;
    owner = undefined;
  });
}
