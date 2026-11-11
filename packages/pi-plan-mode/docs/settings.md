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
- **Naming model** — choose an independent naming provider/model or reset to the configured progress model.
- **Edit planning prompt** — edit the user-wide replacement prompt in Pi's editor.

Supported active settings include:

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
  },
  "naming": {
    "model": { "provider": "openai", "id": "gpt-6-luna" }
  }
}
```

The example pins naming independently. Omit `naming.model` to follow the configured progress model instead.

| Key | Default | Meaning |
| --- | --- | --- |
| `tools` | Omitted | Exact names of explicitly trusted planning tools. Omission uses canonical inspection defaults; `[]` permits only the required helpers. |
| `shortcuts.togglePlan` | `"alt+m"` | Toggle planning/normal mode. A Pi key string replaces the default; `null` disables it. Requires reload. |
| `verification.automatic` | `true` | Run a fresh adherence check on explicit implementation completion. Explicit `false` is preserved. |
| `verification.model` | Omitted | Use the current main-session model at check time, or an explicit `{ provider, id }`. |
| `progress.model` | `{ "provider": "openai", "id": "gpt-6-luna" }` | Independent transcript observer chat model; never falls back. |
| `progress.thinkingLevel` | `"low"` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, constrained to advertised model capabilities. |
| `naming.model` | Configured `progress.model` | Independent naming override as `{ provider, id }`; remove it to follow progress again. Naming uses the lowest supported reasoning level. |

Progress settings are resolved for each assessment while `/plan progress` is open. Remove either override (or use its menu default option) to reset it. They do not alter the main model or adherence checker. Effective reasoning constraints are shown in the panel. The supplied default is a desired identifier, not an availability guarantee. It must resolve as a chat model; a catalog/configuration exposing only a classifier with that identifier cannot produce this summary. Select an available chat model if necessary. Missing model/credentials, unsupported extension-only providers, and invalid settings produce a panel error and stop automatic retries; close and reopen after correcting them. The 30-second minimum assessment interval is not configurable. See [live progress](../README.md#live-reported-progress) for cost, privacy, evidence limitations and cancellation semantics.

Verification defaults are read at completion/check time, so menu changes affect the next check without restarting tracking. Missing models or authentication fail visibly, never silently switch providers. The checker inherits the current thinking preference, clamped to its model's capabilities. Its model selection does not change the main session's model.

Automatic checks incur a separate model run and disclose the current plan snapshot, scoped implementation user messages, and inspected transcript evidence to the selected provider. Use `verification.automatic: false` to disable automatic checks; `/plan verify` remains available. Every verification exit returns to actual normal mode with a detached/completed record. Results never appear in the footer.

Missing settings return defaults without creating a file. There is no watcher: new workflows read current defaults; an existing planning workflow keeps its captured settings. Changing defaults does not change a running planning workflow's tools or move its saved files. Use `/plan tools` while idle for an explicit planning-workflow-local tool change. In normal mode that command configures future planning only, without entering planning or altering active tools; during implementation it may update the isolated checker selection only.

## Early naming request

Naming is separate from planning and runs early once task text is available. Its input is **only task text, at most 4,000 characters**—no tools, repository/context files, conversation history, or plan body. It allows at most **128 output tokens**, times out after **10 seconds**, and uses the lowest reasoning level supported by its model. These limits are not a progress-observer budget or a reason to send additional planning context.

The resulting stem is normalized to lowercase kebab case and at most **64 characters**. A deterministic fallback handles timeout, request failure, unavailable model/credentials, or unusable output; naming does not silently switch providers. Numeric collision suffixes protect existing plans. The name is stable after allocation, and **no plan file exists until save**. A repeated completion updates that same file rather than generating a new name.

`settings.naming.model` (the JSON `naming.model` key above) overrides only naming. With no override, naming uses the configured progress model, whose default is `openai/gpt-6-luna`. **Naming model** can select or reset the override. It never changes the main agent, checker, progress model, or progress reasoning. `progress.thinkingLevel` is not inherited by naming; there is no separate naming-reasoning menu.

**Cost and privacy:** the naming call is an additional provider request, potentially incurred before the user saves anything. Its provider receives the bounded task text only. Choosing a different naming provider can send that task to a different data-policy boundary. A deterministic fallback does not retroactively undo a request already sent. Naming is not repository inspection and does not create or authorize plan or project mutations.

## Keyboard toggle

Alt+M is enabled by default. It enters planning like `/plan start`, or leaves planning (including a ready plan) and restores the previous tools. It never opens review or starts implementation, sends no model message, and preserves your editor draft and saved files. Leaving ends the current workflow; use `/plan saved` to continue a saved plan. Busy agents, queued messages, and open Plan commands prevent toggling rather than scheduling it for later.

`shortcuts.togglePlan` accepts Pi key syntax, normalized for case, modifier order, and key aliases. Set it to another key string to rebind, `null` to disable, or remove it to restore the default. This setting is file-only and loaded once during extension initialization: run `/reload` or restart after editing, and inspect `/hotkeys`. Other settings retain their existing read timing. An invalid startup settings file leaves commands/tools registered but disables shortcut registration and reports the error when a UI is available; correct the file and reload.

The default does not conflict with standard Pi bindings. Custom bindings and other extensions can conflict; Pi decides precedence and reports conflicts. This package never edits global keybindings or bypasses reserved actions.

To choose Shift+Tab, set `"shortcuts": { "togglePlan": "shift+tab" }` in this file, and merge `"app.thinking.cycle": []` into `<getAgentDir()>/keybindings.json`, preserving unrelated fields. Alternatively remap the native cycle action. Without that step Pi rejects the extension shortcut because Shift+Tab is reserved. No global change is needed for Alt+M.

Ctrl+M is rejected because it aliases Enter and Pi's matcher can consume normal prompt submission. Main-agent reasoning-effort controls are separate; the progress-reasoning setting affects only the observer. Dialog navigation and paste continue through Pi's native input handling; RPC and noninteractive modes use commands.

## Plan storage and legacy locations

The single-file workflow preserves the configured storage location; naming is not a storage migration. A supported workflow retains its captured path through continuation, implementation, status recovery, and updates. A plan is stored as, for example:

```text
<configured-plan-directory>/support-uploading-images.md
```

The repo-name default remains `<agent-dir>/pi-plan-mode/<repo>/`. The repo folder is the safe normalized basename of the canonical Git top-level directory, or canonical cwd outside Git. Same-named checkouts intentionally share this default. Worktrees use their own top-level directory names.

An independent plan with the same name gets a numeric suffix, such as `support-uploading-images-2.md`. This is collision disambiguation, not a revision number. There are no date prefixes, revision series, ancestry, change reasons, or revision selectors. The first save creates one file; subsequent saves atomically replace it at the same path. Status/recovery reads disk, and hash-based stale-read conflicts reject updates before overwriting newer content. No file is created by naming alone.

The retired `plansDirectory` field is not a new naming/storage redirection setting. Retained legacy location hints do not enable legacy browsing or continuation. There is no storage-subdirectory menu. This change does not move, rename, delete, or silently migrate files, nor does it search every historic subdirectory or other checkouts' old hashed locations.

Workflows and plan-document envelopes use **version 3**. Legacy workflow state is rejected without modifying files, including when its old captured path is still present. Legacy numbered revision documents are excluded from `/plan saved`; the browser lists current-format named plans, not revision series. To reuse plain or legacy content, start fresh with `/plan start` and paste Markdown body text into the planning conversation, without its envelope. There is no import, migration, or legacy adoption; review still requires an explicit implementation choice.

Storage path validation remains a security boundary: relative location values use `/` separators and must be nonempty, without absolute paths, backslashes, NUL, empty components, or `.`/`..` components. All storage directories beneath the agent-directory anchor must be real directories, not symlinks. Captured paths are not arbitrary export permissions. An explicit import source is read-only input, not a grant to overwrite that source or change the destination storage policy.

## Tool selection and trust

Without `tools`, Plan mode selects available canonical built-in `read`, `grep`, `find`, and `ls`. A custom override with the same name is not canonical. The registered `plan_mode_question`, `plan_mode_complete`, and `plan_mode_edit` helpers are always required; do not add them manually.

Explicit `tools` replaces the optional defaults rather than adding to them. Names must be nonempty strings; duplicates are removed in first-seen order. Names are exact: namespace names, wildcards, and Pi's `+name`/`-name` settings syntax are not expanded here.

For example, this trusts a codemode orchestrator and one MCP callee in addition to `read`:

```json
{
  "tools": ["read", "codemode", "mcp__docs__read"]
}
```

Each nested callee must be selected separately. Planning saves (`plan_mode_complete` and `plan_mode_edit`) are an exception: call them directly and alone, not nested or batched, so Pi can terminate the turn. During tracked implementation, `plan_mode_edit` may be nested and does not terminate. Direct and `model-only` tools are activated for planning; registered `codemode` and `deferred` tools are allowed without forcing direct activation. Pi's own exposure rules still apply, including the prohibition on nested calls to `model-only` tools. Unknown or hidden tools are unavailable, not implicitly registered or made reachable.

The selector retains unavailable configured names and warns that they may become available later. Edit the JSON or reset defaults to remove those retained names. This is not a first-request frozen policy: permissions are resolved against current tool metadata, and users can change the planning selection between turns with `/plan tools`.

The allowlist is **planning-only**. Normal and implementation tool availability remains untouched by that restriction. Leaving planning restores preexisting tool availability **before** enabling implementation helpers. You do not need to enable registered built-in search tools separately in Pi merely to use them in Plan mode. Helpers are inactive outside their applicable workflow.

During implementation, `/plan tools` may change the isolated checker selection without restricting the main agent's implementation tools. The checker enforces its own read-only policy; starting, completing, failing, or cancelling a check never changes parent tool availability. Checking requires `read` to access the private transcript artifact. The fresh child recreates selected tool sources and verifies their provenance/exposure; unavailable or non-reproducible SDK-only tools fail visibly. Workflow-control helpers are not given to the checker. See [adherence checks](./adherence-checks.md).

**Trust warning:** selecting nondefault tools—including `bash`, `powershell`, `write`, or a core-name override—trusts their implementation and arguments. There is no shell parser, command filter, or automatic side-effect analysis. The default planning prompt instructs the planner not to mutate the project, but trusted tools can execute code or modify local and external state. Read-only annotations are hints, not guarantees. Plan mode is not an OS sandbox and does not prevent disclosure of data Pi can read. The checker's separate read-only policy likewise does not sandbox loaded code at the operating-system level.

### Background artifact tools

With `pi-artifacts` loaded, the recommended selection is:

```json
{
  "tools": ["read", "grep", "find", "ls", "artifact_create", "artifact_update", "artifact_status", "artifact_wait", "artifact_cancel"]
}
```

Select all five artifact tools so delegated work has wait/cancel management. They do
not enable parent `write`, `edit`, or `bash`. Plan mode enforces its workspace and
associated identifiers, and refuses ready saves while jobs are pending. A failed
artifact must be retried or explicitly omitted by the user with
`/plan artifacts omit <jobId>`. Artifact tools are excluded from checker identities,
source loading, and execution even when selected here.

Supported captured prompts keep their safety snapshots. Start a new workflow with
the updated default or update a full replacement prompt explicitly to authorize
selected artifact delegation and require waiting before completion. Live artifacts
are not historical snapshots; see the package README before opening generated HTML.
Generated HTML remains untrusted browser content.

## Persistence and invalid files

Settings reads are bounded to 64 KiB and require valid UTF-8 and a JSON object. Invalid values, malformed JSON, directories, and symlinks are rejected. A workflow that cannot read valid settings does not silently substitute defaults; correct or remove the invalid file before retrying. A valid configuration whose naming request fails uses the deterministic naming fallback; this does not excuse invalid settings.

Updates reread and validate the existing document, preserve unknown fields, and publish atomically through a temporary file. Updates are ordered within one Pi process, but there is no cross-process settings lock. An invalid existing document is not overwritten to repair it implicitly.

`tools`, `verification`, `progress`, `naming`, and `shortcuts.togglePlan` configure current behavior. Retired top-level thinking, model, shortcut (including `toggleShortcut`), reinjection, shell, and export keys are not interpreted. Unknown fields remain in the document. The unrelated old `plan-mode.json` filename is not read; legacy-state rejection does not migrate settings from that file. The settings document is distinct from version 3 workflow state and plan-document envelopes; legacy workflow rejection never rewrites old plan files.

## Plan style and user instructions

By default, every completed implementation plan should include a short approximate range of changed lines, counting **additions plus deletions** across source, tests, and documentation—not net file growth. Avoid false precision and mandatory per-file accounting. Update the estimate when an edit materially changes scope. This is planning guidance only: completion does not parse plans or reject a missing estimate, and a custom prompt can omit it.

Two optional files under `getAgentDir()` (normally `~/.pi/agent`, respecting `PI_CODING_AGENT_DIR`) control the planning text:

| File | Role |
| --- | --- |
| `pi-plan-mode-prompt.md` | Nonblank content replaces the entire built-in extension planning prompt. Missing or whitespace-only selects the built-in default. |
| `pi-plan-mode.md` | Appends optional guidance to whichever base prompt was selected. Missing or blank adds nothing. |

Both are plain UTF-8 Markdown, not JSON, with a **64 KiB per-file** limit and regular-file checks. Reads are bounded; invalid UTF-8, oversized/nonregular files, and read errors block activation with the offending path rather than silently falling back. Markdown is not expanded; only surrounding whitespace is trimmed. Ordinary reads never create files. `/plan settings` → **Edit planning prompt** opens the replacement in Pi's editor in TUI or RPC mode, creating a missing file from the built-in default first. Existing blank files remain blank. Submit to save atomically, or cancel to leave the file unchanged; a newly created template remains on cancellation. Invalid files are not overwritten, and edits detected on disk while the editor is open block saving. Changes affect new workflows only. There is no watcher or project-local override.

### Appended guidance

Existing `pi-plan-mode.md` files retain their appended-guidance role. Write conditional prose when guidance applies only to some repositories:

```markdown
For repositories with event-sourced models, explain material event-schema changes
and the conceptual migration strategy. Keep routine propagation details brief.
```

The built-in prompt first grounds decisions in repository evidence. Plans should explain consequential choices, non-obvious work, and focused verification for an equally capable implementer without the planning conversation. They need not enumerate routine mechanics or follow a fixed exhaustive outline. Specific requests for detail override generic brevity, but appended guidance cannot authorize mutations or bypass the selected planning prompt's safety rules or question/completion/edit protocol.

### Full prompt replacement

Use [`src/prompt.ts`](../src/prompt.ts) as the built-in starting point for customization. A nonblank `pi-plan-mode-prompt.md` replaces all built-in planning methodology, safety prose, turn/completion instructions, and the estimate convention. No built-in methodology or estimate requirement is silently retained. The extension still appends the current saved plan path when one exists so the editor can target it. When both files exist, the replacement is the base and `pi-plan-mode.md` is appended. The active planning banner is **PLAN MODE ACTIVE**.

**Custom prompt authors must supply their desired read-only planning and question/completion/edit protocol instructions.** Both planning save helpers must be called directly and alone as the final action: successful completion or editing marks the plan ready and ends the turn. Replacement affects only the extension-owned `pi_plan_mode` system section, not Pi's overall system prompt, project instructions, or tool declarations. Runtime permissions, completion validation (including existing length limits), and explicit initial implementation approval remain enforced by code. Implementation plan edits update the same file without another approval dialog. Trusted tools can still have side effects; this is not a sandbox.

### Snapshots and reset

The selected base prompt (including the built-in default when selected) and appended guidance are captured when a new workflow starts and persisted with it. Ordinary turns, follow-ups, updates, supported session restoration, tree navigation, and compaction use these snapshots, not later file edits. Continuing a saved plan from outside an active workflow starts a new workflow and captures current files while keeping that plan's path.

Legacy workflow entries are rejected rather than restored using a prompt fallback. Explicit import creates a new independent workflow using current prompt files; it does not recover old snapshots or approval.

To reset to the built-in base, remove or empty `pi-plan-mode-prompt.md`; also remove or empty `pi-plan-mode.md` to remove appended guidance. Exit planning and start a new workflow for these changes to take effect. Reloading or resuming an existing supported workflow does not reset its snapshots. The tool-default reset menu does not modify these files.

Both snapshots are sent to the model and stored in the session. Do not put secrets in them. They are not sent to the separate naming request.

## Mode display

The footer uses exactly `[Normal]`, `[Planning]`, `[Planning stem]`, `[Implementing stem]`, or `[Verifying stem]`, where `stem` is the actual filename without `.md`. Unnamed planning uses `[Planning]`; a ready plan remains `[Planning stem]`. There are no footer command hints or verification results. Reported progress stays in its separate panel above the editor. Every verification exit returns to actual normal mode with `[Normal]` and a detached/completed implementation record, accessible explicitly through `/plan verify` or `/plan resume`. Starting new planning is independent.
