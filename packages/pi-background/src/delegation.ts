import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Optional Herdr integration. Discover a service first so duplicate listeners cannot start duplicate workers. */
export const DELEGATION_EVENT = "pi-herdr-core:delegate-and-wait:v1";
export type Delegate = (
  ctx: ExtensionContext,
  input: { task: string; plan: string },
  signal: AbortSignal,
) => Promise<string>;
export function delegationService(pi: ExtensionAPI): Delegate {
  let delegate: Delegate | undefined;
  pi.events.emit(DELEGATION_EVENT, (service: Delegate) => {
    delegate ??= service;
  });
  if (!delegate) throw new Error("Herdr Core delegation is unavailable.");
  return delegate;
}
