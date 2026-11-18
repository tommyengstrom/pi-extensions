import type { ControlPeer } from "./control.js";

const KEY = Symbol.for("@narumitw/pi-herdr-core/controlled-child/v1");
export interface ControlledChildContext {
  peer: ControlPeer;
  job: string;
  attempt: string;
}
export function installChildContext(value: ControlledChildContext): void {
  const host = globalThis as typeof globalThis & { [KEY]?: ControlledChildContext };
  if (host[KEY]) throw new Error("Conflicting controlled child runtime.");
  host[KEY] = value;
}
export function childContext(): ControlledChildContext | undefined {
  return (globalThis as typeof globalThis & { [KEY]?: ControlledChildContext })[KEY];
}
