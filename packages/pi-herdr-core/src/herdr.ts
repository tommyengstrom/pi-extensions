import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { backgroundRuntime, type Recipient, SCOPE_EVENT, STATUS_EVENT } from "@narumitw/pi-background";
import { canonical } from "./capabilities.js";
import { childContext } from "./child-context.js";
import { captureChildSnapshot } from "./snapshot.js";
import { diagnostic, JobStore, type StoredJob } from "./store.js";
import { Supervisor } from "./supervisor.js";
import { type OperationHandler, registerSubagentTools } from "./tools.js";
import { terminalState } from "./tree.js";

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const eventId = (job: StoredJob) => `herdr:${job.id}:${job.attempt}`;
function loadout(pi: ExtensionAPI): string {
  return canonical({
    active: [...pi.getActiveTools()].sort(),
    tools: pi
      .getAllTools()
      .map((tool) => ({
        name: tool.name,
        path: tool.sourceInfo.path,
        source: tool.sourceInfo.source,
        exposure: tool.exposure,
        parameters: tool.parameters,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
}

export default function herdr(pi: ExtensionAPI): void {
  const controlled = childContext();
  if (controlled) {
    // Same file-backed implementation/provenance in children, but no nested root supervisor.
    registerSubagentTools(pi, async (operation, input, _ctx, signal) => {
      signal?.throwIfAborted();
      const activeTools = pi.getActiveTools();
      const request =
        operation === "launch"
          ? {
              ...input,
              activeTools,
              callableTools: pi
                .getAllTools()
                .filter(
                  (tool) =>
                    tool.exposure === "codemode" ||
                    tool.exposure === "deferred" ||
                    (tool.exposure === "direct" && activeTools.includes(tool.name)),
                )
                .map((tool) => tool.name),
            }
          : input;
      const response = await controlled.peer.request(operation, request, operation === "wait" ? 600_000 : 60_000);
      signal?.throwIfAborted();
      return response;
    });
    return;
  }
  const background = backgroundRuntime(pi);
  let supervisor: Supervisor | undefined;
  let owner: ExtensionContext["sessionManager"] | undefined;
  let recipient: Recipient | undefined;
  let capturedLoadout = "";
  let group = randomUUID();
  const store = new JobStore(getAgentDir());
  function active(ctx: ExtensionContext): void {
    if (owner !== ctx.sessionManager) throw new Error("Subagent caller session was replaced.");
  }
  async function stop(): Promise<void> {
    if (recipient) background.revoke(recipient.scope);
    const previous = supervisor;
    supervisor = undefined;
    recipient = undefined;
    capturedLoadout = "";
    await previous?.dispose();
  }
  const offRevoke = background.onRevoke((scope) => {
    if (recipient?.scope === scope) void supervisor?.revoke(scope).catch(() => {});
  });
  pi.on("session_start", (_event, ctx) => {
    owner = ctx.sessionManager;
  });
  pi.on("session_tree", async (_event, ctx) => {
    await stop();
    owner = ctx.sessionManager;
    group = randomUUID();
  });
  pi.on("session_shutdown", async () => {
    owner = undefined;
    offRevoke();
    offScope();
    offStatus();
    await stop();
  });
  pi.on("agent_settled", async (event) => {
    if (event.aborted) await stop();
  });
  pi.on("input", (event) => {
    if (event.source !== "extension" && !supervisor?.list().some((job) => !job.stopConfirmed)) group = randomUUID();
  });
  const invalidateChangedLoadout = () => {
    if (recipient && capturedLoadout && loadout(pi) !== capturedLoadout) background.revoke(recipient.scope);
  };
  pi.on("before_agent_start", invalidateChangedLoadout);
  pi.on("tool_execution_end", invalidateChangedLoadout);
  const offScope = pi.events.on(SCOPE_EVENT, (value) => {
    if (object(value) && value.version === 1 && value.action === "hold" && typeof value.scope === "string")
      supervisor?.hold(value.scope, value.held === true);
  });
  const offStatus = pi.events.on(STATUS_EVENT, (value) => {
    if (object(value) && value.version === 1 && typeof value.respond === "function" && typeof value.scope === "string")
      value.respond({
        active: supervisor?.list().filter((job) => job.scope === value.scope && !job.stopConfirmed).length ?? 0,
        pending: 0,
      });
  });
  async function ensure(ctx: ExtensionContext): Promise<Supervisor> {
    active(ctx);
    const next = background.recipient(ctx);
    if (!background.owns(next, ctx))
      throw new Error("Background scope revoked. Start a fresh workflow/request before delegating.");
    if (background.workflow(ctx)?.held) throw new Error("Delegation is held during workflow review.");
    if (supervisor && recipient?.scope === next.scope) return supervisor;
    if (supervisor) await stop();
    active(ctx);
    // Capture after stop: its synchronous revocation cannot invalidate the new token.
    recipient = background.recipient(ctx);
    capturedLoadout = loadout(pi);
    const own = recipient;
    const terminal = process.env.HC_TERMINAL_ID;
    const socket = process.env.HC_TERMINAL_SOCKET;
    if (!terminal || !socket)
      throw new Error(
        "Subagents require a local Herdr Core terminal (HC_TERMINAL_ID and HC_TERMINAL_SOCKET). No process fallback is available.",
      );
    supervisor = new Supervisor({
      session: ctx.sessionManager.getSessionId(),
      agentDir: getAgentDir(),
      parentTerminal: terminal,
      coreSocket: socket,
      current(scope) {
        if (owner !== ctx.sessionManager || own.scope !== scope || !background.owns(own, ctx)) return false;
        if (loadout(pi) !== capturedLoadout) {
          background.revoke(scope);
          return false;
        }
        return true;
      },
      completed(job, result) {
        if (!background.owns(own, ctx)) return;
        const queued = background.enqueue({
          ...own,
          id: eventId(job),
          jobId: job.id,
          topic: "subagent-result",
          wake: true,
          summary: diagnostic(`${job.id}: ${job.state}\n${result.summary}`),
          result: job.result ?? result.transcript,
        });
        if (ctx.hasUI)
          ctx.ui.setStatus(
            "pi-herdr-core",
            diagnostic(`subagent ${job.state}${queued === "full" ? " (notification queue full; query result)" : ""}`),
          );
      },
    });
    return supervisor;
  }
  async function lookup(id: string): Promise<StoredJob> {
    try {
      return supervisor?.query(id) ?? (await store.read(id));
    } catch {
      return store.read(id);
    }
  }
  const perform: OperationHandler = async (operation, input, ctx, signal) => {
    active(ctx);
    signal?.throwIfAborted();
    if (operation === "launch" || operation === "steer") {
      const name = operation === "launch" ? "subagent" : "subagent_steer";
      const allowed = background.workflow(ctx)?.restrictions?.allowedTools ?? pi.getActiveTools();
      if (!allowed.includes(name)) throw new Error(`${name} is not selected in the current tool policy.`);
    }
    if (operation === "launch") {
      if (typeof input.task !== "string") throw new Error("A literal task is required.");
      const service = await ensure(ctx);
      const workflow = background.workflow(ctx);
      const snapshot = await captureChildSnapshot(pi, ctx, workflow?.restrictions);
      active(ctx);
      signal?.throwIfAborted();
      if (!recipient || !background.owns(recipient, ctx)) throw new Error("Delegation scope changed before launch.");
      const job = await service.launch({ task: input.task, snapshot, group, scope: recipient.scope });
      return { job, excludedParentOnlyTools: snapshot.capabilities.excluded };
    }
    if (operation === "query" && input.action === "list") {
      const current = supervisor?.list() ?? [];
      const previous = (await store.history()).filter((job) => !current.some((live) => live.id === job.id));
      active(ctx);
      return { jobs: [...current, ...previous] };
    }
    if (typeof input.id !== "string") throw new Error("A job ID is required.");
    if (operation === "cancel" || operation === "steer" || operation === "wait") {
      if (!supervisor) throw new Error("Historical records cannot reacquire control or resume work.");
      if (operation === "cancel") {
        await supervisor.cancel(supervisor.root, input.id);
        return { job: supervisor.query(input.id) };
      }
      if (operation === "steer") return supervisor.steer(supervisor.root, input.id, String(input.text));
      await supervisor.wait(
        supervisor.root,
        input.id,
        typeof input.timeout === "number" ? input.timeout : 60_000,
        signal,
      );
    }
    const job = await lookup(input.id);
    active(ctx);
    signal?.throwIfAborted();
    const consume = operation === "wait" || (operation === "query" && input.action === "result");
    const result = consume && job.result ? await store.readResult(job.id, job.attempt) : undefined;
    active(ctx);
    const ids =
      result && recipient?.scope === job.scope && background.owns(recipient, ctx)
        ? background.resultDetails(recipient, [eventId(job)])
        : {};
    return { job, ...(result ? { result } : {}), ...ids };
  };
  registerSubagentTools(pi, perform);
  async function status(ctx: ExtensionCommandContext, cleanup = false): Promise<void> {
    active(ctx);
    if (!ctx.hasUI) throw new Error("Use subagent_query/subagent_wait in noninteractive mode.");
    let jobs = supervisor?.list() ?? [];
    const history = await store.history();
    active(ctx);
    jobs = [
      ...jobs,
      ...history.filter(
        (job) => job.ownerSession === ctx.sessionManager.getSessionId() && !jobs.some((live) => live.id === job.id),
      ),
    ];
    if (
      cleanup &&
      (await ctx.ui.confirm(
        "Include earlier sessions?",
        "Include extension-owned finished terminals from earlier sessions, grouped by original parent?",
      ))
    )
      jobs = [...jobs, ...history.filter((old) => !jobs.some((job) => job.id === old.id))];
    active(ctx);
    const eligible = cleanup
      ? jobs.filter((job) => terminalState(job.state) && job.stopConfirmed && job.allocation)
      : jobs;
    if (!eligible.length) {
      ctx.ui.notify(
        cleanup ? "No confirmed finished terminals eligible for cleanup." : "No subagents in this session.",
        "info",
      );
      return;
    }
    eligible.sort((left, right) => left.parent.localeCompare(right.parent) || left.created - right.created);
    const labels = eligible.map((job) =>
      diagnostic(
        `${"  ".repeat(Math.max(0, job.depth - 1))}${job.id} · ${job.state} · parent ${job.parent} · ${job.terminal ?? "unallocated"} · ${job.model.provider}/${job.model.id} · ${job.task.slice(0, 160)}`,
      ),
    );
    const choice = await ctx.ui.select(
      cleanup ? "Select a retained terminal to remove" : "Subagent tree (parent IDs shown)",
      labels,
    );
    const selected = eligible[labels.indexOf(choice ?? "")];
    if (!selected) return;
    active(ctx);
    if (cleanup) {
      if (
        !(await ctx.ui.confirm(
          "Remove finished terminal?",
          diagnostic(`${selected.terminal}; transcripts and results will be retained.`),
        ))
      )
        return;
      active(ctx);
      // A cleanup-only supervisor performs no launch and does not claim historical job control.
      const service =
        supervisor ??
        new Supervisor({
          session: ctx.sessionManager.getSessionId(),
          agentDir: getAgentDir(),
          parentTerminal: process.env.HC_TERMINAL_ID ?? "",
          coreSocket: process.env.HC_TERMINAL_SOCKET ?? "",
          current: () => false,
        });
      try {
        ctx.ui.notify(await service.cleanup(selected), "info");
      } finally {
        if (service !== supervisor) await service.dispose();
      }
      return;
    }
    const action = await ctx.ui.select("Subagent action", [
      "Inspect references",
      "Steer",
      "Cancel subtree",
      "Attachment instructions",
      "Cleanup",
    ]);
    active(ctx);
    if (action === "Steer") {
      const text = await ctx.ui.input("Task guidance (does not change permissions)");
      if (text) await perform("steer", { id: selected.id, text }, ctx);
    } else if (action === "Cancel subtree" && (await ctx.ui.confirm("Cancel subtree?", selected.id)))
      await perform("cancel", { id: selected.id }, ctx);
    else if (action === "Cleanup") await status(ctx, true);
    else
      ctx.ui.notify(
        diagnostic(
          action === "Attachment instructions"
            ? `Attach manually: hc attach ${selected.terminal ?? "(not allocated)"}. Attaching does not resume a finished agent.`
            : `Transcript: ${selected.transcript ?? "not yet available"}\nResult: ${selected.result ?? "not yet available"}`,
        ),
        "info",
      );
  }
  pi.registerCommand("subagent", {
    description: "Delegate the entire query, or show subagents with no query",
    handler: async (args, ctx) => {
      if (!args.trim()) return status(ctx);
      try {
        const result = await perform("launch", { task: args }, ctx);
        if (ctx.hasUI) ctx.ui.notify(diagnostic(JSON.stringify(result)), "info");
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(diagnostic(error), "error");
        else throw error;
      }
    },
  });
  pi.registerCommand("subagents", {
    description: "Inspect subagents; /subagents cleanup removes selected finished terminals",
    handler: async (args, ctx) => {
      if (args.trim() && args.trim() !== "cleanup") throw new Error("Use /subagents or /subagents cleanup.");
      await status(ctx, args.trim() === "cleanup");
    },
  });
}
