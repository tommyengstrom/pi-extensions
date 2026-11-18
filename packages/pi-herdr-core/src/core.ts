import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute } from "node:path";

export class CoreError extends Error {
  constructor(
    message: string,
    readonly dispatched: boolean,
    readonly kind?: string,
  ) {
    super(message);
    this.name = "CoreError";
  }
}
export interface CoreTerminal {
  address: string;
  parent: string | null;
  state: "live" | "finished";
  labels: Record<string, string>;
  argv: string[];
  created_ms: number;
  keep: boolean;
  rm: boolean;
  notify: boolean;
}
export interface CoreIdentity {
  id: string;
  version: string;
}
type Method = "terminal.get" | "terminal.list" | "terminal.run" | "terminal.kill" | "terminal.rm";
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function localAddress(value: string): string {
  if (value.trim() !== value || !/^t[1-9][0-9]*$/.test(value))
    throw new CoreError("A local Core terminal address is required.", false);
  return value;
}
export function parseTerminal(value: unknown): CoreTerminal {
  if (
    !object(value) ||
    typeof value.address !== "string" ||
    !["live", "finished"].includes(String(value.state)) ||
    !(value.parent === null || typeof value.parent === "string") ||
    !object(value.labels) ||
    !Object.values(value.labels).every((item) => typeof item === "string") ||
    !Array.isArray(value.argv) ||
    !value.argv.every((item) => typeof item === "string") ||
    !Number.isSafeInteger(value.created_ms) ||
    typeof value.keep !== "boolean" ||
    typeof value.rm !== "boolean" ||
    typeof value.notify !== "boolean"
  )
    throw new CoreError("Malformed Core terminal response.", true);
  localAddress(value.address);
  // Persist only the allocation identity, not arbitrary terminal/foreground fields.
  return {
    address: value.address,
    parent: value.parent as string | null,
    state: value.state as "live" | "finished",
    labels: { ...value.labels } as Record<string, string>,
    argv: [...value.argv] as string[],
    created_ms: value.created_ms as number,
    keep: value.keep,
    rm: value.rm,
    notify: value.notify,
  };
}

/** Local, bounded, plain JSON-RPC. No CLI, shell, autostart, remote routing or retry. */
export class CoreClient {
  constructor(
    readonly socket: string,
    readonly expectedCore?: string,
  ) {
    if (!isAbsolute(socket)) throw new CoreError("HC_TERMINAL_SOCKET must be an absolute local socket path.", false);
  }
  async call(
    method: Method,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ core: CoreIdentity; result: unknown }> {
    signal?.throwIfAborted();
    const stat = await lstat(this.socket);
    if (!stat.isSocket() || !process.getuid || stat.uid !== process.getuid())
      throw new CoreError("Core socket is not owned by the current local user.", false);
    signal?.throwIfAborted();
    const helloId = randomUUID();
    const requestId = randomUUID();
    const packet = `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`;
    if (Buffer.byteLength(packet) > 256 * 1024) throw new CoreError("Core request exceeds limit.", false);
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socket);
      let buffer = Buffer.alloc(0);
      let done = false;
      let dispatched = false;
      let core: CoreIdentity | undefined;
      const finish = (error?: CoreError, result?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(error);
        else if (core) resolve({ core, result });
        else reject(new CoreError("Missing Core handshake.", dispatched));
      };
      const abort = () =>
        finish(new CoreError("Core request cancelled; reconcile any dispatched mutation.", dispatched));
      const timer = setTimeout(
        () => finish(new CoreError("Core request deadline exceeded; do not retry an uncertain launch.", dispatched)),
        15_000,
      );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      socket.on("error", () => finish(new CoreError("Core socket operation failed.", dispatched)));
      socket.on("close", () => finish(new CoreError("Core connection closed before response.", dispatched)));
      socket.on("connect", () => {
        socket.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: helloId, method: "hello", params: { framed: false } })}\n`,
        );
      });
      socket.on("data", (chunk: Buffer) => {
        if (done) return;
        if (buffer.length + chunk.length > 2 * 1024 * 1024) {
          finish(new CoreError("Core response exceeds limit.", dispatched));
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        let newline = buffer.indexOf(10);
        while (newline >= 0 && !done) {
          const line = buffer.subarray(0, newline);
          buffer = buffer.subarray(newline + 1);
          try {
            const response: unknown = JSON.parse(line.toString("utf8"));
            if (!object(response) || response.jsonrpc !== "2.0") throw new Error("Malformed RPC response");
            if (response.id !== (core ? requestId : helloId)) throw new Error("Unexpected RPC response identity");
            if (response.error !== undefined) {
              const error = response.error;
              const kind =
                object(error) && object(error.data) && typeof error.data.kind === "string"
                  ? error.data.kind.slice(0, 100)
                  : "rpc_error";
              // Do not echo remote diagnostics: they can contain environment credentials.
              finish(new CoreError("Core rejected the operation.", dispatched, kind));
              return;
            }
            if (!core) {
              const hello = response.result;
              if (
                !object(hello) ||
                hello.version !== "0.1.21" ||
                !object(hello.core) ||
                typeof hello.core.id !== "string" ||
                !Array.isArray(hello.methods) ||
                !hello.methods.includes(method) ||
                hello.framed !== false
              )
                throw new Error("Unsupported Core protocol");
              if (this.expectedCore && hello.core.id !== this.expectedCore) throw new Error("Core identity changed");
              core = { id: hello.core.id, version: hello.version };
              // Mark uncertainty before writing: a failed write callback is not proof of non-dispatch.
              dispatched = true;
              socket.write(packet);
            } else {
              finish(undefined, response.result);
            }
          } catch {
            finish(new CoreError("Core protocol/identity validation failed.", dispatched));
          }
          newline = buffer.indexOf(10);
        }
      });
    });
  }
}

/** Construct from a trusted supervisor allocation, never model-provided argv/env/parent. */
export function launchParameters(input: {
  node: string;
  bootstrap: string;
  cwd: string;
  parent: string;
  root: string;
  job: string;
  attempt: string;
  controlSocket: string;
}): Record<string, unknown> {
  for (const path of [input.node, input.bootstrap, input.cwd, input.controlSocket])
    if (!isAbsolute(path)) throw new Error("Controlled child paths must be absolute.");
  return {
    argv: [input.node, input.bootstrap],
    cwd: input.cwd,
    parent: localAddress(input.parent),
    caller: localAddress(input.parent),
    no_notify: true,
    no_parent: false,
    outlive_parent: false,
    keep: false,
    rm: false,
    wait: false,
    labels: { "pi-herdr-core-root": input.root, "pi-herdr-core-job": input.job, "pi-herdr-core-attempt": input.attempt },
    env: { PI_HERDR_CONTROL_SOCKET: input.controlSocket },
  };
}

export function sameAllocation(expected: CoreTerminal, actual: CoreTerminal): boolean {
  return (
    actual.address === expected.address &&
    actual.created_ms === expected.created_ms &&
    actual.parent === expected.parent &&
    JSON.stringify(actual.argv) === JSON.stringify(expected.argv) &&
    ["pi-herdr-core-root", "pi-herdr-core-job", "pi-herdr-core-attempt"].every(
      (key) => !!expected.labels[key] && actual.labels[key] === expected.labels[key],
    )
  );
}

/** Preview/recheck predicate only. Caller must also confirm no live/uncertain descendants. */
export function removable(expected: CoreTerminal, actual: CoreTerminal): boolean {
  return sameAllocation(expected, actual) && actual.state === "finished" && !actual.keep && !actual.rm;
}
