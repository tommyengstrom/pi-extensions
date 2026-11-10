import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { afterAll, expect, test } from "vitest";

const root = mkdtempSync(join(tmpdir(), "artifact-sdk-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
afterAll(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const { createAgentSession, ModelRuntime, ModelRegistry, SessionManager, SettingsManager } = await import(
  "@earendil-works/pi-coding-agent"
);
const { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } = await import(
  "@earendil-works/pi-ai"
);
const { ArtifactStore } = await import("../src/store.js");
const { ArtifactJobs } = await import("../src/jobs.js");
const { isolatedResources, openHistory } = await import("../src/agent.js");

test("real SDK create-feedback-feedback-reload preserves history and stable prefix, with six tools and no resource discovery", async () => {
  const project = join(root, "source");
  mkdirSync(project);
  writeFileSync(join(project, "source.txt"), "source inspection evidence");
  writeFileSync(join(project, "AGENTS.md"), "PARENT PROJECT INSTRUCTIONS MUST NOT LEAK");
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const artifactStarted = Promise.withResolvers<void>();
  const releaseArtifact = Promise.withResolvers<void>();
  let plannerRequests = 0;
  const requests: Message[][] = [];
  const auth: Array<string | undefined> = [];
  runtime.registerProvider("artifact-offline", {
    api: "openai-completions",
    apiKey: "parent-credential",
    baseUrl: "https://offline.invalid",
    models: [
      {
        id: "artifact",
        name: "Artifact",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context, options) {
      auth.push(options?.apiKey);
      const last = context.messages.at(-1);
      const user = context.messages.findLast((m) => m.role === "user");
      const task = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
      const independentPlanner = task?.includes("INDEPENDENT_PLANNER_WORK") ?? false;
      if (independentPlanner) plannerRequests++;
      else requests.push(structuredClone(context.messages));
      const round = Number(/round(\d)/.exec(task ?? "")?.[1] ?? "1");
      const tool = last?.role === "user" && !independentPlanner;
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: tool
          ? [
              { type: "toolCall", id: `read-${round}`, name: "read", arguments: { path: join(project, "source.txt") } },
              {
                type: "toolCall",
                id: `change-${round}`,
                name: round === 1 ? "write" : "edit",
                arguments:
                  round === 1
                    ? { path: "index.html", content: "round1" }
                    : { path: "index.html", edits: [{ oldText: `round${round - 1}`, newText: `round${round}` }] },
              },
              ...(round === 1
                ? [
                    {
                      type: "toolCall" as const,
                      id: "instructions",
                      name: "write",
                      arguments: { path: "AGENTS.md", content: "GENERATED INSTRUCTIONS MUST NOT LEAK" },
                    },
                    {
                      type: "toolCall" as const,
                      id: "extension",
                      name: "write",
                      arguments: {
                        path: ".pi/extensions/trap.ts",
                        content: "throw new Error('GENERATED EXTENSION EXECUTED');",
                      },
                    },
                  ]
                : []),
            ]
          : [{ type: "text", text: `Completed round${round}.` }],
        stopReason: tool ? "toolUse" : "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      const finish = () => {
        stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
        stream.end();
      };
      if (!independentPlanner && requests.length === 1) {
        artifactStarted.resolve();
        void releaseArtifact.promise.then(finish);
      } else finish();
      return stream;
    },
  });
  const model = runtime.getModel("artifact-offline", "artifact");
  if (!model) throw new Error("Missing fake model");
  const selection = { model, thinkingLevel: "off" as const, modelRegistry: new ModelRegistry(runtime) };
  const store = new ArtifactStore(join(root, "agent"));
  let jobs = new ArtifactJobs(store, "first-session", { accepted() {}, terminal() {}, progress() {} });
  const { session: planner } = await createAgentSession({
    cwd: project,
    model,
    modelRuntime: runtime,
    resourceLoader: isolatedResources(),
    tools: [],
    sessionManager: SessionManager.inMemory(project),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
  });
  try {
    const first = jobs.submit({ directory: join(root, "output"), source: project }, "round1", selection);
    await artifactStarted.promise;
    await planner.prompt("INDEPENDENT_PLANNER_WORK: continue technical investigation.");
    expect(plannerRequests).toBe(1);
    expect(jobs.status(first.jobId).status).toBe("running");
    releaseArtifact.resolve();
    expect((await jobs.wait([first.jobId]))[0].status).toBe("succeeded");
    for (const round of [2, 3]) {
      const next = jobs.submit({ artifactId: first.artifactId }, `round${round}`, selection);
      const [result] = await jobs.wait([next.jobId]);
      expect(result.status).toBe("succeeded");
      expect(result.usage?.totalTokens).toBe(4);
    }
    await jobs.close();
    jobs = new ArtifactJobs(store, "replacement-session", { accepted() {}, terminal() {}, progress() {} });
    const fourth = jobs.submit({ artifactId: first.artifactId }, "round4", selection);
    expect((await jobs.wait([fourth.jobId]))[0].status).toBe("succeeded");
    expect(readFileSync(join(first.directory, "index.html"), "utf8")).toBe("round4");
    expect(requests).toHaveLength(8);
    const prefixes = requests.map((messages) => getCurrentSystemPrompt(messages));
    expect(new Set(prefixes).size).toBe(1);
    expect(prefixes[0]).not.toContain("GENERATED INSTRUCTIONS");
    expect(prefixes[0]).not.toContain("PARENT PROJECT INSTRUCTIONS");
    for (const messages of requests)
      expect(
        getCurrentTools(messages)
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
    expect(auth.every((key) => key === "parent-credential")).toBe(true);
    const history = readFileSync(store.getArtifact(first.artifactId).history, "utf8");
    expect(history).not.toContain("parent-credential");
    expect(history).not.toContain("INDEPENDENT_PLANNER_WORK");
    expect(history).toContain("source inspection evidence");
    expect(history).toContain("round1");
    expect(history).toContain("round4");
    expect(openHistory(store.getArtifact(first.artifactId)).getSessionId()).toBe(first.artifactId);
    writeFileSync(store.getArtifact(first.artifactId).history, `${history}{broken JSON\n`);
    const corrupt = jobs.submit({ artifactId: first.artifactId }, "round5", selection);
    expect((await jobs.wait([corrupt.jobId]))[0].status).toBe("failed");
    expect(requests).toHaveLength(8);
    unlinkSync(store.getArtifact(first.artifactId).history);
    const missing = jobs.submit({ artifactId: first.artifactId }, "round5", selection);
    expect((await jobs.wait([missing.jobId]))[0].status).toBe("failed");
    expect(requests).toHaveLength(8);
  } finally {
    releaseArtifact.resolve();
    await jobs.close();
    await planner.abort();
    planner.dispose();
    store.close();
  }
});
