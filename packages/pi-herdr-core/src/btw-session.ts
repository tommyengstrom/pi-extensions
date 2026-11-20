import type { Message, UserMessage } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionCommandContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

/** A snapshot of model-visible conversation, never a handle to the live parent tree. */
export function sideConversation(ctx: ExtensionCommandContext, thinking: ReturnType<ExtensionAPI["getThinkingLevel"]>) {
  const { cwd, model, modelRegistry, sessionManager } = ctx;
  if (!model) throw new Error("Select a model before starting a side chat.");
  const parentSession = sessionManager.getSessionFile();
  const directory = parentSession ? sessionManager.getSessionDir() : undefined;
  const projected = sessionManager.buildSessionProjection().messages;
  // System entries carry tool declarations and workflow patches. Tool result details can
  // contain extension state which a resumed extension might mistakenly adopt.
  const messages: Message[] = structuredClone(convertToLlm(projected.filter((m) => m.role !== "system"))).map((m) => {
    if (m.role !== "toolResult") return m;
    return {
      role: m.role,
      toolCallId: m.toolCallId,
      toolName: m.toolName,
      content: m.content,
      isError: m.isError,
      timestamp: m.timestamp,
    };
  });
  const systemPrompt = `${ctx.getSystemPrompt()}\n\nThis is a separate side conversation. Answer the side question from conversation context. No tools are available; do not continue or execute the main task.`;
  let turns = 0;
  return {
    async ask(text: string, signal: AbortSignal) {
      signal.throwIfAborted();
      const question: UserMessage = { role: "user", content: text, timestamp: Date.now() };
      const answer = await modelRegistry
        .streamSimple(
          model,
          { systemPrompt, messages: [...messages, question] },
          { signal, reasoning: thinking === "off" ? undefined : thinking },
        )
        .result();
      signal.throwIfAborted();
      const reply = answer.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (answer.stopReason !== "stop" || !reply.trim() || answer.content.some((c) => c.type === "toolCall"))
        throw new Error("Side answer did not finish. You can ask again.");
      messages.push(question, answer);
      turns++;
      return reply;
    },
    save() {
      if (!turns) throw new Error("Ask a side question before continuing in Herdr.");
      const fork = SessionManager.create(cwd, directory, { parentSession });
      fork.appendSessionInfo("BTW");
      for (const m of messages) fork.appendMessage(m);
      fork.appendModelChange(model.provider, model.id);
      fork.appendThinkingLevelChange(thinking);
      const file = fork.getSessionFile();
      if (!file) throw new Error("Could not save the side conversation.");
      return file;
    },
  };
}
