# pi-artifacts

An independently installable Pi extension for background, text-based artifact
creation and feedback. HTML prototypes are one use case; Markdown, SVG, CSS, and
other text artifacts work too. The parent keeps working while a separate Pi SDK
session generates files **in the same Node process**. No subprocess agent framework
is used. Node with `node:sqlite` support (the workspace uses Node 26) is required.

Load `src/index.ts` with `pi -e`, or install this package with Pi. Host Pi packages
are peer dependencies; no host runtime copies or credentials are bundled. The
workspace loads this extension alongside Plan mode. Merely installing it does not
expand Plan mode's selected permissions.

## Tools

- `artifact_create({ directory, task })`: claim a new or genuinely empty directory
  (hidden entries count), durably accept a job, and immediately return identifiers
  and queued status. Relative paths resolve against the caller's working directory.
  Never clears or adopts a populated directory. Overlapping claims are rejected.
- `artifact_update({ artifactId, task })`: append feedback to the saved artifact
  conversation. Keeps the same directory and filenames. A second update while
  queued/running is rejected. Missing/corrupt history fails, never becomes a new
  conversation.
- `artifact_status({ jobId })`: durable state, without provider requests or retries.
- `artifact_wait({ jobIds })`: await terminal results instead of polling. Only work
  owned by this live process can be awaited while running; other-process work must
  be awaited there. Terminal results can be read after reload.
- `artifact_cancel({ jobId })`: stop that job, including queued work. An old job ID
  cannot cancel a later feedback round. Partial files and history are retained.

The first result acknowledges accepted work, **not a finished artifact**. States
are `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `interrupted`.
Two jobs run concurrently per parent session. SQLite transactions serialize claims
and artifact ownership across processes. Ownership is not time-expiring: a live
local PID (or unknown remote host) is never stolen. Dead local owners reconcile to
`interrupted`; use an explicit update to incur further provider work. PID reuse is
conservatively treated as live. Remote-host leases require the original host or
manual administrative recovery; no timeout guesses ownership.

Jobs survive ordinary turns, settlement, and compaction. User abort, explicit
cancellation, branch navigation, session replacement, reload, and shutdown abort
children, drain mutation I/O, dispose sessions, and retain output/history. Work is
not a detached daemon: print/JSON callers must wait before finishing when they need
completed output. There is a ten-minute run limit, 40-turn limit, and 160-tool-call
limit. Each run incurs additional provider usage using the model and thinking level
captured at submission; transport/authentication delegates to the captured parent
registry. Parent messages and credentials are not copied to child history.

Terminal summaries are capped at 2,000 sanitized characters, with up to 20 paths
in model-facing text; structured details retain the bounded actual output listing
and provider usage. Usage is informational in durable details, not repeatedly
charged to parent totals by status/wait. Nonmodal progress uses the status area.
Extension-authored completion messages are supplied at safe turn boundaries,
without forcing a continuation, interrupting a question dialog, or fabricating a
user message. `artifact_wait` explicitly supplies dependency results and suppresses
its redundant notification.

## Persistence and enforced tool boundary

Claims, job manifests, ownership, and child JSONL conversations live under
`<getAgentDir()>/pi-artifacts/`, outside generated output. The database uses atomic
transactions and full synchronous durability; malformed state fails closed.
Canonical destinations and filesystem identities are recorded and rechecked.

Children have exactly `read`, `grep`, `find`, `ls`, `write`, and `edit`. Inspection
is not confined: this is **not a confidentiality boundary**. No shell, browser,
server, screenshot, dependency installation, or binary-generation integration is
provided. A resource loader with no discovery prevents extensions, MCP servers,
skills, templates, or generated `AGENTS.md`/configuration from executing or
becoming instructions on feedback. Native tool guidance remains intact.

Mutation tools preserve Pi's native schemas, matching, BOM/line-ending handling,
and diffs. The backend rejects escapes, symlink components, nonregular targets,
replaced roots, and observed edit conflicts. It stages complete files, syncs them,
and atomically replaces directory entries rather than writing through hard links.
A private temporary staging directory inside the output filesystem is denied to
child mutations and excluded from reported output. This supports destinations on
a different volume from agent storage; metadata/history never live there.
Previously published files remain on failure/cancellation, without rollback.

Limits: 2 MiB per file, 16 MiB total output, 1,024 filesystem entries, and 32 levels.
Paths come from an actual bounded inventory, not the child's summary.

This is an enforced tool boundary, **not an OS sandbox against hostile extensions
or external filesystem races**. Saving HTML does not certify that it is safe to
execute in a browser. Open generated HTML only after your own review.

## Plan mode

Select the **complete set** in `/plan tools`, or save it in `/plan settings`:
`artifact_create`, `artifact_update`, `artifact_status`, `artifact_wait`,
`artifact_cancel`. Default inspection tools remain unchanged. The parent does not
need ordinary `write`, `edit`, or `bash` to delegate child mutations.

Plan mode allocates a stable workspace before a plan has a title:
`<agentDir>/pi-plan-mode/<repo>/artifacts/<workspace-id>/`. Create a new/empty child
there. Launch once the user-facing brief is clear, continue technical planning,
and wait only at a real dependency or at the end. Both planning save tools refuse
pending jobs without publishing a revision or opening review. Failures require
retry or explicit user agreement via `/plan artifacts omit <jobId>`.

Review and implementation carry structured live references, not child transcripts
or HTML bodies. Historical revisions refer to **current files**, not immutable
visual snapshots. Continue an older plan to continue its live artifacts; create
another directory for an independent alternative.

Existing captured/replacement planning prompts are not silently relaxed. Start a
new workflow with the updated default or deliberately update your replacement
prompt's artifact exception and wait-at-the-end protocol.

## Versioned interoperability (no package dependency)

- Custom entry/event `pi-artifacts-reference-v1`: entry data is a reference; event
  data is `{ sessionId, reference }`. References have `{ version: 1, artifactId,
  jobId, directory, paths, status }`. Additional job metadata may appear; consumers
  validate the version and project only known fields. Claims are recorded before
  generation, as well as terminal results. Tool details are
  `{ version: 1, artifacts: [reference, ...] }`.
- Event `pi-artifacts-service-v1`: `{ version: 1, sessionId, action: "status" |
  "cancel", jobIds, respond }`. The receiver invokes `respond({ version: 1, jobs })`
  or `respond({ error })`; cancellation replies with `{ version: 1 }`. Status
  resolves each referenced artifact to its latest job, so an old plan cannot review
  over a running feedback round. Cancellation is scoped to listed jobs owned by
  this session. Callers must impose an unavailable-service timeout.
- `pi-artifacts-terminal-v1` custom messages identify delivered terminal job IDs.
  They never request an automatic model turn.

## Verification

From the repository root, run `process-compose run test-artifacts`; run other
check/test jobs sequentially. Tests use isolated temporary agent directories,
native tools, and offline fake providers. Manual real-provider/browser acceptance
is separate: generate early, continue planning, wait before review, revise twice,
reopen the saved plan in another session, and revise again.
