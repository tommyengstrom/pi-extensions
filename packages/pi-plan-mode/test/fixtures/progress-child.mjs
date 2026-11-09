const mode = process.argv[2];
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  if (mode === "startup-timeout") {
    setInterval(() => {}, 1000);
    return;
  }
  emit({ type: "session", id: "fixture" });
  if (mode === "timeout" || mode === "ignore-term") {
    if (mode === "ignore-term") process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "malformed") {
    process.stdout.write("not json\n");
    return;
  }
  if (mode === "overflow") {
    process.stdout.write("x".repeat(3 * 1024 * 1024));
    return;
  }
  if (mode === "stderr") {
    process.stderr.write("private diagnostic".repeat(5000));
    return;
  }
  if (mode === "exit") {
    process.exitCode = 7;
    return;
  }
  if (mode === "missing") return;
  if (mode === "tool-event") emit({ type: "tool_execution_start" });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "NOT AUTHORITATIVE" } });
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "openai",
      model: mode === "mismatch" ? "wrong" : "gpt-6-luna",
      stopReason: ["error", "aborted", "length"].includes(mode) ? mode : "stop",
      content:
        mode === "tool"
          ? [{ type: "toolCall", name: "bash" }]
          : [{ type: "text", text: `- Reported ${input}\u2028evidence` }],
    },
  });
  emit({ type: "agent_settled", aborted: false });
});
