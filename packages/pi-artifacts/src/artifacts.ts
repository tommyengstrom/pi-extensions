import { randomUUID } from "node:crypto";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { runArtifact, Selection } from "./agent.js";
import { diagnostic, REFERENCE_ENTRY, record, SERVICE_EVENT, validReference } from "./contract.js";
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
export default function artifacts(
  pi: ExtensionAPI,
  dependencies: { run?: typeof runArtifact; agentDir?: string } = {},
) {
  let store: ArtifactStore | undefined;
  let jobs: ArtifactJobs | undefined;
  let owner: ExtensionContext["sessionManager"] | undefined;
  let ctx: ExtensionContext | undefined;
  let epoch = 0;
  let dialog = false;
  const notifications = new Map<string, Job>();
  const delivered = new Set<string>();
  async function stop() {
    epoch++;
    const old = jobs;
    jobs = undefined;
    owner = undefined;
    notifications.clear();
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
    delivered.clear();
    for (const entry of context.sessionManager.getBranch()) {
      if (
        entry.type === "custom_message" &&
        entry.customType === "pi-artifacts-terminal-v1" &&
        record(entry.details) &&
        validReference(entry.details)
      )
        delivered.add(entry.details.jobId);
    }
    // Opening control storage is lazy: merely installing the extension writes nothing.
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
            accepted(job) {
              if (!current()) throw new Error("Artifact caller changed before acknowledgement.");
              pi.appendEntry(REFERENCE_ENTRY, job);
              pi.events.emit(REFERENCE_ENTRY, { sessionId: context.sessionManager.getSessionId(), reference: job });
            },
            terminal(job) {
              if (!current()) return;
              pi.appendEntry(REFERENCE_ENTRY, job);
              pi.events.emit(REFERENCE_ENTRY, { sessionId: context.sessionManager.getSessionId(), reference: job });
              if (!delivered.has(job.jobId)) notifications.set(job.jobId, job);
              if (context.hasUI) context.ui.setStatus("pi-artifacts", `artifact ${job.status}`);
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
  pi.on("session_shutdown", () => stop());
  pi.on("agent_settled", async (event) => {
    if (event.aborted) await jobs?.cancelOwned();
  });
  pi.on("ui_prompt_start", () => {
    dialog = true;
  });
  pi.on("ui_prompt_end", () => {
    dialog = false;
  });
  pi.on("turn_end", (event, context) => {
    if (dialog || owner !== context.sessionManager || event.outcome !== "completed") return;
    const ready = [...notifications.values()].filter((job) => !delivered.has(job.jobId)).slice(0, 20);
    if (!ready.length) return;
    for (const job of ready) {
      delivered.add(job.jobId);
      notifications.delete(job.jobId);
    }
    return {
      entries: [
        ...event.entries,
        ...ready.map((job) => ({
          type: "custom_message" as const,
          customType: "pi-artifacts-terminal-v1",
          content: result([job]).content[0].text,
          display: false,
          details: job,
        })),
      ],
    };
  });
  // Synchronous registration of an async reply avoids depending on event-bus await semantics.
  pi.events.on(SERVICE_EVENT, (value) => {
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
      const selected = selection(context);
      return result([getJobs().submit({ directory: params.directory, source: context.cwd }, params.task, selected)]);
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
      const selected = selection(context);
      return result([getJobs().submit({ artifactId: params.artifactId }, params.task, selected)]);
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
      for (const job of results) {
        delivered.add(job.jobId);
        notifications.delete(job.jobId);
      }
      return result(results);
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
