import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test, vi } from "vitest";
import { localLabel, Summaries } from "../src/provider/summaries.js";

type Context = { messages: { role: string; content: string }[]; systemPrompt: string };
type Options = { reasoning?: string; signal: AbortSignal };
const answer = (text = "Inspect the settings loader") => ({ stopReason: "stop", content: [{ type: "text", text }] });
function setup(thinking = false) {
  const model = { reasoning: thinking, thinkingLevelMap: thinking ? { off: null, minimal: null } : {} };
  const find = vi.fn((): typeof model | undefined => model);
  const result = vi.fn(async (): Promise<unknown> => answer());
  const streamSimple = vi.fn((_model: unknown, _ctx: Context, _opts: Options) => ({ result }));
  const ready = vi.fn();
  const registry = { find, streamSimple } as unknown as ExtensionContext["modelRegistry"];
  return { summaries: new Summaries(registry, ready), registry, ready, result, find, streamSimple };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test("registry request is isolated, deferred, complete, and deduplicated", async () => {
  const { summaries, ready, find, streamSimple } = setup(true);
  const args = Object.freeze({ path: "/private/account/settings.ts", offset: 2, limit: 100, password: "secret" });
  assert.equal(summaries.label("history"), undefined);
  summaries.schedule("live", "read", args);
  summaries.schedule("live", "bash", {});
  assert.equal(summaries.label("live"), "Inspect settings.ts");
  assert.equal(find.mock.calls.length, 0);
  await flush();
  assert.deepEqual(find.mock.calls, [["openai", "gpt-6-luna"]]);
  const [, context, options] = streamSimple.mock.calls[0];
  assert.equal(options.reasoning, "low");
  assert.deepEqual(Object.keys(context).sort(), ["messages", "systemPrompt"]);
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].role, "user");
  assert.deepEqual(JSON.parse(context.messages[0].content), {
    type: "toolCall",
    id: "live",
    name: "read",
    arguments: args,
  });
  assert.equal(summaries.label("live"), "Inspect the settings loader");
  assert.deepEqual(ready.mock.calls, [["live"]]);
  summaries.schedule("live", "read", args);
  await flush();
  assert.equal(streamSimple.mock.calls.length, 1);
});

test("local shell recognition does not restrict the live command payload", async () => {
  const { summaries, streamSimple } = setup();
  const command =
    "rg -n 'exportFromFile|export.*Html|export.*HTML' /private/main.js | head -25; rg -n 'exportFromFile|getToolRenderers:' /private/index.js; git diff --stat";
  const purpose = "Locate HTML export references and review git diff stats";
  assert.equal(localLabel("bash", { command }), purpose);
  const args = {
    command:
      "PC_PORT_NUM=49678 process-compose run check >/tmp/tool-summary-full-check.log 2>&1; s=$?; tail -12 /tmp/tool-summary-full-check.log; exit $s",
    timeout: 120,
  };
  summaries.schedule("b", "bash", args);
  await flush();
  assert.deepEqual(JSON.parse(streamSimple.mock.calls[0][1].messages[0].content), {
    type: "toolCall",
    id: "b",
    name: "bash",
    arguments: args,
  });
  assert.equal(
    localLabel("bash", { command: "rg 'password; git diff --stat' private-file" }),
    "Search for matching text",
  );
  assert.equal(localLabel("bash", { command: "bun run typecheck && bun run test" }), "Check types and run tests");
});

test("requests snapshot full writes, edits, and queued custom fields", async () => {
  const { summaries, streamSimple } = setup();
  const body = "private\n".repeat(10000);
  const nested = { fields: ["original"] };
  const calls = [
    { name: "write", arguments: { path: "/tmp/notes.md", content: body } },
    { name: "edit", arguments: { path: "notes.md", edits: [{ oldText: body, newText: "a\nb" }] } },
    { name: "custom/tool", arguments: { nested } },
  ].map((call, i) => ({ type: "toolCall", id: String(i), ...call }));
  const expected = structuredClone(calls);
  for (const call of calls) summaries.schedule(call.id, call.name, call.arguments);
  nested.fields.push("changed");
  await flush();
  assert.deepEqual(
    streamSimple.mock.calls.map(([, ctx]) => JSON.parse(ctx.messages[0].content)),
    expected,
  );
});

