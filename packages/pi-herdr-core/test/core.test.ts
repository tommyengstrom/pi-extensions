import { describe, expect, it } from "vitest";
import {
  CoreClient,
  type CoreTerminal,
  launchParameters,
  localAddress,
  parseTerminal,
  removable,
} from "../src/core.js";

const terminal: CoreTerminal = {
  address: "t3",
  parent: "t1",
  state: "finished",
  created_ms: 1000,
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
  });
  it("uses argv, native parent and no notes, shell retention or automatic removal", () => {
    const params = launchParameters({
      node: "/usr/bin/node",
      bootstrap: "/package/child.js",
      cwd: "/project",
      parent: "t1",
      root: "root",
      job: "job",
      attempt: "attempt",
      controlSocket: "/private/control.sock",
    });
    expect(params.argv).toEqual(["/usr/bin/node", "/package/child.js"]);
    expect(params).toMatchObject({
      parent: "t1",
      no_notify: true,
      keep: false,
      rm: false,
      outlive_parent: false,
      wait: false,
    });
    expect(params).not.toHaveProperty("line");
    expect(params).not.toHaveProperty("on");
  });
  it("parses terminal facts without treating them as task success", () => {
    expect(parseTerminal(terminal)).toEqual(terminal);
    expect(() => parseTerminal({ ...terminal, state: "idle" })).toThrow();
    expect(() => parseTerminal({ ...terminal, labels: { attempt: 4 } })).toThrow();
  });
  it("rejects live, repurposed, restored-shell and unknown-ownership cleanup", () => {
    expect(removable(terminal, terminal)).toBe(true);
    expect(removable(terminal, { ...terminal, state: "live" })).toBe(false);
    expect(removable(terminal, { ...terminal, keep: true })).toBe(false);
    expect(removable(terminal, { ...terminal, created_ms: 1001 })).toBe(false);
    expect(removable(terminal, { ...terminal, argv: ["/bin/sh"] })).toBe(false);
    expect(removable(terminal, { ...terminal, labels: {} })).toBe(false);
  });
});
