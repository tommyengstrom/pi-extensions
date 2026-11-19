import { isKeyRelease, type KeybindingsManager, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { formatInteractionHints } from "@narumitw/pi-tui-kit/interaction-hints";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type { Group } from "./model.js";

function summary(group: Group): string {
  const labels = [`${group.items.length} item${group.items.length === 1 ? "" : "s"}`];
  if (group.pending) labels.push("pending");
  return `${labels.join(" · ")}  ${sanitizeTerminalText(group.headline)}`;
}

export function createView(getGroups: () => Group[], tui: TUI, done: () => void, keybindings: KeybindingsManager) {
  let expanded = -1;
  let cursor = 0;
  let top = 0;
  let followLatest = true;
  let closed = false;

  // Rows consist of one header per group plus the items of the one open group.
  // Map visible rows on demand rather than formatting the entire branch on every render.
  function layout() {
    const groups = getGroups();
    if (expanded >= groups.length) expanded = -1;
    const children = expanded < 0 ? 0 : groups[expanded].items.length;
    const count = groups.length + children;
    const last = Math.max(0, count - 1);
    const height = Math.max(0, tui.terminal.rows);
    const body = Math.max(1, height - Number(height >= 2) - Number(height >= 3));
    cursor = followLatest ? last : Math.min(cursor, last);
    top = Math.max(0, Math.min(Math.max(top, cursor - body + 1), cursor, count - body));
    const groupAt = (row: number) => (row <= expanded ? row : Math.max(expanded, row - children));
    return { groups, last, height, body, groupAt };
  }

  return {
    invalidate() {}, // No cached lines: live group updates are read at render time.
    render(width: number): string[] {
      if (closed || width <= 0) return [];
      const { groups, last, height, body, groupAt } = layout();
      if (!height) return [];
      const lines: string[] = height >= 2 ? ["Activity digest"] : [];
      if (!groups.length) lines.push("No activity on this branch.");
      else {
        for (let row = top; row <= last && row < top + body; row++) {
          const index = groupAt(row);
          const group = groups[index];
          const marker = row === cursor ? "> " : "  ";
          if (index === expanded && row > index) {
            const item = group.items[row - index - 1];
            lines.push(`${marker}  [${item.status}] ${sanitizeTerminalText(item.description)}`);
          } else lines.push(`${marker}${index === expanded ? "▾" : "▸"} ${summary(group)}`);
        }
      }
      if (height >= 3) {
        lines.push(
          formatInteractionHints(keybindings, [
            { bindings: ["tui.select.up", "tui.select.down"], label: "move" },
            { bindings: ["tui.select.confirm"], label: "toggle" },
            { bindings: ["tui.select.cancel"], label: "close" },
          ]),
        );
      }
      return lines.map((line) => truncateToWidth(line, width));
    },
    handleInput(data: string): void {
      if (closed || isKeyRelease(data)) return;
      const matches = (action: Parameters<KeybindingsManager["matches"]>[1]) => keybindings.matches(data, action);
      if (matches("tui.select.cancel")) {
        closed = true;
        done();
        return;
      }
      const { groups, body, last, groupAt } = layout();
      if (!groups.length) return;
      if (matches("tui.select.confirm")) {
        const index = groupAt(cursor);
        expanded = expanded === index ? -1 : index;
        cursor = index;
        top = index;
        followLatest = expanded < 0 && index === groups.length - 1;
      } else {
        let delta: number;
        if (matches("tui.select.up")) delta = -1;
        else if (matches("tui.select.down")) delta = 1;
        else if (matches("tui.select.pageUp")) delta = -body;
        else if (matches("tui.select.pageDown")) delta = body;
        else return;
        cursor = Math.max(0, Math.min(cursor + delta, last));
        followLatest = expanded < 0 && cursor === last;
      }
      tui.requestRender();
    },
  };
}
