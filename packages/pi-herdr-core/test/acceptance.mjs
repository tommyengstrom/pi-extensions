// Explicit deterministic process integration, separate from five-second Vitest tests.
// Build first, then: node packages/pi-herdr-core/test/acceptance.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer as socketServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const directory = await mkdtemp(join(tmpdir(), "herdr-acceptance-"));
process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
const sdk = await import("@earendil-works/pi-coding-agent");
const { captureChildSnapshot } = await import("../dist/snapshot.js");
const { Supervisor } = await import("../dist/supervisor.js");
const terminals = new Map();
const programs = new Map();
const screens = new Map();
let requests = 0;
const cancellationStarted = Promise.withResolvers();
const provider = httpServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const data = JSON.parse(body);
  requests++;
  if (data.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("cancel task"))) {
    cancellationStarted.resolve();
    return; // Hold a real provider request until cancellation aborts the transport.
  }
  const rootTask = data.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("root task"));
  const hasTool = data.messages.some((m) => m.role === "tool");
  const call = !hasTool;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const delta = call
    ? {
        tool_calls: rootTask
          ? [
              {
                index: 0,
                id: "delegate1",
                type: "function",
                function: { name: "subagent", arguments: JSON.stringify({ task: "leaf task" }) },
              },
            ]
          : data.tools
              .filter((tool) => tool.function?.name.startsWith("mcp__") || tool.function?.name === "relay")
              .map((tool, index) => ({
                index,
                id: `mcp${index}`,
                type: "function",
                function: { name: tool.function.name, arguments: "{}" },
              })),
      }
    : { content: "deterministic completion" };
  res.end(
    `data: ${JSON.stringify({ id: "answer", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "answer", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((done) => provider.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
const socketPath = join(directory, "core.sock");
const core = socketServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const request = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      void (async () => {
        const p = request.params;
        let result;
        if (request.method === "hello")
          result = {
            version: "0.1.21",
            core: { id: "fixture-core" },
            framed: false,
            methods: ["terminal.get", "terminal.list", "terminal.run", "terminal.kill", "terminal.rm"],
          };
        else if (request.method === "terminal.get") result = terminals.get(p.terminal);
        else if (request.method === "terminal.list")
          result = {
            terminals: [...terminals.values()].filter((t) =>
              Object.entries(p.labels ?? {}).every(([key, value]) => t.labels[key] === value),
            ),
          };
        else if (request.method === "terminal.run") {
          const address = `t${terminals.size + 1}`;
          result = {
            address,
            parent: p.parent,
            state: "live",
            labels: p.labels,
            argv: p.argv,
            created_ms: Date.now(),
            keep: p.keep,
            rm: p.rm,
            notify: !p.no_notify,
          };
          terminals.set(address, result);
          screens.set(address, "");
          const program = spawn(p.argv[0], p.argv.slice(1), {
            cwd: p.cwd,
            env: { ...p.env, HC_TERMINAL_ID: address, HC_TERMINAL_SOCKET: socketPath },
            stdio: ["ignore", "pipe", "pipe"],
          });
          programs.set(address, program);
          for (const stream of [program.stdout, program.stderr])
            stream.on("data", (chunk) => screens.set(address, screens.get(address) + chunk));
          program.on("exit", () => {
            terminals.get(address).state = "finished";
          });
        } else if (request.method === "terminal.kill") {
          const program = programs.get(p.terminal);
          if (program && program.exitCode === null && program.signalCode === null) {
            program.kill("SIGTERM");
            await new Promise((done) => program.once("exit", done));
          }
          result = terminals.get(p.terminal);
        } else if (request.method === "terminal.rm") {
          terminals.delete(p.terminal);
          result = {};
        }
        if (!socket.destroyed) socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      })().catch((error) => socket.destroy(error));
    }
  });
  socket.on("error", () => {});
});
await new Promise((done) => core.listen(socketPath, done));
terminals.set("t1", {
  address: "t1",
  parent: null,
  state: "live",
  labels: {},
  argv: [process.execPath],
  created_ms: 1,
  keep: false,
  rm: false,
  notify: false,
});
let parent;
let supervisor;
try {
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("fixture", {
    api: "openai-completions",
    apiKey: "fixture",
    baseUrl,
    models: [
      {
        id: "fixture",
        name: "Fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 512,
      },
    ],
  });
  let api;
  let context;
  const mcpFile = join(directory, "mcp.mjs");
  const mcpCalls = join(directory, "mcp-calls.txt");
  await writeFile(
    mcpFile,
    `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
for await (const line of createInterface({ input: process.stdin })) {
 const r=JSON.parse(line); if(r.id===undefined) continue;
 const result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:
 r.method==='tools/list'?{tools:[{name:'echo',description:'Fixture echo',inputSchema:{type:'object',properties:{}}}]}:
 r.method==='tools/call'?{content:[{type:'text',text:'mcp-result'}]}:{};
 if(r.method==='tools/call') appendFileSync(${JSON.stringify(mcpCalls)},process.argv[2]+'\\n');
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
}`,
  );
  const relayFile = join(directory, "relay.ts");
  await writeFile(
    relayFile,
    `export default function(pi) {
 pi.registerTool({name:'relay',label:'Relay',description:'Call the permitted deferred echo',parameters:{type:'object',properties:{}},
 async execute(_id,_args,_signal,_update,ctx) { const outcome=await ctx.executeTool('mcp__registered__echo',{}); if(outcome.isError) throw new Error('Nested MCP call failed'); return outcome.result; }});
}`,
  );
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  const serverConfig = { command: process.execPath, args: [mcpFile, "configured"], exposure: "direct" };
  await writeFile(
    join(process.env.PI_CODING_AGENT_DIR, "mcp.json"),
    JSON.stringify({ mcpServers: { configured: serverConfig } }),
  );
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({
    cwd: directory,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [resolve("packages/pi-herdr-core/src/index.ts"), relayFile, "builtin:mcp"],
    extensionFactories: [
      { name: "mcp", builtin: true, factory: sdk.createMcpExtension() },
      (pi) => {
        api = pi;
        pi.registerMcpServer("registered", { ...serverConfig, args: [mcpFile, "registered"], exposure: "deferred" });
        pi.on("session_start", (_event, ctx) => {
          context = ctx;
        });
      },
    ],
  });
  await loader.reload({ resolveProjectTrust: async () => true });
  assert.deepEqual(loader.getExtensions().errors, []);
  parent = (
    await sdk.createAgentSession({
      cwd: directory,
      modelRuntime,
      model: modelRuntime.getModel("fixture", "fixture"),
      thinkingLevel: "off",
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: sdk.SessionManager.inMemory(directory),
      tools: [
        "read",
        "subagent",
        "subagent_query",
        "subagent_wait",
        "subagent_cancel",
        "subagent_steer",
        "mcp__configured__echo",
        "mcp__registered__echo",
        "relay",
      ],
    })
  ).session;
  await parent.bindExtensions({ mode: "json" });
  for (let i = 0; i < 200 && api.getAllTools().filter((tool) => tool.name.startsWith("mcp__")).length < 2; i++)
    await delay(25);
  assert.equal(
    api.getAllTools().filter((tool) => tool.name.startsWith("mcp__")).length,
    2,
    JSON.stringify(
      api.getAllTools().map((tool) => ({ name: tool.name, source: tool.sourceInfo, namespace: tool.namespace })),
    ),
  );
  api.setActiveTools([
    ...api.getActiveTools().filter((name) => name !== "mcp__registered__echo"),
    "mcp__configured__echo",
    "relay",
  ]);
  const snapshot = await captureChildSnapshot(api, context);
  assert.equal(snapshot.mcp.length, 2);
  assert.equal(snapshot.capabilities.tools.find((tool) => tool.name === "mcp__registered__echo").active, false);
  const bootstrap = join(directory, "bootstrap.mjs");
  await writeFile(
    bootstrap,
    `import { runChild } from ${JSON.stringify(new URL("../dist/child.js", import.meta.url).href)};\ntry { await runChild(process.env.PI_HERDR_CREDENTIAL_FILE); } catch (error) { console.error(error); process.exitCode = 1; }`,
  );
  supervisor = new Supervisor({
    session: "acceptance",
    agentDir: process.env.PI_CODING_AGENT_DIR,
    parentTerminal: "t1",
    coreSocket: socketPath,
    bootstrap,
    current: () => true,
  });
  const job = await supervisor.launch({ task: "root task", snapshot, group: "acceptance", scope: "acceptance" });
  const finished = await supervisor.wait(supervisor.root, job.id, 25_000);
  assert.equal(finished.state, "succeeded", JSON.stringify(finished));
  for (let i = 0; i < 100 && supervisor.list().some((j) => !j.stopConfirmed); i++) await delay(25);
  const jobs = supervisor.list();
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((j) => j.stopConfirmed));
  const leaf = jobs.find((j) => j.parent === job.id);
  assert.equal(terminals.get(leaf.terminal).parent, job.terminal);
  assert.ok(requests >= 4);
  const calls = await readFile(mcpCalls, "utf8");
  assert.match(calls, /configured/);
  assert.match(calls, /registered/);
  terminals.set("t99", { ...terminals.get(job.terminal), address: "t99", parent: job.terminal, state: "live" });
  assert.equal(
    await supervisor.cleanup(supervisor.query(job.id)),
    "skipped",
    "A live native descendant prevents cleanup even when it is outside this supervisor",
  );
  terminals.delete("t99");
  for (const item of jobs) {
    assert.match(screens.get(item.terminal), /deterministic completion/);
    assert.equal(await supervisor.cleanup(item), "removed");
    assert.ok(await supervisor.store.readResult(item.id, item.attempt));
  }
  const cancelled = await supervisor.launch({ task: "cancel task", snapshot, group: "cancel", scope: "acceptance" });
  await Promise.race([
    cancellationStarted.promise,
    delay(5000).then(() => {
      throw new Error("Provider did not start");
    }),
  ]);
  assert.deepEqual(await supervisor.steer(supervisor.root, cancelled.id, "/plan is plain guidance"), {
    status: "queued",
  });
  await supervisor.cancel(supervisor.root, cancelled.id);
  assert.equal(supervisor.query(cancelled.id).stopConfirmed, true);
  assert.equal(terminals.get(cancelled.terminal).state, "finished");
  assert.equal(await supervisor.cleanup(supervisor.query(cancelled.id)), "removed");
  console.log(
    "Deterministic acceptance passed: real Node children, nested delegation, file/MCP tools, steering, cancellation, retained output, results and cleanup through mocked Core.",
  );
} catch (error) {
  for (const [terminal, text] of screens) console.error(terminal, text);
  throw error;
} finally {
  await supervisor?.dispose();
  if (parent) {
    await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    parent.dispose();
  }
  for (const program of programs.values()) program.kill("SIGKILL");
  await Promise.all([new Promise((done) => provider.close(done)), new Promise((done) => core.close(done))]);
  await rm(directory, { recursive: true, force: true });
}
