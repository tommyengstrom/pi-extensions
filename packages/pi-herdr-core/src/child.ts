import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, InlineExtension, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { canonical, permitsCall, verifyInventory, verifySourceFiles } from "./capabilities.js";
import { installChildContext } from "./child-context.js";
import { connectControl } from "./control.js";
import type { ChildSnapshot } from "./snapshot.js";
import { terminalText } from "./terminal-text.js";
import { LIMITS } from "./tree.js";

export interface ChildAssignment {
  snapshot: ChildSnapshot;
  task: string;
  directory: string;
  deadline: number;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Node-only executable backend. All task authority arrives over an authenticated connection. */
export async function runChild(credentialFile: string): Promise<void> {
  const { peer, job, attempt } = await connectControl(credentialFile);
  installChildContext({ peer, job, attempt });
  let session: AgentSession | undefined;
  let runtime: ModelRuntime | undefined;
  let transport: ModelRuntime | undefined;
  let dispatched = false;
  let state: "initializing" | "running" | "waiting" | "finishing" = "initializing";
  let cancelled = false;
  let fatal = false;
  let turns = 0;
  let calls = 0;
  let liveApi: ExtensionAPI | undefined;
  let usage: Usage | undefined;
  let unsubscribe: (() => void) | undefined;
  const abort = new AbortController();
  // A disconnected supervisor must not leave an unrestricted agent or MCP process running.
  const hardStop = () => {
    cancelled = true;
    abort.abort();
    void session?.abort();
    setTimeout(() => process.exit(2), 1500).unref();
  };
  peer.onClose(hardStop);
  peer.onRequest(async (method, data) => {
    if (method === "cancel") {
      cancelled = true;
      abort.abort();
      const kill = setTimeout(() => process.exit(2), 1500);
      await session?.abort();
      clearTimeout(kill);
      return { accepted: true };
    }
    if (method === "steer") {
      if (
        state !== "running" ||
        cancelled ||
        !session ||
        !record(data) ||
        typeof data.text !== "string" ||
        !data.text.trim() ||
        Buffer.byteLength(data.text) > 16_000
      )
        return { status: "rejected" };
      // Custom messages bypass slash commands, skills and human approval/input hooks.
      await session.sendCustomMessage(
        { customType: "pi-herdr-core-steering-v1", content: data.text, display: true, details: { job, attempt } },
        { triggerTurn: true, deliverAs: "steer" },
      );
      return { status: "queued" };
    }
    throw new Error("Unknown child control operation.");
  });
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const assigned = await peer.request("assignment", {});
    if (
      !record(assigned) ||
      !record(assigned.snapshot) ||
      assigned.snapshot.version !== 1 ||
      typeof assigned.task !== "string" ||
      typeof assigned.directory !== "string" ||
      typeof assigned.deadline !== "number"
    )
      throw new Error("Invalid controlled assignment.");
    const assignment = assigned as unknown as ChildAssignment;
    const { snapshot } = assignment;
    process.stdout.write(
      terminalText(`Pi delegated task ${job}\n${assignment.task}\nInitializing selected capabilities…\n`),
    );
    const remaining = assignment.deadline - Date.now();
    if (remaining <= 0 || remaining > LIMITS.milliseconds) throw new Error("Invalid child deadline.");
    deadlineTimer = setTimeout(hardStop, remaining);
    for (const name of Object.keys(process.env))
      if (!name.startsWith("HC_") && !name.startsWith("PI_HERDR_")) delete process.env[name];
    for (const [name, value] of Object.entries(snapshot.environment)) {
      if (name.startsWith("HC_") || name.startsWith("PI_HERDR_"))
        throw new Error("Control identity must not be inherited from the parent.");
      process.env[name] = value;
    }
    const sdk = (await import(snapshot.sdkUrl)) as typeof import("@earendil-works/pi-coding-agent");
    await verifySourceFiles(snapshot.capabilities);
    abort.signal.throwIfAborted();
    const paths = [...snapshot.capabilities.files.map((file) => file.path), ...snapshot.capabilities.builtins];
    const factories: InlineExtension[] = [];
    const gate = (pi: ExtensionAPI) => {
      liveApi = pi;
      const check = () => {
        abort.signal.throwIfAborted();
        if (fatal || !peer.alive) throw new Error("Controlled child authority revoked.");
        verifyInventory(snapshot.capabilities, pi.getAllTools());
      };
      pi.on("tool_call", async (event) => {
        try {
          check();
          if (
            !permitsCall(snapshot.capabilities, pi.getAllTools(), event.toolName, event.parentToolCallId !== undefined)
          )
            return {
              block: true,
              reason: "Tool is outside the inherited exact-name/source/exposure ceiling.",
              terminate: true,
            };
          if (++calls > LIMITS.calls) throw new Error("Tool-call budget exhausted.");
          await peer.request("charge", { kind: "call" });
          abort.signal.throwIfAborted();
        } catch {
          fatal = true;
          hardStop();
          return { block: true, reason: "Controlled child authority or budget unavailable.", terminate: true };
        }
      });
      pi.on("before_agent_start", (event) => {
        check();
        // Every declaration remains within the immutable ceiling, including late registrations.
        event.systemPromptOptions.selectedTools = pi
          .getActiveTools()
          .filter((name) => snapshot.capabilities.tools.some((tool) => tool.name === name));
        event.systemPromptOptions.promptGuidelines.push(snapshot.guidance);
      });
      // context is a chained fail-closed request boundary, unlike notification-only turn_start.
      pi.on("context", async (event) => {
        check();
        if (++turns > LIMITS.turns) {
          fatal = true;
          hardStop();
          throw new Error("Turn budget exhausted.");
        }
        try {
          await peer.request("charge", { kind: "turn" });
          abort.signal.throwIfAborted();
        } catch (error) {
          fatal = true;
          hardStop();
          throw error;
        }
        return { messages: event.messages };
      });
      pi.on("cache_warming_decision", () => ({ action: "stop" }));
    };
    // Gate is installed before selected extensions. Trusted extensions are not an OS sandbox.
    factories.push(gate);
    if (paths.includes("builtin:codemode"))
      factories.push({ name: "codemode", builtin: true, factory: sdk.createCodemodeExtension() });
    for (const name of ["tool_search", "tool-search"])
      if (paths.includes(`builtin:${name}`))
        factories.push({ name, builtin: true, factory: sdk.createToolSearchExtension() });
    if (paths.includes("builtin:mcp"))
      factories.push({
        name: "mcp",
        builtin: true,
        factory: (pi) => {
          // Only captured server definitions may connect. Selected extension sources can register
          // other servers, but this controlled MCP loader deliberately never discovers them.
          const mcp = sdk.createMcpExtension({
            loadConfig: () => ({ servers: structuredClone(snapshot.mcp), errors: [], autoEnableCodemode: false }),
            openUrl: () => {
              throw new Error("Child MCP login requires parent setup before delegation.");
            },
            updateConfig: () => {
              throw new Error("Child cannot modify parent MCP configuration.");
            },
            logPath: join(assignment.directory, "mcp.log"),
          });
          return mcp({ ...pi, getMcpServers: () => [] });
        },
      });
    const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const loader = new sdk.DefaultResourceLoader({
      cwd: snapshot.cwd,
      agentDir: snapshot.agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalExtensionPaths: paths,
      extensionFactories: factories,
      appendSystemPromptOverride: () => [],
      systemPromptOverride: () => undefined,
    });
    await loader.reload({ resolveProjectTrust: async () => snapshot.trusted });
    abort.signal.throwIfAborted();
    if (loader.getExtensions().errors.length) throw new Error("A selected extension failed initialization.");
    await mkdir(assignment.directory, { recursive: true, mode: 0o700 });
    runtime = await sdk.ModelRuntime.create({
      authPath: join(snapshot.agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
      signal: abort.signal,
    });
    runtime.registerProvider(snapshot.model.provider, {
      ...snapshot.providerConfig,
      api: snapshot.model.api,
      baseUrl: snapshot.auth.baseUrl ?? snapshot.model.baseUrl,
      models: [snapshot.model],
      apiKey: snapshot.auth.apiKey,
      headers: snapshot.auth.headers,
    });
    // Parent provider environment is passed only to the selected provider, not process.env.
    transport = runtime;
    const provider = transport.getProvider(snapshot.model.provider);
    if (!provider) throw new Error("Selected provider unavailable in controlled child.");
    const selected = transport.getModel(snapshot.model.provider, snapshot.model.id);
    if (!selected || canonical(selected) !== canonical(snapshot.model))
      throw new Error("Exact parent model could not be reproduced.");
    const providerRuntime = transport;
    runtime = await sdk.ModelRuntime.create({
      authPath: join(assignment.directory, "unused-auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
      signal: abort.signal,
    });
    runtime.registerProvider(selected.provider, {
      api: selected.api,
      baseUrl: selected.baseUrl,
      apiKey: "controlled-transport",
      models: [selected],
      streamSimple: (_model, context, options) => {
        // A transport gate is mandatory: extension event errors can be logged and ignored.
        // No provider request is possible before the root's ready/dispatch acknowledgement.
        if (!dispatched || cancelled || fatal || !peer.alive || !liveApi || state !== "running")
          throw new Error("Controlled provider dispatch is not authorized.");
        abort.signal.throwIfAborted();
        verifyInventory(snapshot.capabilities, liveApi.getAllTools());
        const { apiKey: _key, headers: _headers, env: _env, ...rest } = options ?? {};
        return providerRuntime.streamSimple(selected, context, {
          ...rest,
          apiKey: snapshot.auth.apiKey,
          headers: snapshot.auth.headers,
          env: snapshot.auth.env,
          signal: AbortSignal.any([abort.signal, ...(options?.signal ? [options.signal] : [])]),
        });
      },
    });
    const created = await sdk.createAgentSession({
      cwd: snapshot.cwd,
      model: selected,
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager: settings,
      thinkingLevel: snapshot.thinking,
      sessionManager: sdk.SessionManager.create(snapshot.cwd, join(assignment.directory, "sessions")),
      // Admission includes callable/deferred tools; declarations are narrowed after bind.
      // A mixed MCP direct/deferred list must not silently exclude deferred names.
      tools: snapshot.capabilities.tools.map((tool) => tool.name),
    });
    session = created.session;
    unsubscribe = session.subscribe((event) => {
      if (
        event.type !== "message_end" ||
        (event.message.role !== "assistant" && event.message.role !== "toolResult") ||
        !event.message.usage
      )
        return;
      const next = event.message.usage;
      if (!usage) usage = structuredClone(next);
      else {
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
          usage[key] += next[key];
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
          usage.cost[key] += next.cost[key];
      }
    });
    await session.bindExtensions({ mode: "json" });
    if (!liveApi) throw new Error("Child gate failed to initialize.");
    // MCP connections are asynchronous. Wait for the complete captured inventory, not only direct tools.
    const readyBy = Math.min(assignment.deadline, Date.now() + 20_000);
    while (true) {
      abort.signal.throwIfAborted();
      try {
        verifyInventory(snapshot.capabilities, session.getAllTools());
        break;
      } catch (error) {
        if (Date.now() >= readyBy) throw error;
        await delay(50, undefined, { signal: abort.signal });
      }
    }
    await verifySourceFiles(snapshot.capabilities);
    liveApi.setActiveTools(snapshot.capabilities.tools.filter((tool) => tool.active).map((tool) => tool.name));
    if (session.thinkingLevel !== snapshot.thinking)
      throw new Error("Exact parent thinking level could not be reproduced.");
    await peer.request("ready", {
      terminal: process.env.HC_TERMINAL_ID,
      transcript: session.sessionManager.getSessionFile(),
    });
    abort.signal.throwIfAborted();
    process.stdout.write(
      terminalText(
        `Capabilities verified. Model: ${snapshot.model.provider}/${snapshot.model.id}; thinking: ${snapshot.thinking}.\nTranscript: ${session.sessionManager.getSessionFile() ?? "unavailable"}\nRunning task…\n`,
      ),
    );
    dispatched = true;
    state = "running";
    await session.prompt(assignment.task, { expandPromptTemplates: false });
    while (true) {
      state = "waiting";
      await session.waitForIdle();
      const last = session.messages.findLast((message) => message.role === "assistant");
      const outcome =
        cancelled || last?.stopReason === "aborted"
          ? "aborted"
          : fatal || !last || last.stopReason === "error"
            ? "error"
            : "success";
      const summary = sdk.truncateHead(session.getLastAssistantText() ?? "No final assistant result.", {
        maxBytes: 48 * 1024,
        maxLines: 1900,
      }).content;
      process.stdout.write(
        terminalText(
          `\nChild outcome: ${outcome}\n${summary}\nTranscript: ${session.sessionManager.getSessionFile() ?? "unavailable"}\n`,
        ),
      );
      const response = await peer.request(
        "settled",
        {
          version: 1,
          job,
          attempt,
          outcome,
          summary,
          transcript: session.sessionManager.getSessionFile() ?? "",
          usage,
        },
        Math.max(1, Math.min(600_000, assignment.deadline - Date.now())),
      );
      if (!record(response) || response.continue !== true) break;
      abort.signal.throwIfAborted();
      state = "running";
      await session.sendCustomMessage(
        {
          customType: "pi-herdr-core-descendants-v1",
          content: JSON.stringify(response.results),
          display: false,
          details: { job, attempt },
        },
        { triggerTurn: true },
      );
      await session.waitForIdle();
    }
    state = "finishing";
  } finally {
    state = "finishing";
    if (deadlineTimer) clearTimeout(deadlineTimer);
    const forceExit = setTimeout(() => process.exit(cancelled ? 2 : 0), 2000);
    try {
      if (session) {
        await session.abort();
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        unsubscribe?.();
        session.dispose();
      }
      await runtime?.settleCredentialWrites();
      await transport?.settleCredentialWrites();
    } finally {
      peer.close();
      clearTimeout(forceExit);
    }
  }
}
