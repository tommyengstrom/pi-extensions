import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "vitest";
import {
  createImplementation,
  IMPLEMENTATION_ENTRY,
  INPUT_ENTRY,
  restoreImplementation,
  VERIFICATION_MESSAGE,
} from "../src/implementation-state.js";
import { implementationTranscript, writeTranscriptArtifact } from "../src/implementation-transcript.js";
import { planHash } from "../src/plan-store.js";
import { planDocument } from "./support.js";

const phase = (id: string, value: string, implementation = "impl") => ({
  id,
  type: "custom",
  customType: IMPLEMENTATION_ENTRY,
  data: { id: implementation, phase: value },
});
const message = (id: string, role: string, content: unknown) => ({
  id,
  type: "message",
  timestamp: "2026-01-01",
  message: { role, content },
});
const provenance = (text: string, source: string) => ({
  type: "custom",
  customType: INPUT_ENTRY,
  data: { implementationId: "impl", source, fingerprint: planHash(text) },
});

test("scopes transcript to explicit implementation segments and includes all delivered user input", () => {
  const entries = [
    message("planning", "user", "PRIVATE PLANNING"),
    phase("start", "implementing"),
    provenance("Kickoff", "extension"),
    message("kick", "user", "Kickoff"),
    provenance("Change to blue", "interactive"),
    message("user1", "user", "Change to blue"),
    message("reason", "assistant", [
      { type: "text", text: "I changed it because blue matches the request." },
      { type: "thinking", thinking: "Recorded rationale." },
    ]),
    { type: "compaction", summary: "MISLEADING SUMMARY", firstKeptEntryId: "reason" },
    provenance("Actually keep red", "rpc"),
    message("user2", "user", "Actually keep red"),
    phase("done", "completed"),
    message("unrelated", "user", "PRIVATE UNRELATED"),
    phase("resume", "implementing"),
    message("fix", "user", "Fix the remaining requirement"),
    { id: "old-report", type: "custom_message", customType: VERIFICATION_MESSAGE, content: "PRIOR VERDICT" },
    phase("exit", "detached"),
    message("after", "user", "PRIVATE AFTER EXIT"),
    phase("different", "implementing", "other"),
    message("other-user", "user", "PRIVATE OTHER IMPLEMENTATION"),
  ];
  const result = implementationTranscript(entries, "impl");
  for (const omitted of ["PRIVATE", "MISLEADING SUMMARY", "PRIOR VERDICT"])
    assert.equal(result.document.includes(omitted), false);
  for (const included of [
    "Change to blue",
    "Actually keep red",
    "Recorded rationale.",
    "Fix the remaining requirement",
  ])
    assert.ok(result.document.includes(included));
  assert.match(result.document, /\[kick\].*\(extension\)/);
  assert.equal(result.users.includes("Kickoff"), false);
  assert.match(result.users, /\[user1\].*\(interactive\)/);
  assert.match(result.users, /\[user2\].*\(rpc\)/);
  assert.match(result.users, /\[fix\].*unknown provenance/);
  assert.equal(result.users.includes("Recorded rationale"), false);
  assert.equal(result.endpoint, "fix");
  for (const line of result.index.split("\n")) {
    const number = Number(/line (\d+)$/.exec(line)?.[1]);
    const id = /^\[([^\]]+)\]/.exec(line)?.[1];
    assert.ok(result.document.split("\n")[number - 1].includes(`[${id}]`));
  }
});

test("context edits never resurrect omitted text, attachment gaps and missing starts are explicit", () => {
  const result = implementationTranscript(
    [
      phase("start", "implementing"),
      message("secret", "user", "REMOVED SECRET"),
      message("replace", "assistant", "REMOVED ORIGINAL"),
      message("attachment", "user", [{ type: "image", data: "PRIVATE IMAGE", mimeType: "image/png" }]),
      { type: "context_edit", targetId: "secret", replacement: null },
      { type: "context_edit", targetId: "replace", replacement: "Edited content" },
    ],
    "impl",
  );
  assert.equal(result.document.includes("REMOVED"), false);
  assert.equal(result.document.includes("PRIVATE IMAGE"), false);
  assert.ok(result.document.includes("Edited content"));
  assert.equal(result.limitations.length, 3);
  assert.match(implementationTranscript([], "missing").limitations[0], /start marker/);
});

test("transcript artifacts are private, complete, and disposable", async () => {
  const transcript = implementationTranscript(
    [phase("start", "implementing"), message("large", "assistant", "large\n".repeat(20_000))],
    "impl",
  );
  const artifact = await writeTranscriptArtifact(transcript, new AbortController().signal);
  assert.equal(await readFile(artifact.path, "utf8"), transcript.document);
  assert.equal((await stat(artifact.directory)).mode & 0o077, 0);
  assert.equal((await stat(artifact.path)).mode & 0o077, 0);
  await artifact.dispose();
  await assert.rejects(stat(artifact.path), /ENOENT/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(writeTranscriptArtifact(transcript, aborted.signal), /abort/i);
});

test("v3 implementation entries retain only a document locator and hash, not approved-plan copies", () => {
  const document = planDocument();
  const plan = "# Current target\n\nImplement blue.";
  const state = createImplementation(
    { projectRoot: "/project", storage: { kind: "repo" }, previousTools: ["read", "write"], toolIdentities: [] },
    document,
    plan,
  );
  assert.equal(state.version, 3);
  assert.equal(state.phase, "implementing");
  assert.deepEqual(state.document, document);
  assert.equal(state.hash, planHash(plan));
  assert.equal("revisions" in state, false);
  assert.equal("plan" in state, false);
  const entry = { type: "custom", customType: IMPLEMENTATION_ENTRY, data: state };
  assert.deepEqual(restoreImplementation([entry]), state);
  assert.equal(JSON.stringify(entry).includes(plan), false);
  for (const invalid of [{ version: 1 }, { document: undefined }, { hash: "bad" }])
    assert.throws(() => restoreImplementation([{ ...entry, data: { ...state, ...invalid } }]), /Invalid|Legacy/);
});
