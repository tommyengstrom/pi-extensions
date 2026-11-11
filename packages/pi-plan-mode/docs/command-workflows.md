# Plan command workflows

[Back to README](../README.md#commands)

## Start and choose tools

`/plan start` enters Plan mode without sending a model message. `/plan <prompt>` starts with a request or sends a follow-up to the active planner. Only an exact subcommand selects its route: `/plan start a migration` is a planning prompt. There is no startup flag. New planning is independent; it does not silently resume a detached/completed implementation record.

`/plan tools` opens a searchable tool selector. In normal mode, applying it configures future planning without starting a workflow or changing active tools. During planning or while a plan is ready, it changes that workflow's tools without requiring an exit/restart. During implementation it may change only the isolated checker selection, never the main agent's tools. Wait until the agent is idle before opening it. Cancelling leaves the selection unchanged.

The required question/completion/edit helpers are fixed, not optional picker rows. The strict defaults are canonical built-in `read`, `grep`, `find`, and `ls`. Nondefault selections require explicit trust confirmation because they can mutate files or external state. Unknown/hidden configured tools remain unavailable; the picker retains those names rather than silently dropping them. The planning allowlist applies only in planning. Preexisting tool availability is restored when planning ends, before implementation helpers are enabled. The checker applies its own read-only policy in isolation, without changing parent tools. See [tool selection and trust](./settings.md#tool-selection-and-trust).

`/plan settings` edits future-workflow defaults, not the current planning selection. Its choices include default tools, reset to strict inspection tools, automatic adherence checks, the checker model, independent progress model/reasoning (including defaults/reset), **Naming model**, and editing the planning prompt. Naming does not change the configured storage location.

## Name early, save later

Once task text is available, a separate early naming request receives only that text, capped at **4,000 characters**. It has no tools, context files, repository inspection, conversation history, or plan body. It is limited to **128 output tokens** and a **10-second timeout**. The result becomes a lowercase kebab-case stem of at most **64 characters**; timeout, failure, or unusable output uses a deterministic fallback. Numeric suffixes disambiguate collisions with independent plans.

The default naming model is the configured progress model (`openai/gpt-6-luna` by default). An independent `settings.naming.model` override is available through **Naming model**. Naming uses the lowest reasoning level supported by its model, not the progress reasoning preference. This is an extra provider request and discloses the bounded task text to the naming provider. No plan file is created merely by naming or entering planning; the first save creates it.

## Complete, then review

The planner explores and resolves material questions before calling `plan_mode_complete` alone with the complete Markdown plan. Use it for initial plans and broad replacements, never a delta. The plan must be nonempty and at most 50,000 JavaScript characters. The initial save creates one named Markdown file; later saves replace that same file atomically. There are no date prefixes, numbered revisions, parent ancestry, change reasons, or revision selectors.

For localized changes to the current plan, use `plan_mode_edit` with exactly Pi's edit input:

```json
{
  "path": "/absolute/path/to/support-uploading-images.md",
  "edits": [{ "oldText": "Use a 30-second timeout.", "newText": "Use a 60-second timeout." }]
}
```

Each `oldText` must uniquely match a non-overlapping region of the current plan. Arbitrary files and other saved plans are not edit targets. The file is updated at the same path; the result shows the diff and that path, not the full plan. Do not echo the full plan. Hash-based stale-read conflicts block updates before newer on-disk contents can be overwritten; reread and reconcile before retrying. In planning, call `plan_mode_edit` directly and alone as the final action, with no assistant response afterwards: success marks the plan ready and terminates the turn. Both planning save helpers reject nested or batched calls so Pi can honor termination.

Associated background artifacts must finish before either planning save can publish or schedule review. Failed/cancelled/interrupted work needs retry or explicit user agreement with `/plan artifacts omit <jobId>`; partial output is not a successful artifact. Implementation plan updates are not gated on artifact readiness. Artifact references remain live files, not historical snapshots.

The completion result displays the plan and saved path; the edit result displays only the diff and same path. Either save makes the plan ready, while the footer stays `[Planning stem]`. In TUI or RPC, review opens automatically after the agent fully settles. It does **not** start implementation or automatically retry finalization.

Review shows the full saved document, including its name, path, and artifact references, together with all four actions immediately below the plan viewport. There is no intermediate confirmation or separate action menu. Configured Up/Down keys select actions; Page Up/Page Down and Home/End scroll the plan, as does the mouse wheel over the document. Space opens search; search input/navigation takes precedence until search is closed. The configured confirmation key explicitly executes the selected action, never merely opening review. Closing the screen leaves the plan ready and does not authorize implementation. Small terminals compact metadata and hints first, then keep the selected action reachable. RPC includes all four actions with the first document page, pagination, and Close; paging never implements. Open `/plan` to reopen review or if automatic presentation was interrupted. Aborted runs, superseding work, and session replacement cancel pending automatic presentation. Restoring a ready supported session or navigating its history does not reopen old reviews automatically.

The combined review always starts with **Implement in fresh session** selected, followed by **Implement here**, **Save for later**, and **Continue planning**. It never remembers a previous implementation destination as the next default. Initial implementation uses the exact reviewed text even if the file changes afterwards; updates must still detect stale-read conflicts, and verification uses a fresh disk snapshot, not that reviewed text.

If the model stops without completing, request further planning through normal conversation. Ordinary prose and legacy `<proposed_plan>` blocks are not completion signals.

## Implement fresh or here

**Implement in fresh session** transfers the full reviewed plan in an ordinary implementation prompt. It does not copy the planning branch, questions, tool results, compaction summaries, or other planning conversation. A persisted source session becomes the destination's parent; an in-memory source produces an unlinked destination. This is session linkage, not plan ancestry.

The new session loads normal Pi/project resources. Its setup receives only plain tracking data and the reviewed plan, never source conversation. It retains the durable plan path and branch-aware implementation-phase transcript boundaries, not an immutable approved baseline or revision chain. There is no destination-model selector or main-session thinking override. A stable implementation prompt section preserves the update/completion protocol and durable plan reference across compaction without reinjecting the full plan. Status/recovery reads current contents from disk.

A successful handoff ends Plan mode in the source session, while the plan remains available through `/plan saved` for another review or handoff. Cancelling session replacement restores the source workflow. If replacement succeeds but kickoff fails, the extension attempts to place the complete implementation request in the new editor; submit it there or reopen the saved plan.

**Implement here** must be selected explicitly after review. It leaves Plan mode, restores preexisting tool availability before enabling implementation helpers, and sends the reviewed plan in the current session. Its existing conversation remains available, so use fresh implementation when you want isolation from planning context. Neither destination inherits planning's allowlist as an implementation restriction.

`/plan implement` opens this review directly for the active workflow's saved document, including after a planning follow-up, or the retained implementation record when planning is inactive. It never selects an unrelated recent plan. It reads current disk contents without rewriting or asking the model to regenerate the plan. Only an explicit implementation choice sends a kickoff containing that reviewed text; changes while review is open require another review. With no current document, create a plan or choose one through `/plan saved`.

This is initial implementation/handoff, not `/plan resume`: resume only reactivates tracking without a model request. `/plan open` edits without activating implementation. External-editor support and stronger synchronization before subsequent AI planning revisions remain separate follow-up work; this command does not protect against every later AI rewrite.

## Track, complete, and verify implementation

The agent saves user-requested plan changes **before** implementing them: use `plan_mode_edit` for localized edits or `plan_mode_update` with a complete plan for broad replacements. Both update the same named file, without reasons, revision files, or approved-ancestry enforcement. Implementation edits do not end the turn or open another approval dialog: continue work at the same path. Persistent instructions enforce this protocol conversationally, not through a hard tool-call gate. Agent-discovered material scope changes still require user agreement; saving an update is not authorization.

`plan_mode_implementation_status` reads the authoritative current plan from disk, including after compaction or recovery. Updates compare the expected read hash with disk before writing; a stale-read conflict requires a fresh read and reconciliation, not an overwrite. A missing plan file is an explicit error, not permission to recreate it from a cached baseline.

Question/completion helpers are active only in planning; edit is active in planning and tracked implementation; update/status/implementation-completion helpers are active only during tracked implementation. Helpers are inactive outside their applicable workflow and never exposed to the adherence checker.

`plan_mode_implementation_complete` must be called alone. It closes implementation tracking and runs a fresh adherence check automatically unless disabled in settings. Ordinary prose and agent pauses do not trigger checks. Findings are reported directly, without automatic fixes or another main-agent response.

At check start, the checker reads and snapshots the current plan file as its **sole plan target**. Missing files fail explicitly. Later plan edits are not covered by the result; run another check for those contents. There is no approved baseline or ancestry comparison.

Verification captures its identity and branch-scoped transcript, then durably marks tracking completed before any asynchronous work. This removes implementation-only helpers without changing ordinary parent tools or applying the planning allowlist. The checker still shows `[Verifying stem]`; completed tracking is not a passing adherence report. Reload/tree restoration of that boundary yields `[Normal]`. Navigation to another branch instead restores that branch's own workflow, without writes from the abandoned checker.

**Every verification exit returns to actual normal mode**: success, execution failure, cancellation, and invalidation all leave a detached/completed implementation record, not active implementation with a normal-looking footer. Use `/plan verify` explicitly for another check of that record. Use `/plan resume` **before sending further fixes or plan changes**: it opens a new tracked segment without including intervening unrelated conversation and does not itself send a model request. Starting new planning creates an independent workflow. Cancel interactive manual checks through their existing dialog. See [adherence checks](./adherence-checks.md) for evidence scope and limitations.

## Open and edit the current plan

`/plan open` opens the current saved plan body in your external editor in TUI (`$VISUAL`, `$EDITOR`, or `vi` by default) or Pi's editable text dialog in RPC. It works while planning, during implementation, and with a retained completed/detached implementation record. Save/submit to update the same file atomically; cancel or exit non-zero to leave it unchanged. The document identity, name, path, and artifact metadata are preserved. Empty/invalid text and concurrent file changes are rejected rather than overwriting the file. Navigation or session replacement invalidates the editor's pending save.

Opening a plan requires an idle agent and no other Plan command open. It does not create an initial plan, send a model request, authorize implementation, or resume completed tracking. Editing an implementation record clears its prior check/completion markers but preserves its phase; use `/plan resume` explicitly to continue implementation.

Bare `/plan` also reopens review whenever the active planning workflow has a saved document, including after a planning follow-up. Review reads current disk contents and refreshes the expected hash, so external edits can be reconciled without leaving the workflow. You can instead use `/plan open` to edit those current contents yourself. If editing directly on disk, preserve the metadata envelope.

## Mode footer and reported progress

The exact coordinated footer labels are `[Normal]`, `[Planning]`, `[Planning stem]`, `[Implementing stem]`, and `[Verifying stem]`. `stem` is the filename without `.md`, including any collision suffix; `[Planning]` is used before naming. Ready-for-review remains planning. Every verification exit shows `[Normal]` and leaves actual normal mode. The footer contains no command hints, progress text, or verification results. The active planning prompt banner is **PLAN MODE ACTIVE**.

`/plan progress` toggles the separate inline panel above the editor during tracked implementation, even while the agent is running, messages are queued, or another Plan command is open. It does not acquire the shared command gate; other commands retain their idle restrictions. The idle menu offers **Show plan progress**. Opening without active tracking explains how to implement a reviewed plan or `/plan resume`. Verification closes the panel at start and `/plan progress` cannot reopen it during checking or afterward until explicit `/plan resume`. TUI and RPC are supported; print/JSON refuse.

Observation runs only while enabled. Each changed-evidence or changed-plan assessment costs a separate provider request, with a 30-second minimum between starts and only one child at a time. Summaries are bounded, transcript-only reported progress, not independent verification. Close to cancel immediately; errors stop retries until close/reopen. Completion retains a stopped label and last summary, while session/branch changes, exit, reload and shutdown clear it. Resuming never reopens it. See [live reported progress](../README.md#live-reported-progress) for privacy and evidence boundaries, and [settings](./settings.md) for model defaults and availability.

## Save, browse, and continue

Plans are already persisted. **Save for later** in review leaves Plan mode without starting implementation and preserves the saved file; `/plan exit` also preserves saved plans.

From outside an active workflow, run `/plan saved`. The browser lists current-format named plans at the configured storage location, without series grouping or older-revision selectors. Selecting one opens document review before any implementation action. Legacy revision files are excluded.

**Continue planning** sends the reviewed plan back to the planner and keeps its file path. New independent workflows get independent files; matching names use numeric collision suffixes, never overwrite or merge an existing plan. There is no single saved-plan slot, export step, or separate index to maintain. For example:

```text
<configured-plan-directory>/support-uploading-images.md
<configured-plan-directory>/support-uploading-images-2.md
```

These are two independent plans, not revisions. Naming leaves storage configuration and captured current-format workflow paths unchanged. The repo-name default still shares plans among same-named checkouts. The [settings reference](./settings.md#plan-storage-and-legacy-locations) explains storage boundaries.

Workflows and document envelopes are version 3. Legacy workflow state is rejected without file modification; it is not resumed, imported, or silently migrated. To reuse old content, start fresh with `/plan start` and paste the Markdown body text into the planning conversation, without its legacy envelope.

`/plan exit` leaves Plan mode and restores preexisting tool availability without deleting saved plans. During implementation it detaches tracking and closes the transcript segment; its record remains available to explicit `/plan verify` or `/plan resume`. To browse while planning, exit the current workflow first. Exit does not save an unfinished draft.

**Alt+M** enters like `/plan start` or leaves planning directly when idle with no queued messages or open Plan command. It preserves the editor draft and files, does not open review or send a model message, and never starts implementation. See the [keyboard toggle](../README.md#keyboard-toggle) for rebinding, reload requirements, and reserved-key limitations.

## Busy state and non-interactive use

All active `/plan` command routes except `/plan progress` require an idle agent and no pending messages, including prompts, implementation review, tool changes, exit, resume, and manual verification. Wait for the run to settle before retrying a rejected command. Do not confuse this with automatic implementation: a completed planning run remains ready until you choose an action.

Menus, saved browsing, review, and implementation selection require TUI or RPC. Print and JSON modes can use `/plan start`, `/plan <prompt>`, and `/plan exit` when their state requirements are met. Structured questions without interactive UI fall back to concise plain-text questions or explicitly stated low-risk assumptions. Resume in TUI or RPC to review a saved plan and select implementation.

Tracked `/plan verify` and `/plan resume` also work in print/JSON mode without a selection dialog; automatic completion checks return their report as the terminating tool result. Model/authentication failures and cancellation never count as successful verification. All check outcomes return to normal mode.

The supported public routes are `start`, `saved`, `open`, `implement`, `tools`, `settings`, `progress`, `exit`, `verify`, `resume`, and `artifacts omit <jobId>`. Removed exact commands `finalize`, `save`, `prompt`, `cancel`, and `import` (including `import <path>`) return migration guidance, case-insensitively, even while another command is open. Ordinary multiword requests such as `/plan save bandwidth` remain planning prompts. `show`, `export`, and `off` are not aliases; other arguments are planning prompts. Reserved `__review` control arguments are internal one-shot dispatches, not planning prompts or public implementation shortcuts.
