import { randomUUID } from "node:crypto";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, truncateHead } from "@earendil-works/pi-coding-agent";
import { backgroundRuntime, type Recipient } from "@narumitw/pi-background";
import { Type } from "typebox";
import type { runArtifact, Selection } from "./agent.js";
import { diagnostic, REFERENCE_ENTRY, record, SERVICE_EVENT } from "./contract.js";
import { ArtifactJobs } from "./jobs.js";
import { ArtifactStore, type Job } from "./store.js";

function result(jobs: Job[]) {
  return {
    content: [
      {
        type: "text" as const,
        text: truncateHead(
          jobs
            .map((job) =>
              diagnostic(
                `${job.jobId}: ${job.status}\nArtifact: ${job.artifactId}\nDirectory: ${job.directory}\n${job.summary}\n${job.paths.slice(0, 20).join("\n")}`,
              ),
            )
            .join("\n\n"),
          { maxBytes: 48 * 1024, maxLines: 1900 },
        ).content,
      },
    ],
    details: { version: 1, artifacts: jobs },
  };
}
const eventId = (job: Job) => `artifact:${job.jobId}`;
export default function artifacts(
  pi: ExtensionAPI,
  dependencies: { run?: typeof runArtifact; agentDir?: string } = {},
) {
  const background = backgroundRuntime(pi);
  let store: ArtifactStore | undefined;
  let jobs: ArtifactJobs | undefined;
  let owner: ExtensionContext["sessionManager"] | undefined;
  let ctx: ExtensionContext | undefined;
  let epoch = 0;
  const recipients = new Map<string, Recipient>();
  const offRevoke = background.onRevoke((scope) => {
    const ids = [...recipients].filter(([, recipient]) => recipient.scope === scope).map(([id]) => id);
    if (ids.length) void jobs?.cancelOwned(ids).catch(() => {});
  });
  async function stop() {
    epoch++;
    const old = jobs;
    jobs = undefined;
    owner = undefined;
    recipients.clear();
    try {
      await old?.close();
    } finally {
      store?.close();
      store = undefined;
      const previous = ctx;
      ctx = undefined;
      if (previous?.hasUI) previous.ui.setStatus("pi-artifacts", undefined);
    }
  }
  async function start(context: ExtensionContext) {
    await stop();
    ctx = context;
    owner = context.sessionManager;
    const generation = epoch;
    function current() {
      return generation === epoch && owner === context.sessionManager;
    }
    const initialize = () => {
      if (!current()) throw new Error("Artifact caller session was replaced.");
      if (!jobs) {
        store = new ArtifactStore(dependencies.agentDir ?? getAgentDir());
        jobs = new ArtifactJobs(
          store,
          `${context.sessionManager.getSessionId()}:${randomUUID()}`,
          {
            accepted(job, admission) {
              if (!current()) throw new Error("Artifact caller changed before acknowledgement.");
              if (!record(admission) || typeof admission.session !== "string" || typeof admission.scope !== "string")
                throw new Error("Artifact admission is missing its original recipient.");
              const recipient = { session: admission.session, scope: admission.scope };
              if (!background.owns(recipient, context))
                throw new Error("Artifact workflow scope was revoked during admission.");
              recipients.set(job.jobId, recipient);
              pi.appendEntry(REFERENCE_ENTRY, job);
              pi.events.emit(REFERENCE_ENTRY, { sessionId: context.sessionManager.getSessionId(), reference: job });
            },
            terminal(job) {
              const recipient = recipients.get(job.jobId);
              if (!current() || !recipient || !background.owns(recipient, context)) return;
              pi.appendEntry(REFERENCE_ENTRY, job);
              pi.events.emit(REFERENCE_ENTRY, { sessionId: context.sessionManager.getSessionId(), reference: job });
              const queued = background.enqueue({
                ...recipient,
                id: eventId(job),
                jobId: job.jobId,
                topic: "artifact-result",
                summary: diagnostic(`${job.jobId}: ${job.status}\n${job.summary}`).slice(0, 2000),
                result: job.directory,
                wake: false,
              });
              if (context.hasUI)
                context.ui.setStatus(
                  "pi-artifacts",
                  `artifact ${job.status}${queued === "full" ? " (query result)" : ""}`,
                );
            },
            progress(text) {
              if (current() && context.hasUI) context.ui.setStatus("pi-artifacts", diagnostic(text));
            },
          },
          dependencies.run,
        );
      }
      return jobs;
    };
    getJobs = initialize;
  }
  let getJobs: () => ArtifactJobs = () => {
    throw new Error("Artifact extension has no active session.");
  };
  pi.on("session_start", (_event, context) => start(context));
  pi.on("session_tree", (_event, context) => start(context));
  pi.on("session_shutdown", async () => {
    offRevoke();
    offService();
    await stop();
  });
  pi.on("agent_settled", async (event) => {
    if (event.aborted) await jobs?.cancelOwned();
  });
  // Synchronous registration of an async reply avoids event-bus await assumptions.
  const offService = pi.events.on(SERVICE_EVENT, (value) => {
    if (
      !record(value) ||
      value.version !== 1 ||
      typeof value.respond !== "function" ||
      !ctx ||
      value.sessionId !== ctx.sessionManager.getSessionId()
    )
      return;
    const respond = value.respond as (value: unknown) => void;
    try {
      const ids = value.jobIds;
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
        throw new Error("Invalid artifact service request.");
      if (value.action === "status") respond({ version: 1, jobs: ids.map((id) => getJobs().store.current(id)) });
      else if (value.action === "cancel")
        void getJobs()
          .cancelOwned(ids)
          .then(
            () => respond({ version: 1 }),
            (error) => respond({ error: diagnostic(error) }),
          );
      else respond({ error: "Unknown artifact service action." });
    } catch (error) {
      respond({ error: diagnostic(error) });
    }
  });
  function selection(context: ExtensionContext): Selection {
    if (context.sessionManager !== owner || !context.model) throw new Error("Artifact caller/model unavailable.");
    return { model: context.model, modelRegistry: context.modelRegistry, thinkingLevel: context.thinkingLevel };
  }
  const task = Type.String({ minLength: 1, maxLength: 32000 });
  const id = Type.String({ minLength: 1, maxLength: 100 });
  pi.registerTool({
    name: "artifact_create",
    label: "Create artifact",
    description:
      "Claim a new or empty directory and queue background artifact generation. Returns acknowledgement, not finished output. Continue independent work; use artifact_wait at a dependency. Additional provider usage applies.",
    parameters: Type.Object({ directory: Type.String({ minLength: 1, maxLength: 4096 }), task }),
    async execute(_id, params, signal, _update, context) {
      signal?.throwIfAborted();
      const recipient = background.recipient(context);
      const selected = selection(context);
      if (!background.owns(recipient, context))
        throw new Error("Artifact workflow scope was revoked before admission.");
      return result([
        getJobs().submit({ directory: params.directory, source: context.cwd }, params.task, selected, recipient),
      ]);
    },
  });
  pi.registerTool({
    name: "artifact_update",
    label: "Update artifact",
    description:
      "Queue feedback for a registered artifact, preserving its directory, filenames and saved child conversation. Rejects overlapping updates.",
    parameters: Type.Object({ artifactId: id, task }),
    async execute(_id, params, signal, _update, context) {
      signal?.throwIfAborted();
      const recipient = background.recipient(context);
      const selected = selection(context);
      if (!background.owns(recipient, context))
        throw new Error("Artifact workflow scope was revoked before admission.");
      return result([getJobs().submit({ artifactId: params.artifactId }, params.task, selected, recipient)]);
    },
  });
  pi.registerTool({
    name: "artifact_status",
    label: "Artifact status",
    description: "Read durable job state without model requests or reruns. Prefer artifact_wait over polling.",
    parameters: Type.Object({ jobId: id }),
    async execute(_id, params) {
      return result([getJobs().status(params.jobId)]);
    },
  });
  pi.registerTool({
    name: "artifact_wait",
    label: "Wait for artifacts",
    description:
      "Await requested artifact jobs and return terminal results. Use only at a real dependency, after independent work. Does not retry failures.",
    parameters: Type.Object({ jobIds: Type.Array(id, { minItems: 1, maxItems: 100 }) }),
    async execute(_id, params, signal) {
      const current = epoch;
      const manager = getJobs();
      const results = await manager.wait(params.jobIds, signal);
      if (current !== epoch || manager !== jobs) throw new Error("Artifact wait belongs to a replaced session.");
      const ids: string[] = [];
      for (const job of results) {
        const recipient = recipients.get(job.jobId);
        if (recipient && background.owns(recipient)) {
          background.resultDetails(recipient, [eventId(job)]);
          ids.push(eventId(job));
        }
      }
      const output = result(results);
      return { ...output, details: { ...output.details, backgroundEventIds: ids } };
    },
  });
  pi.registerTool({
    name: "artifact_cancel",
    label: "Cancel artifact job",
    description:
      "Cancel a specific queued/running job. Retains partial output and conversation for an explicit update. Does not cancel later iterations.",
    parameters: Type.Object({ jobId: id }),
    async execute(_id, params) {
      const current = epoch;
      const manager = getJobs();
      const cancelled = await manager.cancel(params.jobId);
      if (current !== epoch || manager !== jobs)
        throw new Error("Artifact cancellation belongs to a replaced session.");
      return result([cancelled]);
    },
  });
}
