import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;
export function backgroundFixture(session = "session") {
  const emitter = new EventEmitter();
  const handlers = new Map<string, Handler[]>();
  const entries: Record<string, unknown>[] = [];
  const tools = new Map<string, Record<string, unknown>>();
  const commands = new Map<string, Record<string, unknown>>();
  const catalogue: ToolInfo[] = [];
  let active: string[] = [];
  let idle = true;
  let pending = false;
  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => session, getBranch: () => entries, getSessionFile: () => undefined },
    ui: { notify: vi.fn(), setStatus: vi.fn(), select: vi.fn(), confirm: vi.fn(), input: vi.fn() },
  } as unknown as ExtensionContext;
  const sendMessage = vi.fn();
  const pi = {
    events: {
      emit(name: string, value: unknown) {
        emitter.emit(name, value);
      },
      on(name: string, fn: (value: unknown) => void) {
        emitter.on(name, fn);
        return () => {
          emitter.off(name, fn);
        };
      },
    },
    on(name: string, fn: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
      return () => {
        const at = list.indexOf(fn);
        if (at >= 0) list.splice(at, 1);
      };
    },
    sendMessage,
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    getAllTools: () => catalogue,
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
    getThinkingLevel: () => "off",
    getMcpServers: () => [],
    registerTool(tool: Record<string, unknown>) {
      tools.set(String(tool.name), tool);
    },
    registerCommand(name: string, command: Record<string, unknown>) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    ctx,
    entries,
    tools,
    commands,
    catalogue,
    sendMessage,
    emitter,
    setIdle(value: boolean) {
      idle = value;
    },
    setPending(value: boolean) {
      pending = value;
    },
    handlerCount(name: string) {
      return handlers.get(name)?.length ?? 0;
    },
    async emit(name: string, event: Record<string, unknown> = {}, target = ctx) {
      let proposal = { ...event };
      for (const fn of [...(handlers.get(name) ?? [])]) {
        const result = await fn(proposal, target);
        if (result && typeof result === "object") proposal = { ...proposal, ...result };
      }
      return proposal;
    },
  };
}
