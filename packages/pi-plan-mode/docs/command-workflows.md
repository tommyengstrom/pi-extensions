# Plan command workflows

[Back to README](../README.md#commands)

## Start and choose tools

`/plan start` enters Plan mode without sending a model message. `/plan <prompt>` starts with a request or sends a follow-up to the active planner. Only an exact subcommand selects its route: `/plan start a migration` is a planning prompt. There is no startup flag.

`/plan tools` opens a searchable tool selector. If no workflow is active, applying the selection starts one. During planning or while a plan is ready, it changes that workflow's tools without requiring an exit/restart. Wait until the agent is idle before opening it. Cancelling leaves the current selection unchanged.

The required question/completion helpers are fixed, not optional picker rows. The strict defaults are canonical built-in `read`, `grep`, `find`, and `ls`. Nondefault selections require explicit trust confirmation because they can mutate files or external state. Unknown/hidden configured tools remain unavailable; the picker retains those names rather than silently dropping them. See [tool selection and trust](./settings.md#tool-selection-and-trust).

`/plan settings` edits future-workflow defaults, not the current selection. Its choices are default tools, reset to strict inspection tools, and the plans subdirectory.

## Complete, then review

The planner explores and resolves material questions before calling `plan_mode_complete` alone with the complete Markdown plan. Every successful completion saves a new immutable numbered revision. A revision request must produce a full replacement plan, not a delta, and include a reason explaining what changed and why; it does not overwrite the previous revision. Byte-identical clarification resubmissions need no reason. Revisions retain their explicit parent even when continued from an older revision.

The completion result displays the plan and saved path. The status becomes `plan ready · /plan`. It does **not** open a ready-action menu, send an implementation request, or automatically retry finalization.

Open `/plan` to review the full saved document, including its path and revision number. The TUI review supports searching. Confirm the review before the action menu appears; closing either screen does nothing to the saved plan.

The action menu always starts with **Implement in fresh session**, followed by **Implement here**, **Save for later**, and **Continue planning**. It never remembers a previous implementation destination as the next default. Implementation uses the exact reviewed text even if the file changes afterwards.

If the model stops without completing, `/plan finalize` explicitly asks it to resolve a remaining material question or call the completion tool. Ordinary prose and legacy `<proposed_plan>` blocks are not completion signals.

## Implement fresh or here

**Implement in fresh session** transfers the full reviewed plan in an ordinary implementation prompt. It does not copy the planning branch, questions, tool results, compaction summaries, or other planning conversation. A persisted source session becomes the destination's parent; an in-memory source produces an unlinked destination.

The new session loads normal Pi/project resources. Its setup receives only plain tracking data and the reviewed plan, never source conversation. It retains an exact baseline, revision ancestry, and implementation-phase transcript boundaries. There is no destination-model selector or main-session thinking override. A stable implementation prompt section preserves the update/completion protocol and durable plan reference across compaction without reinjecting the full plan.

A successful handoff ends Plan mode in the source session, while the revision remains available through `/plan saved` for another review or handoff. Cancelling session replacement restores the source workflow. If replacement succeeds but kickoff fails, the extension attempts to place the complete implementation request in the new editor; submit it there or reopen the saved revision.

**Implement here** must be selected explicitly after review. It leaves Plan mode, restores the previous active tools, and sends the reviewed plan in the current session. Its existing conversation remains available, so use fresh implementation when you want isolation from planning context.

There is no `/plan implement` shortcut around document review.

## Track, complete, and verify implementation

The agent uses `plan_mode_update` with a complete revised plan and a reason **before** implementing user-requested changes; no second approval dialog is needed. Persistent instructions enforce this protocol conversationally, not through a hard tool-call gate. Agent-discovered material scope changes still require user agreement.

`plan_mode_implementation_complete` must be called alone. It closes implementation tracking and runs a fresh adherence check automatically unless disabled in settings. Ordinary prose and agent pauses do not trigger checks. Findings are reported directly, without automatic fixes or another main-agent response.

Use `/plan verify` for another check of this session's recorded implementation. Use `/plan resume` **before sending further fixes or plan changes** after completion or exit: it opens a new tracked segment without including intervening unrelated conversation. `/plan cancel` cancels a check even while its command is open. See [adherence checks](./adherence-checks.md) for evidence scope and limitations.

## Save, browse, and continue

`/plan save` requires a completed plan. It leaves Plan mode without starting implementation; it is not the initial disk save, since completion already wrote the revision. **Save for later** in review has the same purpose.

From outside an active workflow, run `/plan saved`. The browser reads the current project's configured storage directory, groups files by plan series, and offers each series' latest or older revisions. Selecting one opens document review before any implementation action.

**Continue planning** sends the reviewed revision back to the planner and keeps its series. Continuing from revision 01 when revision 03 already exists produces revision 04 on the next completion, not a replacement for 02. New independent workflows start new series; matching titles do not overwrite or merge an existing series.

There is no single saved-plan slot, export step, or separate index to maintain. Revisions live at:

```text
<agent-dir>/pi-plan-mode/<plansDirectory>/<project-key>/<title>-01.md
```

Title collisions are disambiguated; later completions use `-02.md`, `-03.md`, and so on. The [settings reference](./settings.md#storage-subdirectory) explains project scoping and storage changes.

`/plan exit` leaves Plan mode and restores the previous active tools without deleting saved revisions. During implementation it detaches tracking and closes the transcript segment; its record remains available to `/plan verify`. To browse while planning, exit the current workflow first. Exit does not create a revision for an unfinished draft.

## Busy state and non-interactive use

All `/plan` command routes except `/plan cancel` require an idle agent and no pending messages, including prompts, finalization, tool changes, save, exit, resume, and manual verification. Wait for the run to settle before retrying a rejected command. Do not confuse this with automatic implementation: a completed planning run remains ready until you choose an action.

Menus, saved browsing, review, and implementation selection require TUI or RPC. Print and JSON modes can use `/plan start`, `/plan <prompt>`, `/plan finalize`, `/plan save`, and `/plan exit` when their state requirements are met. Structured questions without interactive UI fall back to concise plain-text questions or explicitly stated low-risk assumptions. Resume in TUI or RPC to review a saved plan and select implementation.

Tracked `/plan verify` and `/plan resume` also work in print/JSON mode without a selection dialog; automatic completion checks return their report as the terminating tool result. Model/authentication failures and cancellation never count as successful verification.

The supported subcommands are `start`, `saved`, `tools`, `settings`, `finalize`, `save`, `exit`, `verify`, `resume`, and `cancel`. Removed `show`, `export`, `off`, and `implement` words are not aliases; other arguments are planning prompts. There are no legacy workflow or settings migrations.
