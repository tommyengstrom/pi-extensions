// From the built workspace root: node packages/pi-herdr-core/test/acceptance.mjs
// The controller owns the local provider and Pi RPC transport, not a Pi session.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const repo = resolve(".");
const manifest = findPackageJSON(
  "@earendil-works/pi-coding-agent",
  pathToFileURL(join(repo, "packages/pi-herdr-core/package.json")),
);
const sdk = JSON.parse(await readFile(manifest, "utf8"));
assert.equal(sdk.version, "1.5.1");
const cli = resolve(dirname(manifest), sdk.bin.pi);
assert.equal(execFileSync("hc", ["--version"], { encoding: "utf8" }).trim(), "hc 0.1.18");
const root = await mkdtemp(join(tmpdir(), "pi-hc-"));
const agent = join(root, "agent");
const env = {
  HOME: root,
  PATH: process.env.PATH,
  HC_SESSION: "test",
  HC_SOCKET: join(root, "core.sock"),
  XDG_RUNTIME_DIR: root,
  XDG_STATE_HOME: root,
  XDG_CONFIG_HOME: root,
  PI_CODING_AGENT_DIR: agent,
  PI_OFFLINE: "1",
};
const hc = (...args) => execFileSync("hc", args, { cwd: root, env, encoding: "utf8", timeout: 15000 });
const terminals = () => JSON.parse(hc("ls", "--all")).terminals;
const get = (id) => JSON.parse(hc("get", id));
const json = (file, value) => writeFile(file, JSON.stringify(value));
async function until(label, check, ms = 45000) {
  const end = Date.now() + ms;
  do {
    const value = await check();
    if (value) return value;
    await delay(75);
  } while (Date.now() < end);
  throw Error(`Timed out: ${label}`);
}
const longAnswer = `verified final answer\n${"0123456789abcdef".repeat(4096)}\nend-of-full-answer`;
const requests = [];
const commands = new Map();
const toolCall = (id, name, args) => ({
  tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const provider = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions");
    let raw = "";
    for await (const part of req) raw += part;
    const { model, messages, tools = [] } = JSON.parse(raw);
    assert.equal(model, "fixture");
    const users = messages.filter((m) => m.role === "user");
    const text = (m) =>
      typeof m?.content === "string" ? m.content : (m?.content ?? []).map((b) => b.text ?? "").join("");
    const task = text(users[0]);
    const names = tools.map((t) => t.function.name);
    let delta = { content: "acknowledged" };
    if (task.startsWith("Delegated task:\n")) {
      requests.push({ task, messages, names });
      if (task.includes("hang-marker")) return; // worker must be killed while awaiting the provider
      delta =
        names.includes("websearch") && !messages.some((m) => m.role === "tool")
          ? toolCall("search1", "websearch", {})
          : { content: task.endsWith("--tools bash") ? longAnswer : "verified final answer" };
    } else if (messages.at(-1)?.role === "user") {
      for (const [id, { name, args }] of commands)
        if (text(messages.at(-1)).includes(id)) {
          assert.ok(names.includes(name), `parent did not declare ${name}`);
          delta = toolCall(id, name, args);
          commands.delete(id);
          break;
        }
    }
    const event = (delta, finish_reason) =>
      `data: ${JSON.stringify({ id: "local", model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`${event(delta, null) + event({}, delta.tool_calls ? "tool_calls" : "stop")}data: [DONE]\n\n`);
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end("invalid local fixture request");
  }
});
const fifo = join(root, "input");
const output = join(root, "events.jsonl");
let input;
let parent;
let started = false;
// Only read complete JSONL records. Each request/event is correlated by ID, never by terminal text.
async function events() {
  const lines = (await readFile(output, "utf8")).split("\n");
  lines.pop();
  return lines.filter(Boolean).map((l) => JSON.parse(l));
}
async function rpc(type, fields = {}) {
  const id = randomUUID();
  await input.write(`${JSON.stringify({ type, id, ...fields })}\n`);
  const r = await until(type, async () => (await events()).find((e) => e.type === "response" && e.id === id));
  assert.ok(r.success, r.error);
  return r.data;
}
const prompt = (message) => rpc("prompt", { message, streamingBehavior: "followUp" });
async function run(name, args) {
  const id = `call_${randomUUID().replaceAll("-", "")}`;
  commands.set(id, { name, args });
  await prompt(id);
  const e = await until(name, async () => {
    const history = await events();
    const i = history.findIndex((e) => e.type === "tool_execution_end" && e.toolCallId === id);
    return i >= 0 && history.slice(i + 1).some((e) => e.type === "agent_settled") && history[i];
  });
  assert.equal(e.toolName, name);
  if (e.isError) throw Error(JSON.stringify(e.result.content));
  return e.result.details;
}
const launch = async (task, agent) => (await run("subagent", { task, agent })).job;
const wait = async (id) => (await run("subagent_wait", { id, timeout: 30000 })).job;
const list = async () => (await run("subagent_query", { action: "list" })).jobs;
function omitted(job, name) {
  assert.ok(
    Array.isArray(job.omissions) && job.omissions.every((s) => typeof s === "string"),
    "expected job.omissions: string[]",
  );
  assert.ok(
    job.omissions.some((s) => s.includes(name) && /[a-z]{3}/i.test(s.replace(name, ""))),
    `missing omission reason for ${name}`,
  );
}
try {
  await new Promise((ok, no) => provider.once("error", no).listen(0, "127.0.0.1", ok));
  const profiles = join(agent, "pi-herdr-core/profiles");
  await mkdir(profiles, { recursive: true });
  await json(join(profiles, "reviewer.json"), { instructions: "reviewer-role-marker", tools: [] });
  await json(join(agent, "settings.json"), { retry: { enabled: false } });
  await json(join(agent, "models.json"), {
    providers: {
      fixture: {
        api: "openai-completions",
        apiKey: "local-only",
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        models: [
          {
            id: "fixture",
            name: "Fixture",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 32768,
          },
        ],
      },
    },
  });
  const deferred = "mcp__fixture__deferred";
  const resource = "read_mcp_resource";
  await json(join(agent, "pi-plan-mode.json"), {
    tools: ["subagent", "subagent_query", "subagent_wait", "subagent_cancel", "websearch", deferred, resource],
  });
  const mcp = join(root, "mcp.mjs");
  await writeFile(
    mcp,
    `import { createInterface } from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
  const r = JSON.parse(line); if (r.id === undefined) continue;
  const result = r.method === 'initialize' ? {protocolVersion:'2024-11-05', capabilities:{tools:{},resources:{}},serverInfo:{name:'fixture',version:'1'}}
    : r.method === 'tools/list' ? {tools:['deferred','forbidden'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{}}}))}
    : r.method === 'resources/list' ? {resources:[{name:'private',uri:'fixture://private'}]}
    : r.method === 'resources/read' ? {contents:[{uri:'fixture://private',text:'private resource'}]}
    : r.method === 'tools/call' ? {content:[{type:'text',text:'called '+r.params.name}]} : {};
  console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));
}`,
  );
  const server = { command: process.execPath, args: [mcp], exposure: "deferred" };
  await json(join(agent, "mcp.json"), { mcpServers: { fixture: server, other: server } });
  const marker = join(root, "calls.json");
  const fixture = join(root, "search.ts");
  const denied = ["dangerous", "subagent", "plan_mode_complete", "mcp__fixture__forbidden", resource];
  const source = `import {writeFileSync} from 'node:fs';
