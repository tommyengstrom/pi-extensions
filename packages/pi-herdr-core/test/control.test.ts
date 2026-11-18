import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { connectControl, createControlEndpoint } from "../src/control.js";

describe("private job/attempt control channel", () => {
  it("authenticates one assigned attempt and supports bounded bidirectional control", async () => {
    const endpoint = await createControlEndpoint("job", "attempt");
    try {
      expect((await stat(dirname(endpoint.credentialFile))).mode & 0o077).toBe(0);
      expect((await stat(endpoint.credentialFile)).mode & 0o077).toBe(0);
      const connected = await connectControl(endpoint.credentialFile);
      const parent = await endpoint.connected;
      expect(connected.job).toBe("job");
      expect(connected.attempt).toBe("attempt");
      parent.onRequest((method, data) => ({ method, data }));
      connected.peer.onRequest((method) => ({ accepted: method === "cancel" }));
      await expect(connected.peer.request("query", { action: "list" })).resolves.toEqual({
        method: "query",
        data: { action: "list" },
      });
      await expect(parent.request("cancel", {})).resolves.toEqual({ accepted: true });
      await expect(parent.request("huge", { text: "x".repeat(300_000) })).rejects.toThrow(/capacity/);
      connected.peer.close();
    } finally {
      await endpoint.dispose();
    }
  });
  it("rejects a mismatched secret without granting task authority", async () => {
    const endpoint = await createControlEndpoint("job", "attempt");
    try {
      const credential = JSON.parse(await readFile(endpoint.credentialFile, "utf8"));
      credential.secret = "0".repeat(64);
      await writeFile(endpoint.credentialFile, JSON.stringify(credential), { mode: 0o600 });
      await expect(connectControl(endpoint.credentialFile)).rejects.toThrow(/authentication failed/);
    } finally {
      await endpoint.dispose();
    }
  });
  it("rejects pending requests and notifies ownership when the supervisor disconnects", async () => {
    const endpoint = await createControlEndpoint("job", "attempt");
    try {
      const connected = await connectControl(endpoint.credentialFile);
      const parent = await endpoint.connected;
      parent.onRequest(() => new Promise(() => {}));
      let lost = false;
      connected.peer.onClose(() => {
        lost = true;
      });
      const pending = connected.peer.request("wait", {});
      const rejected = expect(pending).rejects.toThrow(/connection lost/);
      parent.close();
      await rejected;
      expect(lost).toBe(true);
    } finally {
      await endpoint.dispose();
    }
  });
});
