# 🧭 pi-plan-mode — Plan Before Pi Edits Code

[![npm](https://img.shields.io/npm/v/@narumitw/pi-plan-mode)](https://www.npmjs.com/package/@narumitw/pi-plan-mode) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Explore a codebase, resolve important questions, and review an implementation-ready plan before starting work. Each plan is one named, mutable Markdown file, such as `support-uploading-images.md`, kept at the same configured storage location throughout planning and implementation.

## Load this fork

This checkout contains an unreleased fork targeting current Pi APIs, tested against **Pi 1.5.0**. Older hosts are not supported. Version 3 workflows and plan-document envelopes reject legacy state without modifying its files; start fresh with `/plan start` and paste the Markdown body text into the planning conversation, without its legacy envelope, rather than restoring an old workflow. The retained npm name and badge identify the upstream package; installing it does not install this checkout's implementation.

Install this fork together with artifacts and thinking shortcuts using `pi install git:github.com/tommyengstrom/pi-extensions`, then restart or `/reload`. Git installation builds the runtime automatically with Node and npm; Bun and manual preparation are not consumer requirements. See the [workspace installation guide](../../README.md#install-from-github) for updates and pinning.

For local development, from the repository root run the managed job:

```bash
process-compose run dev
```

To load an already-built checkout from the repository root:

```bash
./node_modules/.bin/pi --no-extensions -e ./packages/pi-plan-mode
```

Load only extensions you trust: they run with Pi's operating-system permissions. See the [workspace guide](../../README.md) for builds and validation. The package directory loads its generated `dist/index.ts` entrypoint; build an unbuilt local development checkout before loading that directory. The Git package's root manifest loads all three source entrypoints and automatically prepares their runtime dependencies.

## Quick start

1. Run `/plan <request>`, or `/plan start` and then describe the change. A separate, bounded naming request chooses a filename early; it does not create a file.
2. Let the planner inspect the repository and ask structured questions about material decisions.
3. The planner calls `plan_mode_complete` with the complete Markdown plan. The result shows the plan and its saved path, then **review opens automatically** in TUI or RPC once the agent settles.
4. Review the full saved document, then explicitly choose an action. **Implementation never starts without your choice.** **Implement in fresh session** is always the first/default choice; **Implement here** is an explicit alternative. Dismissal leaves the plan ready; use `/plan` to reopen review or if automatic presentation was interrupted.
5. Before implementing requested changes, the agent saves them to the same plan with `plan_mode_edit` or `plan_mode_update`. After implementation and planned tests, it calls `plan_mode_implementation_complete` alone. Completion returns to Normal without a follow-up request by default. Templates can opt into [named subagent checks](./docs/settings.md) under `hooks.on_implementation_complete` (replaces the old scalar). Each potentially billable worker receives its own prompt and the full saved plan, not the conversation or transcript. Checks inherit the parent model and effort unless overridden, run up to four at a time, and report together in declaration order. Failure is advisory; no automatic fix or retry follows. Use `/plan resume` before requesting more implementation work.

By default, plans are decision briefs for an equally capable implementer who can inspect the repository but does not have the planning conversation. They preserve consequential choices, context, non-obvious changes, and meaningful verification—not exhaustive mechanical instructions. The built-in templates request a rough range of changed lines: additions plus deletions across source, tests, and documentation, not net growth. Updates change the estimate when scope changes materially; no per-file accounting or false precision is required. This is prompt guidance, not a completion validation rule.

## Explain without planning

Use `/explain` or `/explain start` to enter **Explain** without sending a model message, or `/explain <request>` to enter or follow up with a question. Explain grounds conversational answers in repository evidence, discusses alternatives and improvements, and ends naturally in prose or with a useful structured question. It stays active across turns—even after "thanks" or a request to fix something. It creates no saved plan, naming request, readiness review, or implementation observer.

Coding requires an explicit switch: `/explain exit` returns to Normal for ordinary fixes; `/plan start` or `/plan <request>` starts a new approval workflow in the same conversation. Entering Explain from Plan ends that workflow, retains saved files, and cancels its owned background work. Entering Explain during implementation detaches tracking; exiting never resumes it automatically. After leaving, use `/plan resume` explicitly for retained records.

Explain shares Plan's inspection defaults, explicit tool trust, and `/plan tools` selection. Plan-writing and implementation helpers are always denied in Explain, even if configured explicitly. This is a workflow restriction, **not an OS sandbox**: trusted tool implementations can still mutate state, but Explain's instructions prohibit mutations and plan creation. Selected artifact tools get no plan workspace, association, readiness protocol, or automatic generation guidance; operations requiring plan ownership may reject.

Explain uses [`prompts/explain.md`](./prompts/explain.md), never the plan prompt, templates, or appended planning files. Its identity, tool permissions, and prompt snapshot survive reload, branch navigation, and compaction. Switching Explain → Plan carries the permission selection forward without reviving an earlier workflow.

## Controlled subagents

When `pi-herdr-core` is loaded, **new** Plan and Explain workflows permit its four verified tools by default: `subagent`, `subagent_query`, `subagent_wait`, and `subagent_cancel`. Names alone do not establish trust: registered package-entrypoint provenance must match. Explicit selections (including `tools: []`) are unchanged. Restored implicit workflows retain their older inspection defaults; new defaults are captured for stable continuation.

Use `/subagent <query>` for a human delegation request. Children inherit the workflow's exact allowed-name ceiling and guidance, excluding parent-only plan/review/implementation and Plan-associated artifact helpers. Controlled terminal/control-record bookkeeping is permitted, not code mutation or approval. Tool permission changes or mode replacement cancel associated work; ordinary turns retain its scope and prompt.

Ready-plan publication requires associated subagents to stop and relevant pending results to be retrieved or committed to the transcript. Review freezes new launches and automatic continuation. A child result can never approve implementation. Existing replacement prompts are not rewritten automatically: deliberately adopt the new controlled-delegation guidance if using a custom prompt. See [Herdr documentation](../pi-herdr-core/README.md) for Core requirements, limits, profiles and result references.

## Background artifacts

Load `pi-artifacts` alongside Plan mode and select the complete tool set in `/plan tools`:
`artifact_create`, `artifact_update`, `artifact_status`, `artifact_wait`, and `artifact_cancel`.
`/plan settings` saves these as future defaults; installation does not change the default
inspection-only selection. The parent remains directly read-only; its child session owns
confined native mutation tools independently.

Launch a focused brief once user-facing requirements are clear, continue technical
planning during generation, and wait only at an actual dependency or at the end.
Both planning save tools refuse queued/running associated work **without publishing
or scheduling review**. Failures require a retry or explicit user agreement through
`/plan artifacts omit <jobId>`; partial files are never presented as successful artifacts.
The implementation-phase requirement to record plan changes is not gated on artifacts.

Each workflow has a stable workspace under the saved-plan directory:
`artifacts/<workspace-id>/`. Create in a new or empty child directory. Structured
claims and results survive restoration, compaction, saved-plan continuation, and fresh
implementation handoff. Review lists identifiers, directories, and useful file paths.
The handoff carries references, not HTML bodies or child conversations. Capture important
design decisions in the plan Markdown too.

Artifacts are **live files, not snapshots**. Continuing a saved plan continues its live
artifacts. Use another artifact directory for an independent alternative. Exiting Plan
mode cancels its outstanding jobs, retaining partial output and history.

When artifact tools are selected, the prompt adds their workspace and readiness rules.
The template can specify when and how to use artifacts; failed or unfinished jobs still
cannot be presented as successful artifacts or bypass readiness checks. See the
[artifact package](../pi-artifacts/README.md) for persistence, cost, tool-boundary, and
untrusted HTML details.

## Commands

| Command | Purpose |
| --- | --- |
| `/explain` / `/explain start` | Enter Explain without sending a model message. |
| `/explain <request>` | Enter or follow up conversationally, without editing or saving a plan. |
| `/explain exit` | Return from Explain to Normal. |
| `/plan` | Open the mode menu (including Explain), or review the completed plan. |
| `/plan start` | Enter Plan mode without sending a model message. |
| `/plan <prompt>` | Start with a request, or send a follow-up to the active planner. |
| `/plan saved` | Browse current-format named plans outside an active workflow. |
| `/plan open` | Open the current saved plan in the external editor in TUI (`$VISUAL`, `$EDITOR`, or `vi`) or Pi's editable text dialog in RPC; save the same file without changing mode. |
| `/plan template [id]` | Choose or switch the active workflow's plan template (triggering an immediate rewrite if a plan is already saved), or set the default template when outside Plan mode. |
| `/plan implement` | Review the current on-disk plan and explicitly choose implementation here or in a fresh session. |
| `/plan tools` | Configure current Explain/Plan permissions, or future inspection defaults outside planning. |
| `/plan settings` | Choose the default plan template, tool defaults, independent progress model/reasoning, or the Naming model. |
| `/plan progress` | Toggle reported progress above the editor, including while the agent is busy. |
| `/plan resume` | Resume implementation tracking after completion or detachment, before sending fixes. |
| `/plan artifacts omit <jobId>` | Explicitly agree to omit a failed/cancelled/interrupted artifact from readiness. |
| `/plan exit` | Leave Plan mode and remove its execution gate; saved files remain. |

While Pi is working, use **Alt+M**, `/plan start`, `/plan exit`, `/explain`, `/explain exit`, or `/plan tools`. Bare `/plan` opens a next-call selector. The current response and its whole tool batch keep their existing permissions. The latest selection takes effect before the next model call, including an automatic tool follow-up; if the run stops, no extra request is made. Pending choices are discarded on session or tree changes. Review, implementation approval, templates, and commands that send a new prompt still require an idle agent. `/plan progress` remains available during a run. Menus, document review, and implementation selection require TUI or RPC. Print/JSON users can use the direct Explain and planning commands and resume in an interactive mode to review and implement.

`/plan implement` reads the active workflow's saved file (including planning follow-ups), or the retained implementation record when planning is inactive. It does not regenerate the plan or send a model request until an explicit choice; both destinations use the reviewed current text. Changes during review require another review. `/plan resume` only reactivates tracking without a model request; `/plan open` only edits. There are no `show`, `export`, or `off` aliases. Removed `finalize`, `save`, `prompt`, `cancel`, `verify`, and `import <path>` commands give migration guidance. Other text remains a planning request, including `/plan save bandwidth`. See [command workflows](./docs/command-workflows.md).

## Mode footer

The coordinated footer is exactly one of these labels:

- `[Normal]`
- `[Explain]`
- `[Plan <template>]` — before a name is available, for example `[Plan decision-brief]`.
- `[Plan <template>] stem` — for example, `[Plan decision-brief] support-uploading-images`, including while ready for review.
- `[Implementing stem]`

`stem` is the actual filename without `.md`, including any collision suffix. Progress remains in a separate panel above the editor.

## Keyboard toggle

**Alt+Shift+M** opens the template picker directly, with the current template marked. Before the first save, selection changes the active plan's template without a model request. After a save, choosing a different template requests a rewrite at the same path. Cancelling or selecting the unchanged current template does nothing. Outside Plan mode, it changes the default for future plans without switching modes. It requires an idle agent, no queued messages, and no open Plan command.

**Alt+M** cycles **Normal → Explain → Plan → Normal** immediately when idle, or for the next model call while busy. Transitions send no request; leaving drops the restriction without opening review or starting implementation. Your editor draft and saved plan files are unchanged. Leaving ends the current workflow; use `/plan saved` to continue a saved plan rather than starting a new workflow.

Change the binding in `<getAgentDir()>/pi-plan-mode.json`:

```json
{
  "shortcuts": { "togglePlan": "shift+tab", "selectTemplate": "alt+shift+m" }
}
```

Set either `togglePlan` or `selectTemplate` to `null` to disable that shortcut; remove its override to restore **Alt+M** or **Alt+Shift+M**, respectively. Run `/reload` or restart Pi after changing it, then check `/hotkeys`. There is no shortcut settings-menu editor or watcher.

**Shift+Tab requires an extra step:** Pi reserves it for `app.thinking.cycle`. Merge `"app.thinking.cycle": []` into `<getAgentDir()>/keybindings.json` (preserving other bindings), or move that action to another key, then reload. The default Alt+M needs no global binding changes, though your own bindings or other extensions can still conflict; Pi's conflict diagnostics apply.

**Ctrl+M is rejected:** terminal control codes alias it to Enter, and Pi's matcher can intercept ordinary prompt submission. Main-agent reasoning-effort controls are independent; the progress-reasoning setting affects only the observer. Dialogs retain their own navigation keys; RPC and print/JSON users should use commands.

## Saved plans and naming

A plan has one stable filename in the configured plan-storage directory, for example:

```text
<configured-plan-directory>/support-uploading-images.md
<configured-plan-directory>/support-uploading-images-2.md
```

The second example is a different plan whose name collided, not a later revision. New independent plans never overwrite an existing plan. There are no date prefixes, revision counters, ancestry links, change reasons, or revision selectors. A successful initial save creates the file; subsequent completion, localized edits, and implementation updates replace that file atomically at the same path. Continuing a saved plan keeps that path. Exiting or implementing does not delete it.

Storage configuration and the workflow's captured storage path remain authoritative; naming does not introduce a new storage directory or move files. `getAgentDir()` is normally `~/.pi/agent`, or the configured Pi agent directory. The repo-name default is `<getAgentDir()>/pi-plan-mode/<repo>/`, using the safe normalized basename of the canonical Git root, or canonical working directory outside Git. Same-named checkouts intentionally share that default; worktrees use their own top-level directory names. See [storage settings](./docs/settings.md#plan-storage-and-legacy-locations).

Naming is an **early, separate request** using only the task text, capped at **4,000 characters**. It receives no tools, repository/context files, conversation history, or plan body. Output is capped at **128 tokens**, with a **10-second timeout**, and normalized to a lowercase kebab-case stem of at most **64 characters**. Failure, timeout, or unusable output uses a deterministic fallback. Numeric suffixes resolve collisions without implying revision history. No plan file is created until save.

By default naming uses the configured progress model (`openai/gpt-6-luna` by default), with the lowest reasoning level that model supports. `settings.naming.model` is an independent override, exposed as **Naming model** in `/plan settings`; changing it does not change progress or the main agent. **Cost and privacy:** naming is an additional provider request that sends bounded task text to that provider, even before a plan is saved. It does not send planning context. See [settings](./docs/settings.md) for reset and failure behavior.

Workflows and plan-document envelopes use **version 3**. Legacy state is rejected without rewriting, migrating, or deleting files. Legacy revision files are excluded from `/plan saved`; there is no implicit continuation or ancestry recovery. Start fresh with `/plan start` and paste Markdown body text into the planning conversation, without a legacy envelope. There is no automatic import or legacy adoption. There is no separate saved-plan index or session-local slot.

## Review and implementation

Document review shows the complete plan, its name, path, and artifact references, with these actions immediately beneath the scrollable plan:

- **Implement in fresh session** — always the first/default action, never remembered from a previous choice. Transfers the full reviewed plan, not planning messages, tool results, or summaries. The new session links to the source as its parent only if the source has a persisted session file; this is session linkage, not plan ancestry.
- **Implement here** — explicitly keeps the current conversation and starts implementation with the reviewed plan after leaving Plan mode.
- **Save for later** — leaves Plan mode without starting a model turn. The plan is already on disk.
- **Continue planning** — resumes planning on the same named file.

Opening review never starts implementation. Use the configured Up/Down keys to select an action and the confirmation key (normally Enter) to execute it. Page Up/Page Down and Home/End scroll the document; the mouse wheel works over the plan. Space opens search, where input and search navigation take precedence over actions; close search before choosing an action. Actions stay outside the document viewport. Small terminals compact metadata and hints first, then show a reachable action window with the selection visible. RPC shows the document page and all four actions together, alongside paging and Close. Escape leaves the plan ready. Automatic review, `/plan`, and saved-plan review use this same screen.

The handoff uses exactly the text reviewed, not a subsequent reread of the file. Fresh sessions load their ordinary project instructions and resources. Implementation does not override the main model or thinking choices. A stable implementation prompt section keeps the plan-update/completion protocol and current durable plan reference available across turns and compaction; it does not repeatedly inject the full plan. Status/recovery reads the authoritative file from disk. Hash-based stale-read checks reject conflicting updates before overwriting newer contents; reread and reconcile before retrying. There is no immutable approved-baseline enforcement.

A successful handoff ends restricted planning in the source session and establishes branch-aware implementation tracking in the destination; the saved plan remains available through `/plan saved`. The destination adds implementation helpers to its own native tools. Cancelling replacement restores the source workflow. If the destination exists but its first request fails, the extension attempts to leave the complete request in its editor for retry. Cancelling review or action selection does not start implementation.

## Live reported progress

During tracked implementation, `/plan progress` toggles a compact panel above the editor; the idle `/plan` menu also offers **Show plan progress**. TUI and RPC use the same string-array widget. In RPC, explicitly enabling the panel counts as visibility even if the client ignores widgets. Print/JSON commands refuse without launching an observer.

Opening assesses immediately, then only changed recorded implementation evidence or changed plan contents triggers another assessment, at least 30 seconds between starts. One short-lived Pi subprocess runs at a time. The previous summary remains visible while updating; the panel identifies its snapshot time and plan snapshot, not a live verification result. Closing cancels work immediately. Errors stop automatic retries: correct configuration, then close and reopen. Completion stops observation and retains the last summary labeled **completed tracking; not verified**. Session replacement, branch navigation, reload/shutdown, or leaving implementation clears it. Resume never reopens it automatically. This panel is separate from the mode-only footer.

**Cost and privacy:** each assessment is a separate provider request. The complete current plan, bounded recent branch-scoped implementation transcript, and fallible previous summary go to the selected progress provider. Planning, abandoned branches, other implementations, and prior adherence reports are excluded by the existing transcript exporter; context edits/provenance boundaries are preserved. Omitted history and unavailable evidence are marked. A plan too large for the conservative budget fails rather than being silently cut. Observer output is neither injected into the implementing agent nor persisted as implementation evidence.

This is **reported progress**, not repository inspection: assistant claims and recorded test/tool results do not establish current repository state. The observer has no tools, extensions, MCP, skills, prompt templates, discovered context files or themes, uses an in-memory session, and receives evidence over stdin. Disabling tools is **not an OS sandbox**; ordinary inherited provider configuration/credential mechanisms still apply. Extension-only providers cannot be recreated and fail rather than enabling extensions.

Defaults are independent `progress.model: { "provider": "openai", "id": "gpt-6-luna" }` and `progress.thinkingLevel: "low"`. Use `/plan settings` to choose/reset them; changes apply to the next assessment, never to the main agent. Missing credentials or unsupported models fail without fallback. The identifier must resolve as a chat model: catalogs/configurations that only expose it as a classifier require selecting another supported progress model. Advertised reasoning constraints are shown in the panel. See [settings](./docs/settings.md).

## Tools and trust

The strict defaults are the **canonical built-in `read`, `grep`, `find`, and `ls` implementations**, plus `plan_mode_question`, `plan_mode_complete`, and `plan_mode_edit`. New workflows also permit the four verified Herdr tools when that extension is loaded. Same-name extension overrides are not trusted defaults. **Permission is not activation:** Plan and Explain check calls at execution time. Unpermitted tools can still be visible, and permitting an inactive ordinary tool does not enable it. Only workflow helpers are toggled. Leaving either mode removes the gate; it does not reset Pi’s tools. Fresh implementation uses the destination’s native tool set. Old `previousTools` snapshots are ignored, not replayed to repair historical sessions.

Use `/plan tools` to change a planning workflow's selection. In normal mode it configures future planning without entering planning or changing active tools. Use `/plan settings` for future-workflow defaults. The picker asks for confirmation before trusting nondefault tools.

**Explicitly selecting a tool trusts its implementation**, including shells, editing tools, MCP tools, and overrides. There is no shell parser or command-level read-only filter. A trusted tool can mutate files, execute code, or affect external systems, even though the default planning prompt instructs the planner not to do so. Tool annotations are not verified permissions. This is an agent workflow restriction, **not an OS sandbox or confidentiality boundary**.

Each host-mediated tool call, including a nested call, must have an allowed exact name during planning. Selecting `codemode` or another orchestrator does not authorize its callees; select them separately. Registered `codemode`/`deferred` tools can be allowed without forcing direct activation. Ordinary direct and `model-only` selections must already be active in Pi; Pi still prevents nested calls to `model-only` tools. Hidden and unknown tools are unavailable. The required helpers must be registered and available too. Question/completion helpers are planning-only; `plan_mode_edit` is available in planning and active tracked implementation. Implementation update/status/completion helpers are available only during tracked implementation. All helpers are inactive outside their applicable workflow.

## Structured questions

The rich questionnaire is retained: `plan_mode_question` asks one to three questions with meaningful choices, custom answers, and optional notes. A single question submits directly; multiple questions use tabs and a final Review page. In TUI, use Tab/Shift+Tab or left/right to move between questions, up/down to choose an option, Enter to confirm, and `n` to add or edit a note. Custom answer and note editors respect Pi's configured editor; Ctrl+C cancels the question.

RPC uses sequential selection/editor dialogs. If interactive questions are unavailable or cancelled, the planner should ask a concise plain-text question or state a low-risk assumption—not silently guess a material decision.

Initial plans and broad rewrites use a standalone `plan_mode_complete` call with a nonempty complete plan, at most 50,000 JavaScript characters. Localized edits use `plan_mode_edit` with exactly Pi's `{path, edits: [{oldText, newText}]}` shape, targeting only the current named plan. Each replacement must uniquely match a non-overlapping region. Its result shows a diff and the same saved path rather than echoing the full plan. There are no change-reason fields or new revision paths.

In planning, either save tool is a standalone, top-level final action: nested or batched saves are rejected. Success marks the plan ready, terminates the turn, and schedules the usual review. During tracked implementation, editing updates the same file while preserving tracking; work continues without a new approval dialog. User-requested changes must be saved before implementation; agent-discovered material scope changes still require user authorization. Use `plan_mode_update` for complete implementation-plan replacements. Status/recovery rereads disk, and stale-read/hash conflicts block updates rather than overwriting newer edits. Prose announcements and legacy plan tags do not complete a workflow. Request further planning through normal conversation. `/plan implement` avoids regeneration when entering implementation, but stronger synchronization before subsequent AI planning revisions and external-editor support remain separate follow-up work.

## Settings and guidance

The optional settings file is `<getAgentDir()>/pi-plan-mode.json`:

```json
{
  "tools": ["read", "grep", "find", "ls"]
}
```

Omit `tools` for strict defaults; `[]` means planning helpers only. Naming preserves the configured storage path. There is no settings watcher: tool defaults are read for future workflows, while an active planning workflow retains its configuration unless you explicitly change its tools. Shortcut settings are loaded once per extension instance and require `/reload` or restart.

See the [custom-template example](./docs/settings.md#built-in-and-custom-templates) to opt into a completion task. None of the four built-ins requests one.

The complete prompts are [`prompts/plan.md`](./prompts/plan.md) and [`prompts/explain.md`](./prompts/explain.md). They are not assembled from instruction fragments. Plan mode appends the selected template body and optional user guidance unchanged after the plan prompt. The plan prompt tells the model to include every template section in order and follow its HTML comments. Only safety, tool permissions, saving, and approval remain general workflow rules:

- Built-in templates live in [`templates/`](./templates/): `decision-brief` (default), `detailed-spec`, `checklist`, and `minimal`. Each has a YAML metadata header and a ready-plan Markdown skeleton with real headings. HTML comments specify section semantics and limits; the planner fills the skeleton without copying those comments or metadata into the finished plan.
- User-defined templates can be added or used to override built-ins as `<getAgentDir()>/pi-plan-mode-templates/<id>.md` (lowercase kebab-case `<id>`, bounded 64 KiB UTF-8 Markdown).
- `pi-plan-mode.md` appends optional user guidance to the core planning protocol and selected template.

Use `/plan template` or `/plan template <id>` during planning to switch templates on the fly. When a saved plan already exists in the active workflow, switching templates immediately asks the planner to rewrite the current plan into the new template format and save it to the same file via `plan_mode_complete`. Outside Plan mode (or via `/plan settings` → **Default plan template**), template selection updates `"template"` in `pi-plan-mode.json` for future workflows. See the [settings reference](./docs/settings.md) for template authoring and guidance details.

## License

MIT. See [`LICENSE`](./LICENSE).