export default function(pi) {
  pi.registerCommand('fixture-ready',{description:'Wait for fixture inventory',handler:async()=>{
    const deadline=Date.now()+10000;
    while (![${JSON.stringify(deferred)},${JSON.stringify(resource)}].every(n=>pi.getAllTools().some(t=>t.name===n))) {
      if(Date.now()>deadline) throw Error('MCP inventory missing'); await new Promise(r=>setTimeout(r,50));
    }
  }});
  for(const name of ['websearch','dangerous']) pi.registerTool({name,label:name,description:name,parameters:{type:'object',properties:{}},
    async execute(_id,_args,_s,_u,ctx){
      if(name==='dangerous')return {content:[{type:'text',text:'UNAUTHORIZED dispatch'}]};
      const calls={}; for(const tool of ${JSON.stringify([...denied, deferred])}) {
        try {calls[tool]=await ctx.executeTool(tool,tool==='read_mcp_resource'?{server:'other',uri:'fixture://private'}:{});}
        catch(e){calls[tool]={isError:true};}
      }
      writeFileSync(${JSON.stringify(marker)},JSON.stringify(calls));return {content:[{type:'text',text:'local search result'}]};
    }});
}`;
  await writeFile(fixture, source);
  // Redirection only: exec replaces sh with Pi, retaining the actual Core terminal identity.
  execFileSync("mkfifo", [fifo], { env });
  input = await open(fifo, "r+");
  await writeFile(output, "");
  hc("server", "start");
  started = true;
  parent = JSON.parse(
    hc(
      "run",
      "--bg",
      "--cwd",
      root,
      "--",
      "sh",
      "-c",
      'in=$1; out=$2; shift 2; exec "$@" <"$in" >"$out"',
      "rpc",
      fifo,
      output,
      process.execPath,
      cli,
      "--mode",
      "rpc",
      "--offline",
      "--approve",
      "--provider",
      "fixture",
      "--model",
      "fixture",
      "--thinking",
      "off",
      "--no-skills",
      "--no-prompt-templates",
      "--no-extensions",
      "-e",
      join(repo, "packages/pi-plan-mode/src/index.ts"),
      "-e",
      join(repo, "packages/pi-herdr-core/src/index.ts"),
      "-e",
      fixture,
      "-e",
      "builtin:mcp",
    ),
  ).address;
  await prompt("/fixture-ready");
  await prompt("/plan start");
  await assert.rejects(launch("unknown", "missing"), /Unknown.*profile/i);
  assert.equal(terminals().length, 1);
  const prior = new Set((await list()).map((j) => j.id));
  await prompt("/subagent /plan exit");
  const launched = (await list()).filter((j) => !prior.has(j.id));
  assert.equal(launched.length, 1);
  const [first] = launched;
  omitted(first, resource);
  assert.ok(
    (await events()).some((e) => e.method === "notify" && e.message.includes(first.id) && e.message.includes(resource)),
    "slash acknowledgement must identify the omitted resource tool",
  );
  const result = await wait(first.id);
  assert.equal(result.state, "succeeded", result.result);
  assert.equal(result.result, "verified final answer");
  assert.equal(get(result.terminal).parent, parent);
  assert.match(hc("read", result.terminal), /verified final answer/);
  const calls = JSON.parse(await readFile(marker, "utf8"));
  for (const name of denied) assert.equal(calls[name].isError, true, name);
  assert.match(JSON.stringify(calls[deferred]), /called deferred/);
  assert.deepEqual(requests[0].names, ["websearch"]);
  assert.equal(requests[0].task, "Delegated task:\n/plan exit");
  assert.match(JSON.stringify(requests[0].messages), /PLAN MODE ACTIVE/);
  assert.ok(
    requests.some((r) =>
      r.messages.some((m) => m.role === "tool" && JSON.stringify(m).includes("local search result")),
    ),
  );

  const named = await launch("--tools bash", "reviewer");
  const settled = await wait(named.id);
  assert.equal(settled.state, "succeeded", settled.state);
  const namedRequest = requests.find((r) => r.task === "Delegated task:\n--tools bash");
  assert.deepEqual(namedRequest.names, []);
  assert.match(JSON.stringify(namedRequest.messages), /reviewer-role-marker/);
  assert.equal(settled.resultPath, join(agent, "pi-herdr-core/workers", settled.id, "answer.json"));
  const answer = JSON.parse(await readFile(settled.resultPath, "utf8"));
  assert.equal(answer.ok, true);
  assert.ok(answer.text === longAnswer, "full settled answer must survive intact");
  assert.match(settled.result, /verified final answer/);
  assert.ok(settled.result.length <= 48000, "preview must fit the model-facing result budget");
  assert.match(settled.result, /truncat/i);

  // Parent still has the loaded search definition; the new CLI cannot register it.
  await writeFile(fixture, source.replace("['websearch','dangerous']", "['dangerous']"));
  const ack = await launch("missing in child");
  omitted(ack, resource);
  const narrowed = await wait(ack.id);
  assert.equal(narrowed.state, "succeeded", narrowed.result);
  omitted(narrowed, "websearch");
  assert.deepEqual(requests.find((r) => r.task.endsWith("missing in child")).names, []);
  await writeFile(fixture, source);
  async function blocked(tag) {
    const task = `hang-marker ${tag}`;
    const job = await launch(task, "reviewer");
    await until(task, () => requests.some((r) => r.task === `Delegated task:\n${task}`));
    return job;
  }
  const running = await blocked("cancel");
  assert.equal((await run("subagent_cancel", { id: running.id })).job.state, "cancelled");
  assert.equal(get(running.terminal).state, "finished");
  const stale = await blocked("revoke");
  await prompt("/plan exit");
  await until("revoked worker exit", () => get(stale.terminal).state === "finished");
  assert.deepEqual(await list(), []);
  await assert.rejects(wait(stale.id), /current scope/i);
  assert.ok(!JSON.stringify(await rpc("get_entries")).includes(`herdr:${stale.id}`), "stale completion delivered");
  console.log("PASS: Core 0.1.18 parent Pi CLI, Plan delegation, narrowing, full result, cancellation and revocation");
} catch (error) {
  if (started)
    try {
      for (const t of terminals()) console.error(t.address, hc("read", t.address).slice(-1500));
    } catch {
      /* preserve failure */
    }
  throw error;
} finally {
  try {
    await input?.close();
    if (started) hc("server", "stop");
  } finally {
    provider.closeAllConnections();
    provider.close();
    await rm(root, { recursive: true, force: true });
  }
}
