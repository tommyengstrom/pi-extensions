import { type ExtensionAPI, type ExtensionCommandContext, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Editor, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { BackgroundRuntime } from "@narumitw/pi-background";
import { continueInDesktop, UnconfirmedTab } from "./btw-desktop.js";
import { sideConversation } from "./btw-session.js";
import { terminalText } from "./terminal-text.js";

export function registerBtw(pi: ExtensionAPI, background: BackgroundRuntime) {
  let active: { controller: AbortController; scope: string } | undefined;
  const stop = () => active?.controller.abort();
  const off = background.onRevoke((scope) => {
    if (scope === active?.scope) stop();
  });
  pi.on("session_tree", stop);
  pi.on("session_shutdown", () => {
    off();
    stop();
  });
  pi.registerCommand("btw", {
    description: "Ask a side question without changing this chat: /btw [prompt]",
    async handler(prompt, ctx) {
      if (ctx.mode !== "tui") throw new Error("/btw requires the interactive Pi terminal.");
      if (active) return ctx.ui.notify("A side chat is already open.", "warning");
      const owner = background.recipient(ctx);
      const controller = new AbortController();
      active = { controller, scope: owner.scope };
      const check = () => {
        controller.signal.throwIfAborted();
        if (!background.owns(owner, ctx)) throw new Error("Side chat session changed.");
      };
      try {
        const chat = sideConversation(ctx, ctx.thinkingLevel ?? pi.getThinkingLevel());
        const checkPromotion = () => {
          check();
          const workflow = background.workflow(ctx);
          if (
            workflow?.held ||
            workflow?.restrictions ||
            process.env.PI_HERDR_WORKER_DIR ||
            ctx.getSystemPromptOptions().hiddenTools?.length
          )
            throw new Error("Continue in Herdr is unavailable in this restricted workflow.");
        };
        await showChat(
          ctx,
          prompt,
          controller,
          (text) => {
            check();
            return chat.ask(text, controller.signal);
          },
          () => continueInDesktop(pi, ctx.cwd, controller.signal, checkPromotion, chat.save),
        );
      } finally {
        controller.abort();
        active = undefined;
      }
    },
  });
}

/** Keep both editor and transcript in one native overlay, without touching the parent editor. */
export async function showChat(
  ctx: ExtensionCommandContext,
  initial: string,
  controller: AbortController,
  ask: (text: string) => Promise<string>,
  promote: () => Promise<void>,
) {
  await ctx.ui.custom<void>(
    (tui, theme, keys, done) => {
      const editor = new Editor(tui, { borderColor: (s) => theme.fg("border", s), selectList: getSelectListTheme() });
      const history: string[] = [];
      let layout: { width: number; count: number; lines: string[] } | undefined;
      let offset = 0;
      let page = 1;
      let maxOffset = 0;
      let busy = false;
      let closed = false;
      let uncertain = false;
      let pasting = false;
      let status = "Ask a question about the current conversation.";
      const close = () => {
        if (closed) return;
        closed = true;
        controller.signal.removeEventListener("abort", close);
        controller.abort();
        done();
      };
      const submit = async (text: string, handoff: boolean) => {
        if (closed || busy || !text.trim()) return;
        if (handoff && uncertain) return;
        busy = editor.disableSubmit = true;
        offset = 0;
        status = handoff ? "Opening Herdr…" : "Answering…";
        if (!handoff) history.push(`You: ${terminalText(text)}`);
        tui.requestRender();
        try {
          if (handoff) {
            await promote();
            if (!closed) close();
          } else {
            const reply = await ask(text);
            if (!closed) {
              history.push(`Pi: ${terminalText(reply)}`);
              status = "Ask a follow-up.";
            }
          }
        } catch (error) {
          if (!closed) {
            uncertain ||= error instanceof UnconfirmedTab;
            history.push(terminalText(error instanceof Error ? error.message : "Side chat failed."));
            status = uncertain ? "Check Herdr; tab launch cannot be retried here." : "Side chat remains open.";
          }
        } finally {
          busy = editor.disableSubmit = false;
          if (!closed) tui.requestRender();
        }
      };
      editor.onSubmit = (text) => {
        void submit(text, text.trim() === "/herdr");
      };
      controller.signal.addEventListener("abort", close, { once: true });
      queueMicrotask(() => {
        if (controller.signal.aborted) close();
        else if (initial.trim()) void submit(initial, false);
      });
      return {
        get focused() {
          return editor.focused;
        },
        set focused(value: boolean) {
          editor.focused = value;
        },
        render(width: number) {
          const input = editor.render(width);
          page = Math.max(1, Math.floor(tui.terminal.rows * 0.8) - input.length - 3);
          if (!layout || layout.width !== width || layout.count !== history.length) {
            layout = {
              width,
              count: history.length,
              lines: history.flatMap((item) => wrapTextWithAnsi(item.replaceAll("\t", "    "), width)),
            };
          }
          const lines = layout.lines;
          maxOffset = Math.max(0, lines.length - page);
          offset = Math.min(offset, maxOffset);
          const end = lines.length - offset;
          return [
            theme.fg("accent", truncateToWidth("BTW · side conversation", width)),
            ...lines.slice(Math.max(0, end - page), end),
            truncateToWidth(status, width),
            ...input,
            theme.fg(
              "dim",
              truncateToWidth(
                `/herdr: Continue in Herdr · ${keys.getKeys("tui.select.cancel").join("/")}: close · ${keys.getKeys("tui.select.pageUp").join("/")}/${keys.getKeys("tui.select.pageDown").join("/")}: scroll`,
                width,
              ),
            ),
          ];
        },
        handleInput(data: string) {
          if (closed) return;
          if (pasting || data.includes("\x1b[200~")) {
            pasting = !data.includes("\x1b[201~");
            editor.handleInput(data);
          } else if (keys.matches(data, "tui.select.cancel")) close();
          else if (keys.matches(data, "tui.select.pageUp")) offset = Math.min(offset + page, maxOffset);
          else if (keys.matches(data, "tui.select.pageDown")) offset = Math.max(0, offset - page);
          else editor.handleInput(data);
          if (!closed) tui.requestRender();
        },
        invalidate() {
          editor.invalidate();
        },
        dispose: close,
      };
    },
    { overlay: true, overlayOptions: { width: "90%" } },
  );
}
