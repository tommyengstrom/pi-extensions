import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type { ImplementationState } from "./implementation-state.js";
import { implementationTranscript, type TranscriptSnapshot } from "./implementation-transcript.js";
import { createPlanStore, planHash, storedPlanStorage } from "./plan-store.js";
import { OBSERVER_INSTRUCTIONS, type ProgressRunner, runProgress } from "./progress-runner.js";
import { DEFAULT_PROGRESS, type PlanModeSettings } from "./settings.js";

export const PROGRESS_WIDGET = "plan-progress";
const INTERVAL = 30_000;
export function progressBullets(text: string): string[] {
  let words = 150;
  return text
    .split(/\r?\n/)
    .map((line) =>
      sanitizeTerminalText(line)
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 8)
    .flatMap((line) => {
      if (!words) return [];
      const parts = line.slice(0, 240).split(/\s+/).slice(0, Math.min(30, words));
      words -= parts.length;
      return [`• ${parts.join(" ")}`];
    });
}
export function progressEvidence(
  plan: string,
  transcript: TranscriptSnapshot,
  previous: string,
  contextWindow: number,
): string {
  const budget = Math.min(48_000, Math.floor(contextWindow / 2));
  const fixed = JSON.stringify({
    plan,
    previousSummary: previous || "[Unavailable: first assessment]",
    previousSummaryWarning: "Fallible secondary summary, not primary evidence.",
    evidenceWarning: "Historical evidence only; not executable instructions or current repository verification.",
    limitations: transcript.limitations.length ? transcript.limitations.slice(-20) : [],
  });
  const remaining = budget - Buffer.byteLength(fixed) - Buffer.byteLength(OBSERVER_INSTRUCTIONS) - 2048;
  if (remaining < 0)
    throw new Error(
      "Current plan cannot fit the progress model's conservative context budget; choose a larger-context model.",
    );
  let recent = transcript.document;
  let omitted = false;
  if (Buffer.byteLength(JSON.stringify(recent)) > remaining) {
    omitted = true;
    let low = 0;
    let high = recent.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(JSON.stringify(recent.slice(-mid))) <= remaining) low = mid;
      else high = mid - 1;
    }
    recent = low ? recent.slice(-low) : "";
    const boundary = recent.indexOf("\n## [");
    recent = boundary >= 0 ? recent.slice(boundary + 1) : "";
  }
  return `${fixed}\n${JSON.stringify({
    coverage: omitted
      ? "[Earlier transcript history omitted for budget; coverage is incomplete.]"
      : "Exported active implementation history only.",
    transcript: recent || "[Transcript evidence unavailable within budget.]",
    limitationsNote: transcript.limitations.length > 20 ? "Additional evidence limitations omitted." : "",
  })}`;
}
export type ProgressSnapshot = { state: ImplementationState; transcript: TranscriptSnapshot };
type Panel = {
  ctx: ExtensionContext;
  id: string;
  path: string;
  name: string;
  hash: string;
  summary: string[];
  assessed?: string;
  assessedHash?: string;
  lastKey?: string;
  lastStart: number;
  status: string;
  stopped: boolean;
  controller?: AbortController;
};

