import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { normalizePlanModeCompletion } from "./completion-tool.js";
import { type PlanDocument, type PlanStore, planHash } from "./plan-store.js";

export function resolvePlanEditorCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.VISUAL?.trim() || env.EDITOR?.trim();
  return configured || "vi";
}

async function openPlanInExternalEditor(
  ctx: ExtensionContext,
  document: PlanDocument,
  plan: string,
  current: { signal?: AbortSignal; isCurrent(): boolean },
): Promise<string | undefined> {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-open-"));
  const filePath = join(directory, `${document.name || "plan"}.md`);
  try {
    await writeFile(filePath, plan, { encoding: "utf8", mode: 0o600 });
    if (!current.isCurrent()) return undefined;
    const command = resolvePlanEditorCommand();
    const [editor = "vi", ...editorArgs] = command.split(/\s+/);
    const outcome = await ctx.ui.custom<
      { status: "complete"; text: string } | { status: "cancelled" } | { status: "error"; message: string }
    >(async (tui, _theme, _kb, done) => {
      if (!current.isCurrent()) {
        done({ status: "cancelled" });
        return { render: () => [], invalidate: () => {} };
      }
      tui.stop?.();
      try {
        const exit = await new Promise<number | NodeJS.Signals | null>((resolve) => {
          const child = spawn(editor, [...editorArgs, filePath], {
            stdio: "inherit",
            shell: process.platform === "win32",
          });
          const onAbort = () => child.kill();
          current.signal?.addEventListener("abort", onAbort, { once: true });
          child.on("error", () => {
            current.signal?.removeEventListener("abort", onAbort);
            resolve(null);
          });
          child.on("close", (code, signal) => {
            current.signal?.removeEventListener("abort", onAbort);
            resolve(code ?? signal);
          });
        });
        if (!current.isCurrent()) {
          done({ status: "cancelled" });
        } else if (exit === null) {
          done({
            status: "error",
            message: `Failed to launch external editor: ${sanitizeTerminalText(command)}`,
          });
        } else if (exit !== 0) {
          done({
            status: "error",
            message: `External editor exited with ${typeof exit === "number" ? `code ${exit}` : sanitizeTerminalText(String(exit))}; plan unchanged.`,
          });
        } else {
          const text = (await readFile(filePath, "utf8")).replace(/^\uFEFF/, "").replace(/\r?\n$/, "");
          done({ status: "complete", text });
        }
      } finally {
        tui.start?.();
        tui.requestRender?.(true);
      }
      return { render: () => [], invalidate: () => {} };
    });
    if (!outcome || outcome.status === "cancelled") return undefined;
    if (outcome.status === "error") throw new Error(outcome.message);
    return outcome.text;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Edit body text only; identity metadata and concurrent file changes remain protected. */
export async function editPlanDocument(
  ctx: ExtensionContext,
  store: PlanStore,
  document: PlanDocument,
  current: { signal?: AbortSignal; isCurrent(): boolean },
) {
  if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc"))
    throw new Error("Opening a plan for editing requires TUI or RPC mode.");
  const plan = await store.read(document);
  if (!current.isCurrent()) return;
  const text =
    ctx.mode === "tui"
      ? await openPlanInExternalEditor(ctx, document, plan, current)
      : await ctx.ui.editor(`Current plan: ${sanitizeTerminalText(document.path)}`, plan);
  if (!current.isCurrent() || text === undefined) return;
  const parsed = normalizePlanModeCompletion({ plan: text });
  if (!parsed.ok) throw new Error(parsed.error);
  const saved = await store.save(parsed.plan, {
    document,
    expectedHash: planHash(plan),
    ...current,
  });
  if (!current.isCurrent()) return;
  return { document: saved, hash: planHash(parsed.plan) };
}
