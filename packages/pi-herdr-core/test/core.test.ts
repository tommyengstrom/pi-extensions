import { describe, expect, it } from "vitest";
import { CoreClient, type CoreTerminal, localAddress, parseTerminal } from "../src/core.js";

const terminal: CoreTerminal = {
  address: "t3",
  parent: "t1",
  state: "finished",
  created_ms: 1000,
  exit_code: 0,
  argv: ["/usr/bin/node", "/package/child.js"],
  keep: false,
  rm: false,
  notify: false,
  labels: { "pi-herdr-core-root": "root", "pi-herdr-core-job": "job", "pi-herdr-core-attempt": "attempt" },
};
describe("Core protocol construction and cleanup predicates", () => {
  it("requires local identities and socket paths", () => {
    expect(() => new CoreClient("relative.sock")).toThrow();
    for (const address of ["remote/t1", "name", "t0", "t1\n", "t-1"]) expect(() => localAddress(address)).toThrow();
    expect(localAddress("t12")).toBe("t12");
    expect(localAddress("t1b")).toBe("t1b");
    expect(() => localAddress("t1a")).toThrow();
  });
  it("parses terminal facts without treating them as task success", () => {
    expect(parseTerminal(terminal)).toEqual(terminal);
    expect(() => parseTerminal({ ...terminal, state: "idle" })).toThrow();
    expect(() => parseTerminal({ ...terminal, labels: { attempt: 4 } })).toThrow();
  });
});
