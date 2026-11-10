# Plan mode settings

[Back to README](../README.md)

## File and menu

Use `/plan settings` while the agent is idle, or edit `<getAgentDir()>/pi-plan-mode.json` (normally `~/.pi/agent/pi-plan-mode.json`, with `PI_CODING_AGENT_DIR` respected).

The menu offers:

- **Default planning tools** — save an explicit tool selection for future workflows.
- **Reset to strict inspection tools** — remove the override and use canonical built-in defaults.
- **Automatic adherence checks** — on by default; off disables the completion-triggered checker.
- **Adherence checker model** — select a provider/model or reset to the current main-session model.
- **Progress model** — independently choose the observer model or reset to `openai/gpt-6-luna`.
- **Progress reasoning** — choose a Pi thinking level or reset to `low`.

These are the only supported settings:

```json
{
  "tools": ["read", "grep", "find", "ls"],
  "shortcuts": { "togglePlan": "alt+m" },
  "verification": {
    "automatic": true,
    "model": { "provider": "provider-id", "id": "model-id" }
  },
  "progress": {
    "model": { "provider": "openai", "id": "gpt-6-luna" },
    "thinkingLevel": "low"
  }
}
```

| Key                      | Default   | Meaning                                                                                                                                |
| ------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `plansDirectory`         | Omitted   | Legacy browsing hint only; retained values identify old relative subdirectories. Never changes the location of new series.             |
| `tools`                  | Omitted   | Exact names of explicitly trusted planning tools. Omission uses canonical inspection defaults; `[]` permits only the required helpers. |
| `shortcuts.togglePlan`   | `"alt+m"` | Toggle planning/normal mode. A Pi key string replaces the default; `null` disables it. Requires reload.                                |
| `verification.automatic` | `true`    | Run a fresh adherence check on explicit implementation completion. Explicit `false` is preserved.                                      |
| `verification.model`     | Omitted   | Use the current main-session model at check time, or an explicit `{ provider, id }`.                                                   |

| `progress.model` | `{ "provider": "openai", "id": "gpt-6-luna" }` | Independent transcript observer chat model; never falls back. |
| `progress.thinkingLevel` | `"low"` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, constrained to advertised model capabilities. |

