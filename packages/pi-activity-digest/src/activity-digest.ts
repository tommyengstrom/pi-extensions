import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type ExtensionAPI,
  type ExtensionContext,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { groups } from "./model.js";
import { parseChange, readSettings, updateSettings } from "./settings.js";
import { createView } from "./view.js";

type Manager = ExtensionContext["sessionManager"];
type Result = Extract<AgentMessage, { role: "toolResult" }>;
type Settings = ReturnType<typeof readSettings>;

// Pi drains message events serially and persists message_end *after* extension
// handlers. Only the current message can be ahead of the branch. Anchor it to
// the preceding leaf, not a timestamp (parallel messages can share a clock tick).
class Session {
  live = false;
  pending?: { after: string | null; message: AgentMessage };
  readonly results = new Map<string, Result>();
  readonly boundaries = new Set<string>();
  constructor(readonly manager: Manager) {}

  boundary() {
    const leaf = this.manager.getLeafId();
    if (leaf !== null) this.boundaries.add(leaf);
  }

  snapshot(settings: Settings) {
    const messages: AgentMessage[] = [];
    const ends = new Set<number>();
    const tail = this.pending;
    let afterAnchor = tail?.after === null;
    let persisted = false;
    const outstanding = new Map(this.results);
    for (const entry of this.manager.getBranch()) {
      for (const m of sessionEntryToContextMessages(entry)) {
        messages.push(m);
        if (m.role === "toolResult") outstanding.delete(m.toolCallId);
        if (afterAnchor && m.role === tail?.message.role) persisted = true;
      }
      if (this.boundaries.has(entry.id)) ends.add(messages.length);
      if (entry.id === tail?.after) afterAnchor = true;
    }
    if (tail && afterAnchor && !persisted) {
      messages.push(tail.message);
      if (tail.message.role === "toolResult") outstanding.delete(tail.message.toolCallId);
    }
    for (const result of outstanding.values()) messages.push(result);
    return groups(messages, settings, this.live, ends);
  }
}

interface Screen {
  settings: Settings;
  refresh?: () => void;
  finish?: () => void;
}

export default function activityDigest(pi: ExtensionAPI) {
  let session: Session | undefined;
  let screen: Screen | undefined;
  const close = () => {
    const previous = screen;
    screen = undefined;
    previous?.finish?.();
  };
  const owned = (ctx: ExtensionContext) =>
    ctx.mode === "tui" && ctx.hasUI && session?.manager === ctx.sessionManager ? session : undefined;

  pi.on("session_start", (_, ctx) => {
    close();
    session = ctx.mode === "tui" && ctx.hasUI ? new Session(ctx.sessionManager) : undefined;
  });
  pi.on("session_shutdown", (_, ctx) => {
    if (!owned(ctx)) return;
    close();
    session = undefined;
  });
  pi.on("session_tree", (_, ctx) => {
    const s = owned(ctx);
    if (!s) return;
    close();
    s.live = false;
    s.pending = undefined;
    s.results.clear(); // Boundary entry IDs remain valid on their own branches.
  });
  pi.on("agent_start", (_, ctx) => {
    const s = owned(ctx);
    if (!s) return;
    s.boundary();
    s.live = true;
    screen?.refresh?.();
  });
  const observe = (m: AgentMessage, ctx: ExtensionContext, start: boolean) => {
    const s = owned(ctx);
    if (!s || (m.role !== "assistant" && m.role !== "user" && m.role !== "toolResult")) return;
    if (start || !s.pending || s.pending.message.role !== m.role) {
      s.pending = { after: s.manager.getLeafId(), message: m };
    } else s.pending.message = m;
    if (m.role === "toolResult") s.results.delete(m.toolCallId);
    screen?.refresh?.();
  };
  pi.on("message_start", (e, ctx) => observe(e.message, ctx, true));
  pi.on("message_update", (e, ctx) => observe(e.message, ctx, false));
  pi.on("message_end", (e, ctx) => observe(e.message, ctx, false));
  pi.on("tool_execution_end", (e, ctx) => {
    const s = owned(ctx);
    if (!s?.live || e.parentToolCallId !== undefined) return;
    // Temporary status only; never retain execution output or add transcript entries.
    s.results.set(e.toolCallId, {
      role: "toolResult",
      toolCallId: e.toolCallId,
      toolName: e.toolName,
      isError: e.isError,
      content: [],
      timestamp: Date.now(),
    });
    screen?.refresh?.();
  });
  pi.on("agent_end", (_, ctx) => {
    const s = owned(ctx);
    if (!s) return;
    s.boundary();
    s.live = false;
    s.pending = undefined;
    s.results.clear();
    screen?.refresh?.();
  });

  pi.registerCommand("digest", {
    description: "View branch activity, or configure size <n> / thinking on|off",
    handler: async (args, ctx) => {
      const s = owned(ctx);
      if (!s) return;
      let settings: Settings;
      if (args.trim()) {
        let change: ReturnType<typeof parseChange>;
        try {
          change = parseChange(args);
        } catch {
          ctx.ui.notify("Use /digest size <positive integer> or /digest thinking on|off", "error");
          return;
        }
        try {
          settings = updateSettings(change);
        } catch {
          ctx.ui.notify("Could not update activity digest settings. Check the settings file.", "error");
          return;
        }
        if (screen) {
          screen.settings = settings;
          screen.refresh?.();
        }
        ctx.ui.notify(
          `Digest: ${settings.size} items per group, thinking ${settings.thinking ? "on" : "off"}.`,
          "info",
        );
        return;
      }
      if (screen) return;
      try {
        settings = readSettings();
      } catch {
        ctx.ui.notify("Cannot read activity digest settings. Check the settings file.", "error");
        return;
      }
      const owner: Screen = { settings };
      screen = owner;
      try {
        await ctx.ui.custom<void>((tui, _theme, keys, done) => {
          if (screen !== owner) {
            done();
            return { render: () => [], invalidate() {} };
          }
          let cached: ReturnType<typeof groups> | undefined;
          let leaf: string | null;
          owner.finish = () => done();
          owner.refresh = () => {
            cached = undefined;
            tui.requestRender();
          };
          const view = createView(
            () => {
              if (screen !== owner) return [];
              const current = s.manager.getLeafId();
              if (!cached || leaf !== current) {
                cached = s.snapshot(owner.settings);
                leaf = current;
              }
              return cached;
            },
            tui,
            () => {
              if (screen === owner) close();
            },
            keys,
          );
          return {
            invalidate: view.invalidate,
            render: (width: number) => (screen === owner ? view.render(width) : []),
            handleInput(data: string) {
              if (screen === owner) view.handleInput(data);
            },
            capturesViewportInput: true,
            dispose() {
              cached = undefined;
              owner.refresh = undefined;
              owner.finish = undefined;
              if (screen === owner) screen = undefined;
            },
          };
        });
      } finally {
        if (screen === owner) screen = undefined;
      }
    },
  });
}
