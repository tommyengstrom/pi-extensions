# Plan mode settings

[Back to README](../README.md)

## File and menu

Use `/plan settings` while the agent is idle, or edit `<getAgentDir()>/pi-plan-mode.json` (normally `~/.pi/agent/pi-plan-mode.json`, with `PI_CODING_AGENT_DIR` respected).

The menu offers:

- **Default planning tools** — save an explicit tool selection for future workflows.
- **Reset to strict inspection tools** — remove the override and use canonical built-in defaults.
- **Automatic adherence checks** — on by default; off disables the completion-triggered checker.
- **Adherence checker model** — select a provider/model or reset to the current main-session model.

These are the only supported settings:

```json
{
  "tools": ["read", "grep", "find", "ls"],
  "shortcuts": { "togglePlan": "ctrl+alt+p" },
  "verification": {
    "automatic": true,
    "model": { "provider": "provider-id", "id": "model-id" }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `plansDirectory` | Omitted | Legacy browsing hint only; retained values identify old relative subdirectories. Never changes the location of new series. |
| `tools` | Omitted | Exact names of explicitly trusted planning tools. Omission uses canonical inspection defaults; `[]` permits only the required helpers. |
| `shortcuts.togglePlan` | `"ctrl+alt+p"` | Toggle planning/normal mode. A Pi key string replaces the default; `null` disables it. Requires reload. |
| `verification.automatic` | `true` | Run a fresh adherence check on explicit implementation completion. Explicit `false` is preserved. |
| `verification.model` | Omitted | Use the current main-session model at check time, or an explicit `{ provider, id }`. |

Verification defaults are read at completion/check time, so menu changes affect the next check without restarting tracking. Missing models or authentication fail visibly, never silently switch providers. The checker inherits the current thinking preference, clamped to its model's capabilities. Its model selection does not change the main session's model.

Automatic checks incur a separate model run and disclose scoped implementation user messages and inspected transcript evidence to the selected provider. Use `verification.automatic: false` to disable automatic checks; `/plan verify` remains available.

Missing settings return defaults without creating a file. There is no watcher: new workflows read current defaults; an existing workflow keeps its captured settings. Changing defaults does not change a running workflow's tools or move its saved files. Use `/plan tools` while idle for an explicit workflow-local tool change.

## Keyboard toggle

Ctrl+Alt+P is enabled by default. It enters planning like `/plan start`, or leaves planning (including a ready plan) and restores the previous tools. It never opens review or starts implementation, sends no model message, and preserves your editor draft and saved files. Leaving ends the current workflow; use `/plan saved` to continue a saved revision. Busy agents, queued messages, and open Plan commands prevent toggling rather than scheduling it for later.

`shortcuts.togglePlan` accepts Pi key syntax, normalized for case, modifier order, and key aliases. Set it to another key string to rebind, `null` to disable, or remove it to restore the default. This setting is file-only and loaded once during extension initialization: run `/reload` or restart after editing, and inspect `/hotkeys`. Other settings retain their existing read timing. An invalid startup settings file leaves commands/tools registered but disables shortcut registration and reports the error when a UI is available; correct the file and reload.

The default does not conflict with standard Pi bindings. Custom bindings and other extensions can conflict; Pi decides precedence and reports conflicts. This package never edits global keybindings or bypasses reserved actions.

To choose Shift+Tab, set `"shortcuts": { "togglePlan": "shift+tab" }` in this file, and merge `"app.thinking.cycle": []` into `<getAgentDir()>/keybindings.json`, preserving unrelated fields. Alternatively remap the native cycle action. Without that step Pi rejects the extension shortcut because Shift+Tab is reserved. No global change is needed for Ctrl+Alt+P.

Ctrl+M is rejected because it aliases Enter and Pi's matcher can consume normal prompt submission. Reasoning-effort controls are separate and not provided here. Dialog navigation and paste continue through Pi's native input handling; RPC and noninteractive modes use commands.

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

Without `tools`, Plan mode selects available canonical built-in `read`, `grep`, `find`, and `ls`. A custom override with the same name is not canonical. The registered `plan_mode_question` and `plan_mode_complete` helpers are always required; do not add them manually.

Explicit `tools` replaces the optional defaults rather than adding to them. Names must be nonempty strings; duplicates are removed in first-seen order. Names are exact: namespace names, wildcards, and Pi's `+name`/`-name` settings syntax are not expanded here.

For example, this trusts a codemode orchestrator and one MCP callee in addition to `read`:

```json
{
  "tools": ["read", "codemode", "mcp__docs__read"]
}
```

Each nested callee must be selected separately. Direct and `model-only` tools are activated for the workflow; registered `codemode` and `deferred` tools are allowed without forcing direct activation. Pi's own exposure rules still apply, including the prohibition on nested calls to `model-only` tools. Unknown or hidden tools are unavailable, not implicitly registered or made reachable.

The selector retains unavailable configured names and warns that they may become available later. Edit the JSON or reset defaults to remove those retained names. This is not a first-request frozen policy: permissions are resolved against current tool metadata, and users can change the selection between turns with `/plan tools`.

During implementation, `/plan tools` changes the checker selection without restricting the main agent's implementation tools. Checking requires `read` to access the private transcript artifact. The fresh child recreates selected tool sources and verifies their provenance/exposure; unavailable or non-reproducible SDK-only tools fail visibly. Workflow-control helpers are not given to the checker. See [adherence checks](./adherence-checks.md).

The previous active-tool selection is restored when planning ends. You do not need to enable registered built-in search tools separately in Pi merely to use them in Plan mode.

**Trust warning:** selecting nondefault tools—including `bash`, `powershell`, `write`, or a core-name override—trusts their implementation and arguments. There is no shell parser, command filter, or automatic side-effect analysis. The planner is still instructed not to mutate the project, but trusted tools can execute code or modify local and external state. Read-only annotations are hints, not guarantees. Plan mode is not an OS sandbox and does not prevent disclosure of data Pi can read.

## Persistence and invalid files

Settings reads are bounded to 64 KiB and require valid UTF-8 and a JSON object. Invalid values, malformed JSON, directories, and symlinks are rejected. A workflow that cannot read valid settings does not silently substitute defaults; correct or remove the invalid file before retrying.

Updates reread and validate the existing document, preserve unknown fields, and publish atomically through a temporary file. Updates are ordered within one Pi process, but there is no cross-process settings lock. An invalid existing document is not overwritten to repair it implicitly.

`tools`, `verification`, and `shortcuts.togglePlan` configure current behavior; `plansDirectory` has only the legacy-discovery role described above. Retired top-level thinking, model, shortcut (including `toggleShortcut`), reinjection, shell, and export keys are not interpreted. Unknown fields remain in the document. The unrelated old `plan-mode.json` filename is not read; compatibility with this fork's previous storage does not migrate settings from that file.

## Plan style and user instructions

Optional `<getAgentDir()>/pi-plan-mode.md` adds user-wide planning guidance. It is plain UTF-8 Markdown, not JSON, and has a 64 KiB limit. There are no per-project profiles in this feature; write conditional prose when guidance applies only to some repositories:

```markdown
For repositories with event-sourced models, explain material event-schema changes
and the conceptual migration strategy. Keep routine propagation details brief.
```

The planner first grounds decisions in repository evidence. Plans should explain consequential choices, non-obvious work, and focused verification for an equally capable implementer without the planning conversation. They need not enumerate routine mechanics or follow a fixed exhaustive outline. Specific requests for detail override generic brevity, but guidance cannot authorize mutations or bypass the question/completion protocol.

Guidance is read once when a new workflow starts and saved with that workflow. Follow-ups, revisions, and restored workflows use the captured guidance, not later edits to the file. Missing or blank guidance adds nothing; read errors, invalid UTF-8, or oversized content block activation. There is no watcher or built-in editor for it.

Guidance is sent to the model and stored in the session. Do not put secrets in it.
