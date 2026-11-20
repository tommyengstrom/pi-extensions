import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePiCli } from "./runtime-resolution.js";

const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";

// herdr-app ls: local spaces have machine: null; never assume missing metadata is local.
export function desktopSpace(snapshot: unknown, parent?: string): string {
  if (!record(snapshot) || !Array.isArray(snapshot.spaces)) throw new Error("Unsupported Herdr desktop listing.");
  const local = snapshot.spaces.filter(
    (s): s is Record<string, unknown> => record(s) && s.machine === null && typeof s.id === "string" && !!s.id,
  );
  const matching = local.filter(
    (s) =>
      parent &&
      Array.isArray(s.tabs) &&
      s.tabs.some(
        (t) => record(t) && Array.isArray(t.terminals) && t.terminals.some((p) => record(p) && p.terminal === parent),
      ),
  );
  const target = matching.length ? matching : local;
  if (target.length !== 1)
    throw new Error("Open a local Herdr desktop space. If several are open, run /btw from the intended space.");
  return String(target[0]?.id);
}

export async function continueInDesktop(
  pi: ExtensionAPI,
  cwd: string,
  signal: AbortSignal,
  check: () => void,
  save: () => string,
  cli = resolvePiCli,
) {
  const exec = (args: string[]) => pi.exec("herdr-app", args, { signal, timeout: 8000, maxBuffer: 1024 * 1024 });
  check();
  const listing = await exec(["ls"]).catch(() => undefined);
  check();
  if (listing?.code !== 0 || listing.killed || listing.truncated)
    throw new Error("Open Herdr desktop and ensure herdr-app is on PATH; the side chat is still here.");
  const space = desktopSpace(JSON.parse(listing.stdout), process.env.HC_TERMINAL_ID);
  const binary = await cli();
  check();
  const tools = pi.getActiveTools();
  const file = save();
  const argv = [
    process.execPath,
    binary,
    ...(tools.length ? ["--tools", tools.join(",")] : ["--no-tools"]),
    "--session",
    file,
  ];
  try {
    const result = await exec([
      "do",
      "tab.new",
      JSON.stringify({ space, name: "BTW", folder: cwd, argv, focus: true }),
    ]);
    const reply: unknown = JSON.parse(result.stdout);
    if (
      result.code !== 0 ||
      result.killed ||
      result.truncated ||
      !record(reply) ||
      reply.space !== space ||
      typeof reply.terminal !== "string" ||
      typeof reply.tab !== "string"
    )
      throw new Error();
  } catch {
    throw new UnconfirmedTab(
      `Tab launch unconfirmed. Check Herdr before opening another tab. Saved side session: ${file}`,
    );
  }
}
export class UnconfirmedTab extends Error {}
