import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const MAX_FRAME = 256 * 1024;
const MAX_PENDING = 32;
const DEADLINE = 15_000;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export type ControlHandler = (method: string, data: unknown) => unknown | Promise<unknown>;
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One authenticated job/attempt connection. No caller/parent identity is taken from request bodies. */
export class ControlPeer {
  private bytes = Buffer.alloc(0);
  private readonly pending = new Map<string, Pending>();
  private inbound = 0;
  private closed = false;
  private handler: ControlHandler = () => {
    throw new Error("Control peer is not ready.");
  };
  private readonly closeListeners = new Set<() => void>();
  private lastSeen = Date.now();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  constructor(private readonly socket: Socket) {
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSeen > DEADLINE) {
        this.close();
        return;
      }
      try {
        this.send({ version: 1, type: "ping" });
      } catch {
        this.close();
      }
    }, 3000);
  }
  onRequest(handler: ControlHandler): void {
    this.handler = handler;
  }
  onClose(listener: () => void): () => void {
    if (this.closed) listener();
    else this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  get alive(): boolean {
    return !this.closed;
  }
  private send(frame: unknown): void {
    if (this.closed) throw new Error("Control connection closed.");
    const packet = Buffer.from(`${JSON.stringify(frame)}\n`);
    if (packet.length > MAX_FRAME || this.socket.writableLength + packet.length > MAX_FRAME * 2)
      throw new Error("Control channel capacity exceeded.");
    this.socket.write(packet);
  }
  request(method: string, data: unknown, timeout = DEADLINE): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Control connection closed."));
    if (this.pending.size >= MAX_PENDING || !method || method.length > 64 || timeout < 1 || timeout > 600_000)
      return Promise.reject(new Error("Invalid or excessive control request."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Control response deadline exceeded; mutation outcome may be uncertain."));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ version: 1, type: "request", id, method, data });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private receive(chunk: Buffer): void {
    if (this.closed) return;
    if (this.bytes.length + chunk.length > MAX_FRAME * 2) {
      this.close();
      return;
    }
    this.bytes = Buffer.concat([this.bytes, chunk]);
    let at = this.bytes.indexOf(10);
    while (at >= 0 && !this.closed) {
      if (at > MAX_FRAME) {
        this.close();
        return;
      }
      const line = this.bytes.subarray(0, at);
      this.bytes = this.bytes.subarray(at + 1);
      try {
        this.frame(JSON.parse(line.toString("utf8")));
      } catch {
        this.close();
        return;
      }
      at = this.bytes.indexOf(10);
    }
    if (this.bytes.length > MAX_FRAME) this.close();
  }
  private frame(value: unknown): void {
    if (!record(value) || value.version !== 1) throw new Error("Invalid control frame.");
    this.lastSeen = Date.now();
    if (value.type === "ping") {
      this.send({ version: 1, type: "pong" });
      return;
    }
    if (value.type === "pong") return;
    if (typeof value.id !== "string" || value.id.length > 100) throw new Error("Invalid request identity.");
    if (value.type === "response") {
      const pending = this.pending.get(value.id);
      // Responses can arrive after a bounded caller timeout. They never re-dispatch work.
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.ok === true) pending.resolve(value.data);
      else
        pending.reject(
          new Error(typeof value.error === "string" ? value.error.slice(0, 1000) : "Control request failed."),
        );
      return;
    }
    if (
      value.type !== "request" ||
      typeof value.method !== "string" ||
      value.method.length > 64 ||
      ++this.inbound > MAX_PENDING
    )
      throw new Error("Invalid or excessive control request.");
    const id = value.id;
    void Promise.resolve()
      .then(() => this.handler(value.method as string, value.data))
      .then(
        (data) => {
          if (!this.closed) this.send({ version: 1, type: "response", id, ok: true, data });
        },
        () => {
          if (!this.closed)
            this.send({
              version: 1,
              type: "response",
              id,
              ok: false,
              error: "Controlled operation rejected. Inspect the job record for bounded diagnostics.",
            });
        },
      )
      .catch(() => this.close())
      .finally(() => {
        this.inbound--;
      });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.socket.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Supervisor/child control connection lost."));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) {
      try {
        listener();
      } catch {
        /* all owners must be notified */
      }
    }
    this.closeListeners.clear();
  }
}

export interface ControlEndpoint {
  credentialFile: string;
  socket: string;
  connected: Promise<ControlPeer>;
  dispose(): Promise<void>;
}

