# 🧭 pi-plan-mode — Plan Before Pi Edits Code

[![npm](https://img.shields.io/npm/v/@narumitw/pi-plan-mode)](https://www.npmjs.com/package/@narumitw/pi-plan-mode) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Explore a codebase, resolve important questions, and review an implementation-ready plan before starting work. Completed plans are durable Markdown revisions, not a single session-local saved slot.

## Load this fork

This checkout contains an unreleased fork targeting current Pi APIs, tested against **Pi 1.5.0**. Older hosts, settings, and workflow states are not supported or migrated. The retained npm name and badge identify the upstream package; installing it does not install this checkout's implementation.

From the outer repository root, run the managed development job:

```bash
process-compose run dev
```

To load an already-built checkout from `pi-extensions/`:

```bash
./node_modules/.bin/pi --no-extensions -e ./packages/pi-plan-mode
```

Load only extensions you trust: they run with Pi's operating-system permissions. See the [workspace guide](../../README.md) for builds and validation. The package loads its generated `dist/index.ts` entrypoint; build an unbuilt checkout before loading the package directory.

## Quick start

1. Run `/plan <request>`, or `/plan start` and then describe the change.
2. Let the planner inspect the repository and ask structured questions about material decisions.
3. The planner calls `plan_mode_complete` with the complete Markdown plan. The result shows the plan and its saved path; **nothing starts automatically**.
4. Open `/plan` to review the full saved document, then choose an action. **Implement in fresh session** is always the first/default choice; **Implement here** is an explicit alternative.

Plans are decision briefs for an equally capable implementer who can inspect the repository but does not have the planning conversation. They preserve consequential choices, context, non-obvious changes, and meaningful verification—not exhaustive mechanical instructions.

## Commands

| Command | Purpose |
| --- | --- |
| `/plan` | Open the planning menu, or review the completed plan. |
| `/plan start` | Enter Plan mode without sending a model message. |
| `/plan <prompt>` | Start with a request, or send a follow-up to the active planner. |
| `/plan saved` | Browse the current project's saved series and revisions outside an active workflow. |
| `/plan tools` | Choose tools and start, or change the current workflow's tools while the agent is idle. |
| `/plan settings` | Set future-workflow tool defaults, reset strict defaults, or change the storage subdirectory. |
| `/plan finalize` | Ask the active planner to resolve a remaining material question or submit the complete plan. |
| `/plan save` | Leave a completed workflow with its already-saved revision available for later. |
| `/plan exit` | Leave Plan mode and restore the previous active tools; saved files remain. |

Commands require an idle agent with no queued messages. Menus, document review, and implementation selection require TUI or RPC. Print/JSON users can use the direct planning commands and resume in an interactive mode to review and implement.

There is no direct `implement` route, and no `show`, `export`, or `off` aliases. Implementation is selected only after document review. Exact subcommand arguments choose routes; other text is a planning request, so `/plan start a migration` is a prompt. See [command workflows](./docs/command-workflows.md).

## Saved plans and revisions

Default storage is outside the repository:

```text
<getAgentDir()>/pi-plan-mode/plans/<project-key>/
  improve-search-01.md
  improve-search-02.md
```

`getAgentDir()` is normally `~/.pi/agent`, or the configured Pi agent directory. Projects are scoped by the canonical Git root, falling back to the canonical working directory outside Git. The project key combines a readable name with a path hash, so equally named repositories do not share plans.

Every successful completion publishes a new numbered Markdown revision without overwriting an existing file—even when the planner resubmits an unchanged plan after clarification. A new workflow starts a new series; colliding titles are disambiguated. **Continue planning** keeps the selected series and writes its next revision, including when continuing from an older revision.

`/plan saved` groups this project's files by series and defaults to the latest revision while keeping older revisions selectable. There is no separate saved-plan index or session-local slot. Exiting or implementing does not delete saved files.

## Review and implementation

Document review shows the complete plan, its revision, and its path. Confirm review to open these actions:

- **Implement in fresh session** — always the first/default action, never remembered from a previous choice. Transfers the full reviewed plan, not planning messages, tool results, or summaries. The new session links to the source as its parent only if the source has a persisted session file.
- **Implement here** — explicitly keeps the current conversation and starts implementation with the reviewed plan after leaving Plan mode.
- **Save for later** — leaves Plan mode without starting a model turn. The revision is already on disk.
- **Continue planning** — resumes planning from the reviewed revision in the same series.

The handoff uses exactly the text reviewed, not a subsequent reread of the file. Fresh sessions load their ordinary project instructions and resources. Plan mode does not override model or thinking choices and does not reinject the plan into later requests; subsequent context is managed by Pi's normal history and compaction.

A successful handoff ends Plan mode in the source session; the saved revision remains available through `/plan saved`. Cancelling replacement restores the source workflow. If the destination exists but its first request fails, the extension attempts to leave the complete request in its editor for retry. Cancelling review or action selection does not start implementation.

## Tools and trust

The strict defaults are the **canonical built-in `read`, `grep`, `find`, and `ls` implementations**, plus `plan_mode_question` and `plan_mode_complete`. Same-name extension overrides are not trusted defaults. Plan mode temporarily activates the required direct tools and restores the previous active-tool selection when it ends.

Use `/plan tools` while idle to change a workflow's selection, including after planning has started. Use `/plan settings` for future-workflow defaults. The picker asks for confirmation before trusting nondefault tools.

**Explicitly selecting a tool trusts its implementation**, including shells, editing tools, MCP tools, and overrides. There is no shell parser or command-level read-only filter. A trusted tool can mutate files, execute code, or affect external systems, even though the planner is instructed not to do so. Tool annotations are not verified permissions. This is an agent workflow restriction, **not an OS sandbox or confidentiality boundary**.

Each host-mediated tool call, including a nested call, must have an allowed exact name. Selecting `codemode` or another orchestrator does not authorize its callees; select them separately. Registered `codemode`/`deferred` tools can be allowed without forcing direct activation. Direct and `model-only` selections are activated; Pi still prevents nested calls to `model-only` tools. Hidden and unknown tools are unavailable. The planning helpers must be registered and available too, and reject calls outside Plan mode.

## Structured questions

The rich questionnaire is retained: `plan_mode_question` asks one to three questions with meaningful choices, custom answers, and optional notes. A single question submits directly; multiple questions use tabs and a final Review page. In TUI, use Tab/Shift+Tab or left/right to move between questions, up/down to choose an option, Enter to confirm, and `n` to add or edit a note. Custom answer and note editors respect Pi's configured editor; Ctrl+C cancels the question.

RPC uses sequential selection/editor dialogs. If interactive questions are unavailable or cancelled, the planner should ask a concise plain-text question or state a low-risk assumption—not silently guess a material decision.

Completion requires a standalone `plan_mode_complete` call with a nonempty complete plan, at most 50,000 JavaScript characters. Prose announcements and legacy plan tags do not complete a workflow. `/plan finalize` is an explicit request, not an automatic retry loop.

## Settings and guidance

The optional settings file is `<getAgentDir()>/pi-plan-mode.json`:

```json
{
  "plansDirectory": "plans",
  "tools": ["read", "grep", "find", "ls"]
}
```

Omit `tools` for strict defaults; `[]` means planning helpers only. `plansDirectory` is a relative subdirectory beneath `<getAgentDir()>/pi-plan-mode`. There is no settings watcher: defaults are read for future workflows, while an active workflow retains its configuration unless you explicitly change its tools.

Optional `<getAgentDir()>/pi-plan-mode.md` supplies user-wide planning guidance, snapshotted when a workflow starts. See the [settings reference](./docs/settings.md) for storage rules, safe persistence, and guidance examples.

## License

MIT. See [`LICENSE`](./LICENSE).
