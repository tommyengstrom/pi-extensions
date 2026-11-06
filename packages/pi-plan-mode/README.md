# 🧭 pi-plan-mode — Plan Before Pi Edits Code

[![npm](https://img.shields.io/npm/v/@narumitw/pi-plan-mode)](https://www.npmjs.com/package/@narumitw/pi-plan-mode) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Explore a codebase, resolve important questions, and review an implementation-ready plan before starting work. Completed plans are durable Markdown revisions, not a single session-local saved slot.

## Load this fork

This checkout contains an unreleased fork targeting current Pi APIs, tested against **Pi 1.5.0**. Older hosts are not supported. This fork retains compatibility with its previous path-hashed plan storage and captured workflow locations without moving files. The retained npm name and badge identify the upstream package; installing it does not install this checkout's implementation.

Install this fork together with thinking shortcuts using `pi install git:github.com/tommyengstrom/pi-extensions`, then restart or `/reload`. Git installation builds the runtime automatically with Node and npm; Bun and manual preparation are not consumer requirements. See the [workspace installation guide](../../README.md#install-from-github) for updates and pinning.

For local development, from the repository root run the managed job:

```bash
process-compose run dev
```

To load an already-built checkout from the repository root:

```bash
./node_modules/.bin/pi --no-extensions -e ./packages/pi-plan-mode
```

Load only extensions you trust: they run with Pi's operating-system permissions. See the [workspace guide](../../README.md) for builds and validation. The package directory loads its generated `dist/index.ts` entrypoint; build an unbuilt local development checkout before loading that directory. The Git package's root manifest loads both source entrypoints and automatically prepares their runtime dependencies.

## Quick start

1. Run `/plan <request>`, or `/plan start` and then describe the change.
2. Let the planner inspect the repository and ask structured questions about material decisions.
3. The planner calls `plan_mode_complete` with the complete Markdown plan. The result shows the plan and its saved path, then **review opens automatically** in TUI or RPC once the agent settles.
4. Review the full saved document, then explicitly choose an action. **Implementation never starts without your choice.** **Implement in fresh session** is always the first/default choice; **Implement here** is an explicit alternative. Dismissal leaves the plan ready; use `/plan` to reopen review or if automatic presentation was interrupted.
5. Implementation remains tracked. Before implementing requested changes, the agent saves localized revisions with `plan_mode_edit` or complete replacements with `plan_mode_update`, then continues without another approval dialog. Reasons are optional. It finishes with `plan_mode_implementation_complete`. A fresh adherence check runs **automatically by default**. Use `/plan verify` to check again, or `/plan resume` before requesting further implementation changes.

By default, plans are decision briefs for an equally capable implementer who can inspect the repository but does not have the planning conversation. They preserve consequential choices, context, non-obvious changes, and meaningful verification—not exhaustive mechanical instructions. Each completed plan should include a rough range of changed lines: additions plus deletions across source, tests, and documentation, not net growth. Revisions update the estimate when scope changes materially; no per-file accounting or false precision is required. This is prompt guidance, not a completion validation rule.

## Commands

| Command | Purpose |
| --- | --- |
| `/plan` | Open the planning menu, or review the completed plan. |
| `/plan start` | Enter Plan mode without sending a model message. |
| `/plan <prompt>` | Start with a request, or send a follow-up to the active planner. |
| `/plan saved` | Browse the current project's saved series and revisions outside an active workflow. |
| `/plan tools` | Choose tools and start, or change the current workflow's tools while the agent is idle. |
| `/plan settings` | Set tool defaults, the checker model, or automatic adherence checking. |
| `/plan verify` | Check the current session's tracked implementation with a fresh agent. |
| `/plan resume` | Resume implementation tracking after completion or exit, before sending fixes. |
| `/plan cancel` | Cancel an in-progress adherence check. |
| `/plan finalize` | Ask the active planner to resolve a remaining material question or submit the complete plan. |
| `/plan save` | Leave a completed workflow with its already-saved revision available for later. |
| `/plan exit` | Leave Plan mode and restore the previous active tools; saved files remain. |

Commands require an idle agent with no queued messages, except `/plan cancel`. Menus, document review, and implementation selection require TUI or RPC. Print/JSON users can use the direct planning commands and resume in an interactive mode to review and implement.

There is no direct `implement` route, and no `show`, `export`, or `off` aliases. Implementation is selected only after document review. Exact subcommand arguments choose routes; other text is a planning request, so `/plan start a migration` is a prompt. See [command workflows](./docs/command-workflows.md).

## Keyboard toggle

**Ctrl+Alt+P** toggles directly between planning and normal mode while the agent is idle with no queued messages. Entering behaves like `/plan start`; leaving restores the previous tools without opening review, sending a prompt, or starting implementation. Your editor draft and saved plan files are unchanged. Leaving ends the current workflow; use `/plan saved` to continue a saved revision rather than starting a new workflow.

Change the binding in `<getAgentDir()>/pi-plan-mode.json`:

```json
{
  "shortcuts": { "togglePlan": "shift+tab" }
}
```

Set `togglePlan` to `null` to disable the shortcut; remove the override to restore **Ctrl+Alt+P**. Run `/reload` or restart Pi after changing it, then check `/hotkeys`. There is no shortcut settings-menu editor or watcher.

**Shift+Tab requires an extra step:** Pi reserves it for `app.thinking.cycle`. Merge `"app.thinking.cycle": []` into `<getAgentDir()>/keybindings.json` (preserving other bindings), or move that action to another key, then reload. The default Ctrl+Alt+P needs no global binding changes, though your own bindings or other extensions can still conflict; Pi's conflict diagnostics apply.

**Ctrl+M is rejected:** terminal control codes alias it to Enter, and Pi's matcher can intercept ordinary prompt submission. Reasoning-effort controls are independent and are not provided by this package. Dialogs retain their own navigation keys; RPC and print/JSON users should use commands.

## Saved plans and revisions

New series use a fixed location outside the repository:

```text
<getAgentDir()>/pi-plan-mode/<repo>/
  2026-07-19-improve-search-01.md
  2026-07-19-improve-search-02.md
```

`getAgentDir()` is normally `~/.pi/agent`, or the configured Pi agent directory. `<repo>` is the safe normalized directory name of the canonical Git root, falling back to the canonical working directory outside Git. **Same-named checkouts intentionally share plans**, without a path hash. Worktrees use their own top-level directory names.

The date is the local-calendar `YYYY-MM-DD` of the first save. The date and short title-derived description stay fixed for the entire series, including revisions saved on later days or during implementation. Existing series in the old `pi-plan-mode/<plansDirectory>/<name>-<path-hash>/` layout remain readable and continuable in place; no files are moved or renamed.

Every successful completion publishes a new numbered Markdown revision without overwriting an existing file—even when the planner resubmits an unchanged plan after clarification. Localized edits also preserve the source and publish a new numbered revision in the same series. Revisions store parent/hash metadata atomically with the Markdown body. Reasons are optional on `plan_mode_complete` and `plan_mode_update`; `plan_mode_edit` has no reason field. Existing plain Markdown files remain usable as baselines; absent reasons are never invented. A new workflow starts a new series; colliding titles are disambiguated. **Continue planning** keeps the selected series and writes its next revision, including when continuing from an older revision.

`/plan saved` includes the shared repo-name directory and the current project's legacy default/configured locations. It groups files by location and series and defaults to the latest revision while keeping older revisions selectable. There is no separate saved-plan index or session-local slot. Exiting or implementing does not delete saved files.

## Review and implementation

Document review shows the complete plan, its revision, path, and any change reason, with these actions immediately beneath the scrollable plan:

- **Implement in fresh session** — always the first/default action, never remembered from a previous choice. Transfers the full reviewed plan, not planning messages, tool results, or summaries. The new session links to the source as its parent only if the source has a persisted session file.
- **Implement here** — explicitly keeps the current conversation and starts implementation with the reviewed plan after leaving Plan mode.
- **Save for later** — leaves Plan mode without starting a model turn. The revision is already on disk.
- **Continue planning** — resumes planning from the reviewed revision in the same series.

Opening review never starts implementation. Use the configured Up/Down keys to select an action and the confirmation key (normally Enter) to execute it. Page Up/Page Down and Home/End scroll the document; the mouse wheel works over the plan. Space opens search, where input and search navigation take precedence over actions; close search before choosing an action. Actions stay outside the document viewport. Small terminals compact metadata and hints first, then show a reachable action window with the selection visible. RPC shows the document page and all four actions together, alongside paging and Close. Escape leaves the plan ready. Automatic review, `/plan`, and saved-revision review use this same screen.

The handoff uses exactly the text reviewed, not a subsequent reread of the file. Fresh sessions load their ordinary project instructions and resources. Implementation does not override the main model or thinking choices. A stable implementation prompt section keeps the plan-update/completion protocol and current durable plan reference available across turns and compaction; it does not repeatedly inject the full plan.

A successful handoff ends restricted planning in the source session and establishes branch-aware implementation tracking in the destination; the saved revision remains available through `/plan saved`. Cancelling replacement restores the source workflow. If the destination exists but its first request fails, the extension attempts to leave the complete request in its editor for retry. Cancelling review or action selection does not start implementation.

## Tools and trust

The strict defaults are the **canonical built-in `read`, `grep`, `find`, and `ls` implementations**, plus `plan_mode_question`, `plan_mode_complete`, and `plan_mode_edit`. Same-name extension overrides are not trusted defaults. Plan mode temporarily activates the required direct tools and restores the previous active-tool selection when it ends.

Use `/plan tools` while idle to change a workflow's selection, including after planning has started. Use `/plan settings` for future-workflow defaults. The picker asks for confirmation before trusting nondefault tools.

**Explicitly selecting a tool trusts its implementation**, including shells, editing tools, MCP tools, and overrides. There is no shell parser or command-level read-only filter. A trusted tool can mutate files, execute code, or affect external systems, even though the default planning prompt instructs the planner not to do so. Tool annotations are not verified permissions. This is an agent workflow restriction, **not an OS sandbox or confidentiality boundary**.

Each host-mediated tool call, including a nested call, must have an allowed exact name. Selecting `codemode` or another orchestrator does not authorize its callees; select them separately. Registered `codemode`/`deferred` tools can be allowed without forcing direct activation. Direct and `model-only` selections are activated; Pi still prevents nested calls to `model-only` tools. Hidden and unknown tools are unavailable. The required helpers must be registered and available too. Question/completion helpers are planning-only; `plan_mode_edit` is available in planning and active tracked implementation. Implementation update/status/completion helpers are available only during tracked implementation. All helpers are inactive outside their applicable workflow and excluded from adherence-checker sessions.

## Structured questions

The rich questionnaire is retained: `plan_mode_question` asks one to three questions with meaningful choices, custom answers, and optional notes. A single question submits directly; multiple questions use tabs and a final Review page. In TUI, use Tab/Shift+Tab or left/right to move between questions, up/down to choose an option, Enter to confirm, and `n` to add or edit a note. Custom answer and note editors respect Pi's configured editor; Ctrl+C cancels the question.

RPC uses sequential selection/editor dialogs. If interactive questions are unavailable or cancelled, the planner should ask a concise plain-text question or state a low-risk assumption—not silently guess a material decision.

Initial plans and broad rewrites use a standalone `plan_mode_complete` call with a nonempty complete plan, at most 50,000 JavaScript characters. Localized revisions use `plan_mode_edit` with exactly Pi's `{path, edits: [{oldText, newText}]}` shape, no reason field, targeting only the current active revision. Each replacement must uniquely match a non-overlapping region. Its result shows a diff and the newly saved path rather than echoing the full plan; subsequent edits must use that new path.

In planning, either save tool is a standalone, top-level final action: nested or batched saves are rejected. Success marks the plan ready, terminates the turn, and schedules the usual review. During tracked implementation, editing advances the current plan while preserving the approved baseline and tracking; work continues without a new approval dialog. User-requested changes must be saved before implementation; agent-discovered material scope changes still require user authorization. Use `plan_mode_update` for complete implementation-plan replacements. Prose announcements and legacy plan tags do not complete a workflow. `/plan finalize` is an explicit request, not an automatic retry loop.

## Settings and guidance

The optional settings file is `<getAgentDir()>/pi-plan-mode.json`:

```json
{
  "tools": ["read", "grep", "find", "ls"],
  "verification": { "automatic": true }
}
```

Omit `tools` for strict defaults; `[]` means planning helpers only. The former `plansDirectory` setting is retained only as a legacy browsing hint; it never redirects new series, and there is no storage-subdirectory menu. There is no settings watcher: tool defaults are read for future workflows, while an active workflow retains its configuration unless you explicitly change its tools. Shortcut settings are loaded once per extension instance and require `/reload` or restart.

Verification settings are read for the next check. Omit `verification.model` to use the current model, or set `{ "provider": "provider-id", "id": "model-id" }`. Automatic checks incur an additional model run; set `verification.automatic` to `false` to opt out.

Checks return a simple verdict—**OK** (green), **Minor issues** (yellow), or **Issues** (red)—and the checker's free-form Markdown motivation. The final report uses provider-enforced strict JSON Schema tool arguments; unsupported providers fail visibly. Execution failures remain separate from verdicts, and recovered inspection errors do not automatically downgrade the assessment.

The checker compares the exact approved baseline and its implementation revisions against repository evidence. It receives scoped implementation user messages upfront and can inspect the implementation transcript to identify user-requested changes and reasons for deviations. This content goes to the selected checker provider. It is **not a general code review**, and findings never trigger an automatic repair loop. See [adherence checks](./docs/adherence-checks.md) for transcript scope, limitations, and tool compatibility.

Two optional user-wide Markdown files customize planning (`getAgentDir()` respects `PI_CODING_AGENT_DIR`):

- `pi-plan-mode-prompt.md` replaces the **entire extension planning prompt** when nonblank. Missing or blank selects the built-in default in [`src/prompt.ts`](./src/prompt.ts), which is the starting point for customization.
- `pi-plan-mode.md` appends guidance to the selected base prompt; existing guidance files keep that role.

A replacement removes built-in methodology, safety prose, question/completion instructions, and the estimate convention. Custom prompt authors must supply their desired read-only planning and question/completion protocol instructions. Only the extension's `pi_plan_mode` section is replaced—not Pi's overall system prompt, project instructions, or tool declarations. Runtime tool permissions, completion validation, and explicit implementation approval remain enforced; trusted tools are still not sandboxed.

Both files are bounded UTF-8 Markdown (64 KiB each), read and snapshotted when a workflow starts. Invalid or unreadable files block activation. Follow-ups, revisions, session restoration, tree navigation, and compaction retain the snapshots rather than rereading edits. Legacy sessions without a base snapshot fall back once to the current built-in prompt plus their captured guidance, never today's replacement. To reset, remove or empty the replacement file, then exit and start a new workflow; remove or empty the guidance file too for unaugmented defaults. No files are auto-created, and there is no watcher, prompt menu, or project-local override. See the [settings reference](./docs/settings.md) for details and guidance examples.

## License

MIT. See [`LICENSE`](./LICENSE).
