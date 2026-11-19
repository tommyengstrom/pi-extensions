import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionToolContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  ARTIFACT_TOOL_NAMES,
  backgroundRuntime,
  DELEGATION_EVENT,
  type Delegate,
  type Recipient,
  STATUS_EVENT,
  SUBAGENT_TOOL_NAMES,
} from "@narumitw/pi-background";
import { canonical, captureCapabilities, delegable } from "./capabilities.js";
import { parseTask, prepareWorker } from "./launch.js";
import { terminalText } from "./terminal-text.js";
import { type OperationHandler, registerSubagentTools } from "./tools.js";
import { type Job, Workers } from "./workers.js";

export default function herdr(pi: ExtensionAPI): void {
  const background = backgroundRuntime(pi);
  let workers: Workers | undefined;
  let owner: Recipient | undefined;
  const capture = (active = pi.getActiveTools()) => captureCapabilities(pi.getAllTools(), active, pi.getMcpServers());
  const loadout = (tools = capture()) => new Set(tools.map(canonical));
  let baseline = new Set<string>();
  const retains = (current = loadout()) => [...baseline].every((identity) => current.has(identity));
  const offRevoke = background.onRevoke((scope) => workers?.revoke(scope));
  const offStatus = pi.events.on(STATUS_EVENT, (v) => {
    const event = v as
      | { version: number; scope: string; respond: (s: { active: number; pending: number }) => void }
      | undefined;
    if (event?.version === 1 && typeof event.respond === "function")
      event.respond({ active: workers?.count(event.scope) ?? 0, pending: 0 });
  });
  const stop = async () => {
    const old = workers;
    owner = undefined;
    workers = undefined;
    await old?.dispose();
  };
  pi.on("session_tree", stop);
  pi.on("session_shutdown", async () => {
    offDelegate();
    offStatus();
    offRevoke();
    await stop();
  });
  const changed = () => {
    if (owner && !retains()) background.revoke(owner.scope);
  };
  let hidden: readonly string[] = [];
  pi.on("before_agent_start", (event) => {
    hidden = [...(event.systemPromptOptions.hiddenTools ?? [])];
    changed();
  });
  pi.on("tool_execution_end", changed);
  const perform = async (
    op: Parameters<OperationHandler>[0],
    input: Record<string, unknown>,
    ctx: Parameters<OperationHandler>[2],
    signal?: AbortSignal,
    plan?: string,
  ) => {
    signal?.throwIfAborted();
    const recipient = background.recipient(ctx);
    const valid = () => background.owns(recipient, ctx);
    if (!valid()) throw new Error("Subagent scope revoked.");
    const scope = recipient.scope;
    if (op === "launch") {
      const workflow = background.workflow(ctx);
      if (workflow?.held) throw new Error("Delegation is held for review.");
      const active = pi.getActiveTools();
      const restriction = workflow?.restrictions;
      if (!active.includes("subagent") || (restriction && !restriction.allowedTools.includes("subagent")))
        throw new Error("subagent is not selected in the current tool policy.");
      if (typeof input.task !== "string" || (input.agent !== undefined && typeof input.agent !== "string"))
        throw new Error("Expected a task and optional profile name");
      const request = { task: input.task, agent: input.agent as string | undefined, plan };
      const parent = process.env.HC_TERMINAL_ID;
      const socket = process.env.HC_TERMINAL_SOCKET;
      if (!parent || !socket)
        throw new Error("Subagents require a local Herdr Core terminal (HC_TERMINAL_ID and HC_TERMINAL_SOCKET).");
      // Do not let a new launch refresh the baseline for older workers.
      const inventory = capture(active);
      const current = loadout(inventory);
      if (owner && !retains(current)) background.revoke(owner.scope);
      const callable = (ctx as Partial<ExtensionToolContext>).tools?.map((t) => t.name);
      const suppressed = (ctx as Partial<ExtensionCommandContext>).getSystemPromptOptions?.().hiddenTools ?? hidden;
      const candidates = delegable(
        inventory,
        [...SUBAGENT_TOOL_NAMES, ...ARTIFACT_TOOL_NAMES, ...(restriction?.parentOnly ?? [])],
        restriction?.allowedTools,
        callable,
        suppressed,
      );
      if (!valid()) throw new Error("Worker permissions changed before launch.");
      owner = recipient;
      baseline = current;
      if (!workers)
        workers = new Workers(
          socket,
          parent,
          getAgentDir(),
          (s) => !!owner && owner.scope === s && background.owns(owner, ctx) && retains(),
          (job) => {
            if (!owner || owner.scope !== job.scope || !background.owns(owner, ctx)) return;
            background.enqueue({
              ...owner,
              id: `herdr:${job.id}`,
              jobId: job.id,
              topic: "subagent-result",
              wake: true,
              summary: `${job.state}: ${job.result ?? "Inspect the terminal"}`,
              result: job.resultPath ?? join(getAgentDir(), "pi-herdr-core", "workers", job.id),
            });
          },
        );
      const job = await workers.launch(
        scope,
        ctx.cwd,
        (dir) => prepareWorker(pi, ctx, getAgentDir(), dir, request, candidates, restriction?.guidance),
        signal,
        plan === undefined,
      );
      if (!valid()) throw new Error("Scope changed during launch.");
      if (plan !== undefined) {
        const settled = await workers.finish(job.id, scope);
        if (!valid()) throw new Error("Worker scope changed.");
        signal?.throwIfAborted();
        return { job: settled };
      }
      return { job };
    }
    const jobs = workers?.list(scope) ?? [];
    const brief = ({ result: _, ...job }: Job) => job;
    if (op === "query" && input.action === "list") return { jobs: jobs.map(brief) };
    const id = input.id;
    let job = jobs.find((j) => j.id === id);
    if (typeof id !== "string" || !workers || !job) throw new Error("Unknown worker in current scope");
    if (op === "wait") job = await workers.wait(id, scope, Number(input.timeout ?? 60000), signal);
    if (op === "cancel") job = await workers.cancel(id, scope);
    if (!valid()) throw new Error("Scope changed while awaiting worker");
    if ((op === "wait" || input.action === "result") && job.result)
      return { job, ...background.resultDetails(recipient, [`herdr:${id}`]) };
    return { job: brief(job) };
  };
  const delegate: Delegate = async (ctx, { task, plan }, signal) => {
    const { job } = (await perform("launch", { task }, ctx, signal, plan)) as { job: Job };
    return terminalText(
      `${job.state}: ${job.result ?? "Inspect the retained terminal."}${job.resultPath ? `\nFull result: ${job.resultPath}` : ""}`,
    );
  };
  const offDelegate = pi.events.on(DELEGATION_EVENT, (respond) => {
    if (typeof respond === "function") respond(delegate);
  });
  registerSubagentTools(pi, perform);
  pi.registerCommand("subagent", {
    description: "Delegate a task: /subagent [--agent PROFILE] TASK",
    handler: async (args, ctx) => {
      try {
        if (!args.trim()) {
          const jobs = workers?.list(background.recipient(ctx).scope) ?? [];
          ctx.ui.notify(
            jobs.map((j) => `${j.terminal ?? "unallocated"}: ${j.state} (${j.id})`).join("\n") ||
              "No workers in this scope.",
            "info",
          );
          return;
        }
        const { job } = (await perform("launch", parseTask(args), ctx)) as { job: Job };
        ctx.ui.notify(
          terminalText(
            [
              job.terminal ? `Started ${job.terminal} (${job.id})` : `Allocation uncertain (${job.id}); do not retry.`,
              ...job.omissions.map((s) => `Omitted ${s}`),
            ].join("\n"),
          ),
          "info",
        );
      } catch (e) {
        if (!ctx.hasUI) throw e;
        ctx.ui.notify(terminalText(String(e)), "error");
      }
    },
  });
}
