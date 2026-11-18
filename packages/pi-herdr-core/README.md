# Pi Herdr Core subagents

An independently loadable Pi extension for **local Herdr Core 0.1.21**, targeting Pi 1.5.1. It does not require Plan mode. It does not support legacy Herdr, remote machines, worktrees, persistent specialists or resuming completed agents.

## Use

- `/subagent <query>` delegates the **entire argument** as a fresh task. No `launch` subcommand.
- `/subagent` or `/subagents` opens status, with parent IDs, state, model, task, terminal address and result/transcript references. Select a job to inspect references, steer, cancel its subtree, obtain `hc attach` instructions, or clean up.
- `/subagents cleanup` previews confirmed finished terminals. You may include earlier sessions, inspect their original parent identity, and select a terminal to remove. It retains job records, result files and Pi transcripts.

Five distinct model tools are registered: `subagent`, `subagent_query`, `subagent_wait`, `subagent_cancel`, and `subagent_steer`. Query/list/status never launches or mutates a job. Result queries and waits coordinate pending completion receipts. Noninteractive callers should explicitly wait for jobs before exiting; shutdown cancels owned execution. Steering is plain guidance, not slash-command execution, approval, permission expansion or an implicit resume.

Core must already be running, with a valid local `HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET`. There is no process fallback or Core autostart. Installation and loading do not allocate terminals, start child MCP connections, call providers or create job storage.

## Execution and restrictions

The supervisor starts an argv-launched Node/Pi SDK child in a Core terminal without attaching/focusing it. Each child uses its immediate parent's cwd, exact model/thinking setting, trusted project context and captured delegable tool ceiling. Parent conversation and approval records are not copied. The root supervisor binds private IPC connections to allocated job/attempt identities; children cannot supply another parent or control siblings/ancestors.

Active declarations and callable/deferred tools are captured separately. Selected native tools, ordinary file-backed sources and relevant trusted MCP definitions are reconstructed. Source/schema/exposure checks and an exact-name gate apply before task dispatch and every direct/nested call. Late registration cannot grant another tool. Unsupported inline SDK closures, non-reproducible schemas, missing sources and extension-only provider transports fail rather than falling back. Initialization must reproduce selected tools; source/config drift stops dispatch. File-backed tools must support fresh initialization: private session-local constraints are not cloned or inferred from annotations. This is **not an OS sandbox**; trusted extension code runs normally, and selected bash retains ordinary shell authority.

With Plan/Explain, the shared workflow contract intersects the exact allowed names, supplies behavioral guidance, and excludes parent-only workflow/artifact helpers. Exclusions appear in launch results. Permission/workflow replacement cancels affected execution; broadened parent permissions never upgrade existing children. A ready-plan review holds launching, steering and automatic continuation.

### Limits

Documented constants (no settings editor): two delegation levels below the root, four live processes across the tree, twelve accepted jobs per originating human-request group, and ten minutes / 40 provider turns / 160 tool calls per job. Capacity is rejected, not queued. Waiting, steering and completion synthesis do not reset budgets. Parents wait without spinning provider turns until descendants stop, then receive bounded results for synthesis.

### Results and lifecycle

Launch intent, allocation and acknowledgement are separate states. A lost dispatch response is uncertain and reconciled by the same attempt's labels, never retried as another launch. Only controlled Pi settlement and a result record establish success; Core idle/exit is not success. Cancellation distinguishes confirmed process stop from uncertainty; unconfirmed attempts retain their slot and cannot be cleaned up.

Successful navigation, reload/shutdown, user abort and workflow revocation invalidate delivery synchronously before cleanup. Proposed/cancelled navigation does not. Ordinary turns and compaction retain jobs. Supervisor disconnection makes the child abort and exit. Finished jobs never auto-resume. Records under the Pi agent directory (`pi-herdr-core/`) use atomic JSON writes and separate result/session files; interrupted historical jobs stay queryable without reacquiring execution authority.

One shared runtime dispatcher batches completions at committed turn boundaries. Subagents may request bounded idle follow-ups; artifacts remain passive. Blocking prompts, compaction, review and pending user input hold delivery. Explicit retrieval and notifications use stable IDs and committed transcript evidence, not merely proposed entries. No exactly-once guarantee or durable notification replay is claimed: reload/crash can lose an automatic notification without losing the recorded result.

Core `rm: false` retains finished evidence; `keep` is deliberately false because it can replace a lost program with a shell. Native parent notes are disabled. Terminal output is sanitized. Cleanup rechecks ownership, liveness, descendants and allocation identity before `terminal.rm`; cancellation, terminal removal and history deletion are distinct. Attachment is manual (`hc attach tN`), not a terminal layout/focus manager.

## Build and verification

From the workspace root: `bun run build`, then load `-e ./packages/pi-herdr-core`. Git installation's Node-only postinstall builds the child runtime without requiring Bun in the consumer environment. SDK resolution uses the installed host package, not a checkout-specific executable.

Use `bun run test packages/pi-herdr-core/test/`. The separate deterministic process check is:

```sh
node packages/pi-herdr-core/test/acceptance.mjs
```

It uses real Node children and a local deterministic HTTP provider behind **mocked Core**; it is not real-Core acceptance and does not incur provider charges. It is separate from the five-second Vitest budget. Real Core 0.1.21 parent/child visibility, focus behavior, termination/retention and cleanup require manual acceptance. Linux is the primary target; other platforms are not claimed validated.
