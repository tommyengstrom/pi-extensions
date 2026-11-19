import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Optional Herdr integration. Discover a service first so duplicate listeners cannot start duplicate workers. */
export const DELEGATION_EVENT_V2 = "pi-herdr-core:delegate-and-wait:v2";
export const MAX_DELEGATED_WORKERS = 4;
export interface WorkerOverrides {
  model?: string;
  effort?: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  remove_tools?: string[];
}
export type Delegate = (
  ctx: ExtensionContext,
  input: { task: string; plan: string } & WorkerOverrides,
  signal: AbortSignal,
) => Promise<string>;
export function delegationServiceV2(pi: ExtensionAPI): Delegate {
  let delegate: Delegate | undefined;
  pi.events.emit(DELEGATION_EVENT_V2, (service: Delegate) => {
    delegate ??= service;
  });
  if (!delegate) throw new Error("Herdr Core delegation v2 is unavailable. Install a compatible worker extension.");
  return delegate;
}
