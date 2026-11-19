import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCall } from "@earendil-works/pi-ai";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";

type Item = { description: string; status: "running" | "failed" | "done" };
export interface Group {
  items: Item[];
  headline: string;
  pending: boolean;
}

function snippet(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
  if (text.length <= 64) return text;
  const chars: string[] = [];
  for (const char of text) {
    if (chars.length === 64) return `${chars.slice(0, 63).join("")}…`;
    chars.push(char);
  }
  return text;
}

// Only these built-ins get argument previews. Never fall back to stringifying arguments.
function describe(call: ToolCall): [string, string] {
  const pathLabel = (verb: string, fallback: string) => {
    const path = snippet(call.arguments?.path);
    return path ? `${verb} ${path}` : fallback;
  };
  switch (call.name) {
    case "read":
      return [pathLabel("Read", "Read file"), "read"];
    case "write":
      return [pathLabel("Write", "Write file"), "write"];
    case "edit":
      return [pathLabel("Edit", "Edit file"), "edit"];
    case "grep":
      return [pathLabel("Search", "Search contents"), "search"];
    case "find":
      return [pathLabel("Find files in", "Find files"), "search"];
    case "ls":
      return [pathLabel("List", "List files"), "listing"];
    case "bash":
      return ["Run command", "command"];
    default:
      return ["Tool call", "tool call"];
  }
}

function visibleBoundary(message: AgentMessage): boolean {
  return message.role !== "system" && !("display" in message && message.display === false);
}

/** Replay one ordered branch snapshot, including at most one snapshot per streaming message. */
export function groups(
  messages: readonly AgentMessage[],
  settings: { size: number; thinking: boolean },
  live: boolean,
  endOffsets?: ReadonlySet<number>,
): Group[] {
  const size = Number.isSafeInteger(settings.size) && settings.size > 0 ? settings.size : 5;
  const batches: { group: Group; counts: Map<string, number> }[] = [];
  const calls = new Map<string, Item>();
  const unresolved = new Set<Item>();
  let open: (typeof batches)[number] | undefined;

  function closeGroup() {
    if (open) open.group.pending = false;
    open = undefined;
  }
  function endRun() {
    closeGroup();
    // No successful completion is known for calls abandoned at a run boundary.
    for (const item of unresolved) item.status = "failed";
    unresolved.clear();
  }
  function add(description: string, kind: string, status: Item["status"]) {
    if (!open) {
      open = { group: { items: [], headline: "", pending: true }, counts: new Map() };
      batches.push(open);
    }
    const item = { description, status };
    open.group.items.push(item);
    open.counts.set(kind, (open.counts.get(kind) ?? 0) + 1);
    if (open.group.items.length === size) closeGroup();
    return item;
  }

  for (const [index, message] of messages.entries()) {
    if (endOffsets?.has(index)) endRun();
    if (message.role === "toolResult") {
      const item = calls.get(message.toolCallId);
      if (item) {
        item.status = message.isError ? "failed" : "done";
        unresolved.delete(item);
      }
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") {
          const item = add(...describe(block), "running");
          calls.set(block.id, item);
          unresolved.add(item);
        } else if (block.type === "thinking" && !block.redacted) {
          const excerpt = snippet(block.thinking);
          if (!excerpt) continue;
          if (settings.thinking) add(`Thinking: ${excerpt}`, "thought", "done");
          else closeGroup();
        } else if (block.type === "text" && snippet(block.text)) {
          closeGroup();
        }
      }
      if (message.stopReason !== "toolUse" && message.stopReason !== "pending") endRun();
    } else if (message.role === "user") {
      endRun();
    } else if (visibleBoundary(message)) {
      closeGroup();
    }
  }
  if (!live || endOffsets?.has(messages.length)) endRun();

  return batches.map(({ group, counts }) => {
    const summary =
      group.items.length === 1
        ? group.items[0].description
        : Array.from(counts, ([kind, n]) => `${n} ${kind}${n === 1 ? "" : kind === "search" ? "es" : "s"}`).join(", ");
    const failed = group.items.filter((item) => item.status === "failed").length;
    const running = group.items.filter((item) => item.status === "running").length;
    group.headline = [
      summary,
      ...(failed ? [`${failed} failed`] : []),
      ...(running ? [`${running} running`] : []),
    ].join(" · ");
    return group;
  });
}