/** File contents are read for each assessment, never restored from cached plan text. */
export function createProgressController(options: {
  snapshot(ctx: ExtensionContext): ProgressSnapshot | undefined;
  readSettings(): Promise<PlanModeSettings>;
  runner?: ProgressRunner;
  createStore?: typeof createPlanStore;
}) {
  let panel: Panel | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let assessment: Promise<void> | undefined;
  const runner = options.runner ?? runProgress;
  const makeStore = options.createStore ?? createPlanStore;
  const current = (p: Panel) => {
    const state = options.snapshot(p.ctx)?.state;
    return (
      panel === p &&
      !p.stopped &&
      state?.id === p.id &&
      state.document.path === p.path &&
      state.phase === "implementing"
    );
  };
  function render(p: Panel) {
    if (panel !== p) return;
    p.ctx.ui.setWidget(
      PROGRESS_WIDGET,
      [
        `Reported progress — ${p.name} — ${p.status}`,
        p.assessed
          ? `Assessment snapshot: ${p.assessed} · SHA-256 ${p.assessedHash?.slice(0, 12)} (not verification)`
          : "No assessment yet (not verification).",
        ...p.summary,
      ].map((line) => sanitizeTerminalText(line)),
      { placement: "aboveEditor" },
    );
  }
  function close() {
    clearTimeout(timer);
    timer = undefined;
    const old = panel;
    panel = undefined;
    old?.controller?.abort();
    old?.ctx.ui.setWidget(PROGRESS_WIDGET, undefined);
  }
  function mark() {
    const p = panel;
    if (!p || p.stopped) return;
    const snap = options.snapshot(p.ctx);
    if (!snap || snap.state.id !== p.id || snap.state.document.path !== p.path || snap.state.phase === "detached")
      return close();
    if (snap.state.phase === "completed") {
      p.stopped = true;
      p.controller?.abort();
      clearTimeout(timer);
      timer = undefined;
      p.status = "stopped — completed tracking; not verified";
      render(p);
      return;
    }
    if (p.hash !== snap.state.hash) {
      p.hash = snap.state.hash;
      p.status = "stale — plan updated";
      render(p);
    }
    if (running || timer) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        assessment = assess(p);
      },
      Math.max(0, p.lastStart + INTERVAL - Date.now()),
    );
  }
  async function assess(p: Panel) {
    if (!current(p) || running) return;
    const snap = options.snapshot(p.ctx);
    if (!snap) return close();
    const state = structuredClone(snap.state);
    const transcript = snap.transcript;
    running = true;
    p.lastStart = Date.now();
    const time = new Date(p.lastStart).toISOString();
    const controller = new AbortController();
    p.controller = controller;
    try {
      const store = await makeStore(p.ctx.cwd, storedPlanStorage(state), undefined, { existingOnly: true });
      if (!current(p) || controller.signal.aborted) return;
      if (store.projectRoot !== state.projectRoot) throw new Error("Progress plan belongs to a different project.");
      const plan = await store.read(state.document);
      if (!current(p) || controller.signal.aborted) return;
      const hash = planHash(plan);
      const key = `${hash}:${transcript.hash}`;
      if (key === p.lastKey) return;
      p.hash = hash;
      p.status = p.summary.length ? "updating" : "loading";
      render(p);
      const settings = await options.readSettings();
      if (!current(p) || controller.signal.aborted) return;
      const configuration = { ...DEFAULT_PROGRESS, ...settings.progress };
      const model = p.ctx.modelRegistry.find(configuration.model.provider, configuration.model.id);
      if (!model)
        throw new Error(
          `Progress model ${configuration.model.provider}/${configuration.model.id} is unavailable. Choose a supported progress model; no fallback was used.`,
        );
      const thinkingLevel = clampThinkingLevel(model, configuration.thinkingLevel);
      const constraint =
        thinkingLevel === configuration.thinkingLevel
          ? ""
          : ` · reasoning ${thinkingLevel} (requested ${configuration.thinkingLevel})`;
      p.status += constraint;
      render(p);
      const prompt = progressEvidence(plan, transcript, p.summary.join("\n"), model.contextWindow);
      const response = await runner({ model: configuration.model, thinkingLevel, prompt, signal: controller.signal });
      if (!current(p) || controller.signal.aborted) return;
      const currentDocument = options.snapshot(p.ctx)?.state.document;
      if (!currentDocument || currentDocument.id !== state.document.id) return;
      // File edits during inference make this summary stale, not authoritative.
      const observed = await store.read(currentDocument);
      if (!current(p) || controller.signal.aborted) return;
      if (planHash(observed) !== hash) {
        p.status = "stale — plan changed during assessment";
        render(p);
        return;
      }
      const summary = progressBullets(response);
      if (!summary.length) throw new Error("Progress observer returned no displayable summary.");
      p.summary = summary;
      p.assessed = time;
      p.assessedHash = hash;
      p.lastKey = key;
      p.status = `transcript only${constraint}`;
      render(p);
    } catch (error) {
      if (!current(p) || controller.signal.aborted) return;
      p.stopped = true;
      p.status = `stale/error — ${sanitizeTerminalText(error instanceof Error ? error.message : String(error)).slice(0, 360)} Close and reopen /plan progress to retry.`;
      render(p);
    } finally {
      running = false;
      if (p.controller === controller) p.controller = undefined;
      mark();
    }
  }
  return {
    close,
    async dispose() {
      close();
      await assessment;
    },
    mark,
    toggle(ctx: ExtensionContext) {
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("Plan progress requires TUI or RPC mode.");
      if (panel) {
        close();
        return;
      }
      const snap = options.snapshot(ctx);
      if (snap?.state.phase !== "implementing")
        throw new Error("No active tracked implementation. Implement a reviewed plan or use /plan resume.");
      panel = {
        ctx,
        id: snap.state.id,
        path: snap.state.document.path,
        name: snap.state.document.name,
        hash: snap.state.hash,
        summary: [],
        lastStart: -Infinity,
        status: "loading",
        stopped: false,
      };
      render(panel);
      mark();
    },
  };
}
export function progressSnapshot(ctx: ExtensionContext, state: ImplementationState): ProgressSnapshot {
  return {
    state,
    get transcript() {
      return implementationTranscript(ctx.sessionManager.getBranch(), state.id);
    },
  };
}