/** Secret is in a separate mode-0600 one-shot file, never argv, transcript or job records. */
export async function createControlEndpoint(job: string, attempt: string): Promise<ControlEndpoint> {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-core-control-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "control.sock");
  const credentialFile = join(directory, "credential.json");
  const secret = randomBytes(32).toString("hex");
  let peer: ControlPeer | undefined;
  let settled = false;
  let disposed = false;
  const sockets = new Set<Socket>();
  let accept!: (peer: ControlPeer) => void;
  let reject!: (error: Error) => void;
  const connected = new Promise<ControlPeer>((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  // Acquisition can fail before the caller awaits connected. Retain rejection without an unhandled rejection.
  void connected.catch(() => {});
  const server = createServer((socket) => {
    if (peer || sockets.size >= 4 || disposed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), 3000);
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      sockets.delete(socket);
    };
    socket.once("close", cleanup);
    socket.on("error", () => socket.destroy());
    const authenticate = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 2048) {
        socket.destroy();
        return;
      }
      const at = buffer.indexOf(10);
      if (at < 0) return;
      try {
        // Before authentication no application frames may be pipelined.
        if (at !== buffer.length - 1 || peer) throw new Error("Unexpected handshake framing.");
        const auth: unknown = JSON.parse(buffer.subarray(0, at).toString("utf8"));
        if (
          !record(auth) ||
          auth.version !== 1 ||
          auth.job !== job ||
          auth.attempt !== attempt ||
          typeof auth.secret !== "string" ||
          !/^[a-f0-9]{64}$/.test(auth.secret) ||
          !timingSafeEqual(Buffer.from(auth.secret), Buffer.from(secret))
        )
          throw new Error("Invalid credential.");
        socket.off("data", authenticate);
        cleanup();
        peer = new ControlPeer(socket);
        socket.write('{"version":1,"authenticated":true}\n');
        settled = true;
        accept(peer);
        void rm(credentialFile, { force: true }).catch(() => {});
        for (const other of sockets) other.destroy();
      } catch {
        socket.destroy();
      }
    };
    socket.on("data", authenticate);
  });
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (!settled) {
      settled = true;
      reject(new Error("Control endpoint disposed before authentication."));
    }
    peer?.close();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, fail) => {
      server.once("error", fail);
      server.listen(socketPath, resolve);
    });
    server.on("error", () => {
      void dispose();
    });
    await chmod(socketPath, 0o600);
    await writeFile(credentialFile, JSON.stringify({ version: 1, socket: socketPath, job, attempt, secret }), {
      mode: 0o600,
      flag: "wx",
    });
    return { socket: socketPath, credentialFile, connected, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function connectControl(
  credentialFile: string,
): Promise<{ peer: ControlPeer; job: string; attempt: string }> {
  if (!isAbsolute(credentialFile) || !process.getuid) throw new Error("Local private control credentials required.");
  const [file, directory] = await Promise.all([lstat(credentialFile), lstat(dirname(credentialFile))]);
  const uid = process.getuid();
  if (
    !file.isFile() ||
    file.uid !== uid ||
    file.mode & 0o077 ||
    !directory.isDirectory() ||
    directory.uid !== uid ||
    directory.mode & 0o077 ||
    file.size > 2048
  )
    throw new Error("Unsafe control credential permissions.");
  const value: unknown = JSON.parse(await readFile(credentialFile, "utf8"));
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.socket !== "string" ||
    dirname(value.socket) !== dirname(credentialFile) ||
    typeof value.job !== "string" ||
    typeof value.attempt !== "string" ||
    typeof value.secret !== "string"
  )
    throw new Error("Invalid control credential.");
  const { socket: path, job, attempt, secret } = value;
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let bytes = Buffer.alloc(0);
    let finished = false;
    const timer = setTimeout(() => fail(), 5000);
    const fail = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("Child control authentication failed."));
    };
    socket.once("error", fail);
    socket.once("close", fail);
    socket.once("connect", () => socket.write(`${JSON.stringify({ version: 1, job, attempt, secret })}\n`));
    const handshake = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 2048) {
        fail();
        return;
      }
      const at = bytes.indexOf(10);
      if (at < 0) return;
      try {
        const response: unknown = JSON.parse(bytes.subarray(0, at).toString("utf8"));
        if (!record(response) || response.version !== 1 || response.authenticated !== true)
          throw new Error("Unauthenticated");
        finished = true;
        clearTimeout(timer);
        socket.off("data", handshake);
        socket.off("error", fail);
        socket.off("close", fail);
        // Server must not send application work until the child asks for its assigned snapshot.
        if (bytes.length !== at + 1) {
          socket.destroy();
          reject(new Error("Unexpected handshake data."));
          return;
        }
        resolve({ peer: new ControlPeer(socket), job, attempt });
      } catch {
        fail();
      }
    };
    socket.on("data", handshake);
  });
}