Progress settings are resolved for each assessment while `/plan progress` is open. Remove either override (or use its menu default option) to reset it. They do not alter the main model or adherence checker. Effective reasoning constraints are shown in the panel. The supplied default is a desired identifier, not an availability guarantee. It must resolve as a chat model; a catalog/configuration exposing only a classifier with that identifier cannot produce this summary. Select an available chat model if necessary. Missing model/credentials, unsupported extension-only providers, and invalid settings produce a panel error and stop automatic retries; close and reopen after correcting them. The 30-second minimum assessment interval is not configurable. See [live progress](../README.md#live-reported-progress) for cost, privacy, evidence limitations and cancellation semantics.

Verification defaults are read at completion/check time, so menu changes affect the next check without restarting tracking. Missing models or authentication fail visibly, never silently switch providers. The checker inherits the current thinking preference, clamped to its model's capabilities. Its model selection does not change the main session's model.

Automatic checks incur a separate model run and disclose scoped implementation user messages and inspected transcript evidence to the selected provider. Use `verification.automatic: false` to disable automatic checks; `/plan verify` remains available.

Missing settings return defaults without creating a file. There is no watcher: new workflows read current defaults; an existing workflow keeps its captured settings. Changing defaults does not change a running workflow's tools or move its saved files. Use `/plan tools` while idle for an explicit workflow-local tool change.

## Keyboard toggle

Alt+M is enabled by default. It enters planning like `/plan start`, or leaves planning (including a ready plan) and restores the previous tools. It never opens review or starts implementation, sends no model message, and preserves your editor draft and saved files. Leaving ends the current workflow; use `/plan saved` to continue a saved revision. Busy agents, queued messages, and open Plan commands prevent toggling rather than scheduling it for later.

`shortcuts.togglePlan` accepts Pi key syntax, normalized for case, modifier order, and key aliases. Set it to another key string to rebind, `null` to disable, or remove it to restore the default. This setting is file-only and loaded once during extension initialization: run `/reload` or restart after editing, and inspect `/hotkeys`. Other settings retain their existing read timing. An invalid startup settings file leaves commands/tools registered but disables shortcut registration and reports the error when a UI is available; correct the file and reload.

The default does not conflict with standard Pi bindings. Custom bindings and other extensions can conflict; Pi decides precedence and reports conflicts. This package never edits global keybindings or bypasses reserved actions.

To choose Shift+Tab, set `"shortcuts": { "togglePlan": "shift+tab" }` in this file, and merge `"app.thinking.cycle": []` into `<getAgentDir()>/keybindings.json`, preserving unrelated fields. Alternatively remap the native cycle action. Without that step Pi rejects the extension shortcut because Shift+Tab is reserved. No global change is needed for Alt+M.

Ctrl+M is rejected because it aliases Enter and Pi's matcher can consume normal prompt submission. Main-agent reasoning-effort controls are separate; the progress-reasoning setting affects only the observer. Dialog navigation and paste continue through Pi's native input handling; RPC and noninteractive modes use commands.

## Plan storage and legacy locations

New series always use:

```text
<agent-dir>/pi-plan-mode/<repo>/<YYYY-MM-DD>-<short-description>-01.md
```

The repo folder is the safe normalized basename of the canonical Git top-level directory, or canonical cwd outside Git. Same-named checkouts intentionally share plans. The first save's local-calendar date and title-derived description remain unchanged across later revisions, even on different days. Independent same-date/title series receive a collision suffix rather than being merged.

The storage-subdirectory setting is retired. A retained `plansDirectory` field is only a hint for finding old plans. `/plan saved` combines the new directory with the current canonical project's legacy `plans/<name>-<path-hash>/` directory and, when configured, `<plansDirectory>/<name>-<path-hash>/`. Missing legacy directories are not created by browsing. Old series continue at their original location with their original filenames; they are not assigned invented dates.

Captured locations in existing planning and implementation sessions remain usable. A historic custom location no longer recorded in settings can still be accessed through a session that captured it; the browser does not search every past subdirectory or other checkouts' old hashed locations. New series always use the fixed layout, even when old settings or an unfinished old session are present.

Legacy hints must be nonempty relative paths with `/` separators. Absolute paths, backslashes, NUL, empty components, and `.` or `..` components are rejected. All storage directories beneath the agent-directory anchor must be real directories, not symlinks. Stored paths are not arbitrary export permissions. Existing files and settings hints are never automatically moved, renamed, or deleted.

## Tool selection and trust

Without `tools`, Plan mode selects available canonical built-in `read`, `grep`, `find`, and `ls`. A custom override with the same name is not canonical. The registered `plan_mode_question`, `plan_mode_complete`, and `plan_mode_edit` helpers are always required; do not add them manually.

Explicit `tools` replaces the optional defaults rather than adding to them. Names must be nonempty strings; duplicates are removed in first-seen order. Names are exact: namespace names, wildcards, and Pi's `+name`/`-name` settings syntax are not expanded here.

For example, this trusts a codemode orchestrator and one MCP callee in addition to `read`:

```json
{
  "tools": ["read", "codemode", "mcp__docs__read"]
}
```

Each nested callee must be selected separately. Planning saves (`plan_mode_complete` and `plan_mode_edit`) are an exception: call them directly and alone, not nested or batched, so Pi can terminate the turn. During tracked implementation, `plan_mode_edit` may be nested and does not terminate. Direct and `model-only` tools are activated for the workflow; registered `codemode` and `deferred` tools are allowed without forcing direct activation. Pi's own exposure rules still apply, including the prohibition on nested calls to `model-only` tools. Unknown or hidden tools are unavailable, not implicitly registered or made reachable.

The selector retains unavailable configured names and warns that they may become available later. Edit the JSON or reset defaults to remove those retained names. This is not a first-request frozen policy: permissions are resolved against current tool metadata, and users can change the selection between turns with `/plan tools`.

During implementation, `/plan tools` changes the checker selection without restricting the main agent's implementation tools. Checking requires `read` to access the private transcript artifact. The fresh child recreates selected tool sources and verifies their provenance/exposure; unavailable or non-reproducible SDK-only tools fail visibly. Workflow-control helpers are not given to the checker. See [adherence checks](./adherence-checks.md).

The previous active-tool selection is restored when planning ends. You do not need to enable registered built-in search tools separately in Pi merely to use them in Plan mode.

**Trust warning:** selecting nondefault tools—including `bash`, `powershell`, `write`, or a core-name override—trusts their implementation and arguments. There is no shell parser, command filter, or automatic side-effect analysis. The default planning prompt instructs the planner not to mutate the project, but trusted tools can execute code or modify local and external state. Read-only annotations are hints, not guarantees. Plan mode is not an OS sandbox and does not prevent disclosure of data Pi can read.

## Persistence and invalid files

Settings reads are bounded to 64 KiB and require valid UTF-8 and a JSON object. Invalid values, malformed JSON, directories, and symlinks are rejected. A workflow that cannot read valid settings does not silently substitute defaults; correct or remove the invalid file before retrying.

Updates reread and validate the existing document, preserve unknown fields, and publish atomically through a temporary file. Updates are ordered within one Pi process, but there is no cross-process settings lock. An invalid existing document is not overwritten to repair it implicitly.

`tools`, `verification`, `progress`, and `shortcuts.togglePlan` configure current behavior; `plansDirectory` has only the legacy-discovery role described above. Retired top-level thinking, model, shortcut (including `toggleShortcut`), reinjection, shell, and export keys are not interpreted. Unknown fields remain in the document. The unrelated old `plan-mode.json` filename is not read; compatibility with this fork's previous storage does not migrate settings from that file.

## Plan style and user instructions

By default, every completed implementation plan should include a short approximate range of changed lines, counting **additions plus deletions** across source, tests, and documentation—not net file growth. Avoid false precision and mandatory per-file accounting. Update the estimate when a revision materially changes scope. This is planning guidance only: completion does not parse plans or reject a missing estimate, and a custom prompt can omit it.

Two optional files under `getAgentDir()` (normally `~/.pi/agent`, respecting `PI_CODING_AGENT_DIR`) control the planning text:

| File                     | Role                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `pi-plan-mode-prompt.md` | Nonblank content replaces the entire built-in extension planning prompt. Missing or whitespace-only selects the built-in default. |
| `pi-plan-mode.md`        | Appends optional guidance to whichever base prompt was selected. Missing or blank adds nothing.                                   |

Both are plain UTF-8 Markdown, not JSON, with a **64 KiB per-file** limit and regular-file checks. Reads are bounded; invalid UTF-8, oversized/nonregular files, and read errors block activation with the offending path rather than silently falling back. Markdown is not expanded; only surrounding whitespace is trimmed. Ordinary reads never create files. `/plan prompt` (also **Settings → Edit planning prompt**) opens the replacement in Pi's editor in TUI or RPC mode, creating a missing file from the built-in default first. Existing blank files remain blank. Submit to save atomically, or cancel to leave the file unchanged; a newly created template remains on cancellation. Invalid files are not overwritten, and edits detected on disk while the editor is open block saving. Changes affect new workflows only. There is no watcher or project-local override.

### Appended guidance

Existing `pi-plan-mode.md` files retain their appended-guidance role. Write conditional prose when guidance applies only to some repositories:

```markdown
For repositories with event-sourced models, explain material event-schema changes
and the conceptual migration strategy. Keep routine propagation details brief.
```

The built-in prompt first grounds decisions in repository evidence. Plans should explain consequential choices, non-obvious work, and focused verification for an equally capable implementer without the planning conversation. They need not enumerate routine mechanics or follow a fixed exhaustive outline. Specific requests for detail override generic brevity, but appended guidance cannot authorize mutations or bypass the selected planning prompt's safety rules or question/completion/edit protocol.

### Full prompt replacement

Use [`src/prompt.ts`](../src/prompt.ts) as the built-in starting point for customization. A nonblank `pi-plan-mode-prompt.md` replaces all built-in planning methodology, safety prose, turn/completion instructions, and the estimate convention. No built-in methodology or estimate requirement is silently retained. The extension still appends the current saved revision path when one exists so the editor can target it. When both files exist, the replacement is the base and `pi-plan-mode.md` is appended.

**Custom prompt authors must supply their desired read-only planning and question/completion/edit protocol instructions.** Both planning save helpers must be called directly and alone as the final action: successful completion or editing marks the plan ready and ends the turn. Replacement affects only the extension-owned `pi_plan_mode` system section, not Pi's overall system prompt, project instructions, or tool declarations. Runtime permissions, completion validation (including existing length limits), and explicit implementation approval remain enforced by code. Trusted tools can still have side effects; this is not a sandbox.

### Snapshots and reset

The selected base prompt (including the built-in default when selected) and appended guidance are captured when a new workflow starts and persisted with it. Ordinary turns, follow-ups, revisions, session restoration, tree navigation, and compaction use these snapshots, not later file edits. Continuing a saved revision from outside an active workflow starts a new workflow and captures current files.

Legacy entries without a base snapshot use a one-time fallback to the current built-in prompt plus their already-captured guidance; they never read today's replacement during restoration. The fallback is retained in memory and included in subsequent workflow state writes. This may introduce the new default estimate guidance when an old workflow first restores.

To reset to the built-in base, remove or empty `pi-plan-mode-prompt.md`; also remove or empty `pi-plan-mode.md` to remove appended guidance. Exit planning and start a new workflow for these changes to take effect. Reloading or resuming an existing workflow does not reset its snapshots. The tool-default reset menu does not modify these files.

Both snapshots are sent to the model and stored in the session. Do not put secrets in them.