test("serialization failure keeps the local label without sending a partial call", async () => {
  const { summaries, streamSimple } = setup();
  summaries.schedule("bad", "write", { path: "notes.md", extra: 1n });
  await flush();
  assert.equal(streamSimple.mock.calls.length, 0);
  assert.equal(summaries.label("bad"), "Write notes.md");
});

test.each([
  answer("label\nsecond line"),
  answer("Successfully wrote the file"),
  answer("**Read settings**"),
  answer("\x1b[2J"),
  answer("x\u202ey"),
  answer("x".repeat(97)),
  answer(" "),
  { ...answer(), stopReason: "length" },
  { ...answer(), content: [...answer().content, { type: "toolCall" }] },
])("unsuitable provider response leaves fallback intact", async (reply) => {
  const { summaries, result, ready } = setup();
  result.mockResolvedValue(reply);
  summaries.schedule("a", "bash", {});
  await flush();
  assert.equal(summaries.label("a"), "Run shell command");
  assert.equal(ready.mock.calls.length, 0);
});

test("unavailable model and failed authentication keep the local label", async () => {
  const { summaries, find, result, ready } = setup();
  find.mockReturnValueOnce(undefined);
  result.mockRejectedValue(new Error("no credentials"));
  for (const id of ["a", "b"]) summaries.schedule(id, "write", { path: "out.txt" });
  await flush();
  for (const id of ["a", "b"]) assert.equal(summaries.label(id), "Write out.txt");
  assert.equal(result.mock.calls.length, 1);
  assert.equal(ready.mock.calls.length, 0);
});

test("deadline releases slots even when provider ignores abort; overflow never retries", async () => {
  const { summaries, result, ready, streamSimple } = setup();
  result.mockImplementationOnce(() => new Promise(() => {})).mockImplementationOnce(() => new Promise(() => {}));
  for (let i = 0; i < 18; i++) summaries.schedule(String(i), "read", {});
  const toJSON = vi.fn();
  summaries.schedule("19", "read", { toJSON });
  assert.equal(toJSON.mock.calls.length, 0);
  await flush();
  assert.equal(result.mock.calls.length, 2);
  await vi.advanceTimersByTimeAsync(10000);
  assert.ok(streamSimple.mock.calls[0][2].signal.aborted);
  summaries.schedule("19", "read", {});
  await flush();
  assert.equal(result.mock.calls.length, 18);
  assert.equal(ready.mock.calls.length, 16);
  assert.equal(summaries.label("0"), "Inspect path");
  assert.equal(summaries.label("19"), "Inspect path");
  assert.equal(vi.getTimerCount(), 0);
});

test("aborting a turn cancels its running and queued requests", async () => {
  const { summaries, result, streamSimple, ready } = setup();
  result.mockImplementation(() => new Promise(() => {}));
  const turn = new AbortController();
  for (const id of ["a", "b", "c"]) summaries.schedule(id, "read", {}, turn.signal);
  await flush();
  turn.abort();
  await flush();
  assert.equal(result.mock.calls.length, 2);
  assert.ok(streamSimple.mock.calls.every(([, , opts]) => opts.signal.aborted));
  assert.equal(ready.mock.calls.length, 0);
  assert.equal(vi.getTimerCount(), 0);
});

test("session replacement aborts active and discards queued and late work", async () => {
  const { summaries, result, registry, ready, streamSimple } = setup();
  let finish!: (value: unknown) => void;
  const late = new Promise((resolve) => {
    finish = resolve;
  });
  result.mockReturnValue(late);
  for (const id of ["a", "b", "c"]) summaries.schedule(id, "bash", {});
  await flush();
  summaries.dispose();
  summaries.schedule("d", "bash", {});
  assert.ok(streamSimple.mock.calls.every(([, , opts]) => opts.signal.aborted));
  const next = new Summaries(registry, ready);
  result.mockResolvedValue(answer("Inspect next session"));
  next.schedule("a", "read", {});
  finish(answer("Stale label"));
  await flush();
  assert.equal(summaries.label("a"), undefined);
  assert.equal(next.label("a"), "Inspect next session");
  assert.deepEqual(ready.mock.calls, [["a"]]);
  assert.equal(result.mock.calls.length, 3);
  assert.equal(vi.getTimerCount(), 0);
});
