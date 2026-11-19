import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { type Component, Container, getCapabilities, MouseRegion, Text, truncateToWidth } from "@earendil-works/pi-tui";

import { localLabel } from "../provider/summaries.js";

export interface RendererSession {
  native: boolean;
  label(callId: string): string | undefined;
  watch(callId: string, invalidate: () => void): void;
}

// JSON already quotes C0 inside strings. Also escape C1 and direction/line
// controls, which JSON.stringify otherwise leaves literal. Keep layout newlines.
function safeLines(text: string): string {
  return text.replace(/[\p{Cc}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, (c) =>
    c === "\n" ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function inline(text: string): string {
  return safeLines(text).replaceAll("\n", "\\n");
}

function exact(args: unknown): string {
  return safeLines(JSON.stringify(args, null, 2) ?? "(no arguments)");
}

// Pi builds both slots before it lays out either. Measure the same expanded
// components at the width Pi gives the header, including renderer-specific
// footers and wrapped lines, but not the host's outer shell or inline images.
class Folded implements Component {
  result?: Component;
  private width?: number;
  private header = new Text("", 0, 0);

  constructor(
    private call: Component,
    private caption: (count: number) => string,
  ) {}
  render(width: number) {
    if (this.width !== width) {
      const lines = this.call.render(width).length + (this.result?.render(width).length ?? 0);
      this.header.setText(this.caption(lines));
      this.width = width;
    }
    return this.header.render(width);
  }
  invalidate() {
    this.width = undefined;
    this.call.invalidate();
    this.result?.invalidate();
  }
}

class Row {
  folded?: Folded;
  downstream = {};
  call?: Component;
  result?: Component;
  invalidate?: () => void;
  hasResult = false;
  inspecting = false;
  pendingArgs = new Container();
}

export function createRenderer(active: () => RendererSession | undefined): ToolRendererResolver {
  return (name, next) => {
    const downstream = next();
    const session = active();
    if (!session) return downstream;

    // Resolvers can be shared by several executions. Pi's state object, not
    // the tool name or even the persisted call ID, identifies a mounted row.
    const rows = new WeakMap<object, Row>();
    function rowFor(key: object): Row {
      let row = rows.get(key);
      if (!row) {
        row = new Row();
        rows.set(key, row);
      }
      return row;
    }

    return {
      renderShell: downstream?.renderShell,
      renderCall(args, theme, ctx) {
        const row = rowFor(ctx.state);
        if (!row.invalidate && active() === session) {
          row.invalidate = ctx.invalidate;
          session.watch(ctx.toolCallId, row.invalidate);
        }
        row.folded = undefined;
        const native = session.native && !ctx.expanded;
        const measure = !native && !ctx.expanded && !ctx.isPartial;
        if (measure) ctx = { ...ctx, expanded: true };
        const title = theme.style(inline(name), { fg: "toolTitle", bold: true });
        const complete = ctx.argsComplete || ctx.executionStarted || !ctx.isPartial;
        const status = ctx.isError
          ? theme.fg("error", " [failed]")
          : ctx.isPartial
            ? theme.fg("warning", " [pending]")
            : "";
        const caption = (count: string | number, open = false) => {
          const label = session.label(ctx.toolCallId) || localLabel(name, args);
          return `${open ? "▾" : "▸"} ${title} [${count}] ${truncateToWidth(inline(label.slice(0, 256)), 96)}${status}`;
        };
        const present = (body: Component) => {
          if (!measure) return body;
          row.folded = new Folded(body, caption);
          return row.folded;
        };
        const inputs = () => (complete ? exact(args) : `Arguments streaming (incomplete)\n${exact(args)}`);
        if (ctx.expanded || native) row.inspecting = false;
        const callBody = (expanded: boolean) => {
          if (downstream?.renderCall) {
            try {
              row.call = downstream.renderCall(args, theme, {
                ...ctx,
                expanded,
                state: row.downstream,
                lastComponent: row.call,
              });
              if (expanded && !complete) {
                const block = new Container();
                block.addChild(new Text("Arguments streaming (incomplete)", 0, 0));
                block.addChild(row.call);
                return block;
              }
              return row.call;
            } catch {
              row.call = undefined;
            }
          }
          return expanded
            ? new Text(`${title}${status}\n${inputs()}`, 0, 0)
            : new Text(`${title} ${truncateToWidth(inline(JSON.stringify(args) ?? ""), 90)}${status}`, 0, 0);
        };
        if (native || ctx.expanded) return present(callBody(ctx.expanded));

        const header = new Text(caption("…", row.inspecting), 0, 0);
        if (row.hasResult || !ctx.isPartial) return header;

        const block = new Container();
        block.addChild(
          new MouseRegion(header, (event) => {
            // Pi calls renderCall before renderResult, including on the first
            // partial result. Check at event time to yield to its outer region.
            if (row.hasResult || event.type !== "click" || event.button !== "left") return undefined;
            row.inspecting = !row.inspecting;
            ctx.invalidate();
            return { handled: true };
          }),
        );
        row.pendingArgs.clear();
        if (row.inspecting) row.pendingArgs.addChild(callBody(true));
        block.addChild(row.pendingArgs);
        return block;
      },
      renderResult(result, options, theme, ctx) {
        const row = rowFor(ctx.state);
        row.hasResult = true;
        row.inspecting = false;
        row.pendingArgs.clear();
        const folded = row.folded;
        if (folded) {
          ctx = { ...ctx, expanded: true };
          options = { ...options, expanded: true };
        }
        const present = (body: Component) => {
          if (!folded) return body;
          folded.result = body;
          return new Container();
        };
        // Don't start downstream previews or timers merely to estimate a live result.
        if (!ctx.expanded && !session.native) return new Container();
        if (downstream?.renderResult) {
          try {
            row.result = downstream.renderResult(result, options, theme, {
              ...ctx,
              state: row.downstream,
              lastComponent: row.result,
            });
            return present(row.result);
          } catch {
            row.result = undefined;
          }
        }
        const text = result.content
          .flatMap((part) => {
            if (part.type === "text") return [safeLines(part.text)];
            return ctx.showImages && getCapabilities().images ? [] : [`[Image: ${inline(part.mimeType)}]`];
          })
          .join("\n");
        const lines = text.split("\n");
        const preview =
          !ctx.expanded && lines.length > 10
            ? `${lines.slice(0, 10).join("\n")}\n${ctx.keyHint("app.tools.expand", "to expand")}`
            : text;
        return present(new Text(theme.fg(ctx.isError ? "error" : "toolOutput", preview), 0, 0));
      },
    };
  };
}
