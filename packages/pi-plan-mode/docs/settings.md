# Plan mode settings

[Back to README](../README.md)

## File and menu

Use `/plan settings` while the agent is idle, or edit `<getAgentDir()>/pi-plan-mode.json` (normally `~/.pi/agent/pi-plan-mode.json`, with `PI_CODING_AGENT_DIR` respected).

The menu offers:

- **Default planning tools** — save an explicit tool selection for future workflows.
- **Default plan template** — choose the default template (`decision-brief`, `detailed-spec`, `checklist`, `minimal`, `ui`, or a custom user template) for future workflows.
- **Reset to strict inspection tools** — remove the override and use canonical built-in defaults.
- **Progress model** — independently choose the observer model or reset to `openai/gpt-6-luna`.
- **Progress reasoning** — choose a Pi thinking level or reset to `low`.
- **Naming model** — choose an independent naming provider/model or reset to the configured progress model.

Supported active settings include:

```json
{
  "tools": ["read", "grep", "find", "ls"],
  "shortcuts": { "togglePlan": "alt+m", "selectTemplate": "alt+shift+m" },
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
| `tools` | Omitted | Shared exact names of explicitly trusted Plan/Explain inspection tools. Omission uses canonical inspection defaults; `[]` permits only the required helpers. |
| `template` | `"decision-brief"` | Default plan template ID (`decision-brief`, `detailed-spec`, `checklist`, `minimal`, `ui`, or a user template in `pi-plan-mode-templates/<id>.md`). |
| `shortcuts.togglePlan` | `"alt+m"` | Cycle Normal → Explain → Plan → Normal (compatibility key retained). A Pi key string replaces the default; `null` disables it. Requires reload. |
| `shortcuts.selectTemplate` | `"alt+shift+m"` | Open the template picker for the active plan, or future defaults outside Plan mode. A Pi key string rebinds it; `null` disables it. Requires reload. |
| `progress.model` | `{ "provider": "openai", "id": "gpt-6-luna" }` | Independent transcript observer chat model; never falls back. |
| `progress.thinkingLevel` | `"low"` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, constrained to advertised model capabilities. |
| `naming.model` | Configured `progress.model` | Independent naming override as `{ provider, id }`; remove it to follow progress again. Naming uses the lowest supported reasoning level. |

Progress settings are resolved for each assessment while `/plan progress` is open. Remove either override (or use its menu default option) to reset it. They do not alter the main model. Effective reasoning constraints are shown in the panel. The supplied default is a desired identifier, not an availability guarantee. It must resolve as a chat model; a catalog/configuration exposing only a classifier with that identifier cannot produce this summary. Select an available chat model if necessary. Missing model/credentials, unsupported extension-only providers, and invalid settings produce a panel error and stop automatic retries; close and reopen after correcting them. The 30-second minimum assessment interval is not configurable. See [live progress](../README.md#live-reported-progress) for cost, privacy, evidence limitations and cancellation semantics.


Missing settings return defaults without creating a file. There is no watcher: new workflows read current defaults; an existing planning workflow keeps its captured settings. Changing defaults does not change a running planning workflow's tools or move its saved files. Use `/plan tools` to change a workflow's permissions immediately when idle or for the next model call while busy. In normal mode that command configures future planning only, without entering planning or altering active tools.

## Early naming request

Naming is separate from planning and runs early once task text is available. Its input is **only task text, at most 4,000 characters**—no tools, repository/context files, conversation history, or plan body. It allows at most **128 output tokens**, times out after **10 seconds**, and uses the lowest reasoning level supported by its model. These limits are not a progress-observer budget or a reason to send additional planning context.

The resulting stem is normalized to lowercase kebab case and at most **64 characters**. A deterministic fallback handles timeout, request failure, unavailable model/credentials, or unusable output; naming does not silently switch providers. Numeric collision suffixes protect existing plans. The name is stable after allocation, and **no plan file exists until save**. A repeated completion updates that same file rather than generating a new name.

`settings.naming.model` (the JSON `naming.model` key above) overrides only naming. With no override, naming uses the configured progress model, whose default is `openai/gpt-6-luna`. **Naming model** can select or reset the override. It never changes the main agent, progress model, or progress reasoning. `progress.thinkingLevel` is not inherited by naming; there is no separate naming-reasoning menu.

**Cost and privacy:** the naming call is an additional provider request, potentially incurred before the user saves anything. Its provider receives the bounded task text only. Choosing a different naming provider can send that task to a different data-policy boundary. A deterministic fallback does not retroactively undo a request already sent. Naming is not repository inspection and does not create or authorize plan or project mutations.

## Keyboard toggle

Alt+M is enabled by default. It cycles Normal → Explain → Plan → Normal, removing the execution gate when leaving Plan (including a ready plan). Explain → Plan carries the selected tools forward. It never opens review or starts implementation, sends no model message, and preserves your editor draft and saved files. Leaving ends the current workflow; use `/plan saved` to continue a saved plan. When busy, repeated toggles cycle from the pending selection; the last choice applies after the current tool batch. An already open Plan command still prevents toggling.

Alt+Shift+M opens the same picker as `/plan template`, marking the current selection. Unlike the mode toggle, the template shortcut requires an idle agent and no open command. Cancelling or selecting an unchanged active template leaves the workflow untouched; selecting another template after saving requests a same-file rewrite. Outside Plan mode it changes future defaults without changing the current mode.

`shortcuts.togglePlan` and `shortcuts.selectTemplate` accept Pi key syntax, normalized for case, modifier order, and key aliases. Set it to another key string to rebind, `null` to disable, or remove it to restore the default. This setting is file-only and loaded once during extension initialization: run `/reload` or restart after editing, and inspect `/hotkeys`. Other settings retain their existing read timing. An invalid startup settings file leaves commands/tools registered but disables shortcut registration and reports the error when a UI is available; correct the file and reload.

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

Without `tools`, Plan and Explain select available canonical built-in `read`, `grep`, `find`, and `ls`. A custom override with the same name is not canonical. The registered `plan_mode_question`, `plan_mode_complete`, and `plan_mode_edit` helpers are always required; do not add them manually.

Explicit `tools` replaces the optional defaults rather than adding to them. Names must be nonempty strings; duplicates are removed in first-seen order. Names are exact: namespace names, wildcards, and Pi's `+name`/`-name` settings syntax are not expanded here.

For example, this trusts a codemode orchestrator and one MCP callee in addition to `read`:

```json
{
  "tools": ["read", "codemode", "mcp__docs__read"]
}
```

Each nested callee must be selected separately. Planning saves (`plan_mode_complete` and `plan_mode_edit`) are an exception: call them directly and alone, not nested or batched, so Pi can terminate the turn. During tracked implementation, `plan_mode_edit` may be nested and does not terminate. Selecting ordinary direct and `model-only` tools does not activate them; registered `codemode` and `deferred` tools are allowed without forcing direct activation. Pi's own exposure rules still apply, including the prohibition on nested calls to `model-only` tools. Unknown or hidden tools are unavailable, not implicitly registered or made reachable.

The selector retains unavailable configured names and warns that they may become available later. Edit the JSON or reset defaults to remove those retained names. This is not a first-request frozen policy: permissions are resolved against current tool metadata, and users can change the planning selection between turns with `/plan tools`.

The allowlist applies in **Plan and Explain only**. Explain always excludes plan-writing and implementation helpers, even if explicitly selected; only `plan_mode_question` is required. `/plan tools` changes the current Explain selection and `/plan settings` changes shared future defaults. Normal and implementation tool availability remains untouched by that restriction. Leaving planning never restores an earlier tool set. To call an inactive built-in search tool directly, enable it in native Pi as well (for example, `pi --tools +grep,+find,+ls`). Helpers are inactive outside their applicable workflow.


**Trust warning:** selecting nondefault tools—including `bash`, `powershell`, `write`, or a core-name override—trusts their implementation and arguments. There is no shell parser, command filter, or automatic side-effect analysis. The default planning prompt instructs the planner not to mutate the project, but trusted tools can execute code or modify local and external state. Read-only annotations are hints, not guarantees. Plan mode is not an OS sandbox and does not prevent disclosure of data Pi can read.

Explain has no artifact workspace, associations, readiness checks, or generation guidance. Selecting artifact tools does not create planning ownership; operations requiring it may fail. Explain instructions prohibit mutations and plan creation even through trusted tools.

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
`/plan artifacts omit <jobId>`.

When artifact tools are selected, the prompt adds their workspace and readiness rules:
use associated artifacts, wait before using results or saving, and retry failures or
obtain explicit omission approval. Templates can describe when and how to use artifacts.
Live artifacts are not historical snapshots; see the package README before opening generated HTML.
Generated HTML remains untrusted browser content.

## Persistence and invalid files

Settings reads are bounded to 64 KiB and require valid UTF-8 and a JSON object. Invalid values, malformed JSON, directories, and symlinks are rejected. A workflow that cannot read valid settings does not silently substitute defaults; correct or remove the invalid file before retrying. A valid configuration whose naming request fails uses the deterministic naming fallback; this does not excuse invalid settings.

Updates reread and validate the existing document, preserve unknown fields, and publish atomically through a temporary file. Updates are ordered within one Pi process, but there is no cross-process settings lock. An invalid existing document is not overwritten to repair it implicitly.

`tools`, `template`, `progress`, `naming`, `shortcuts.togglePlan`, and `shortcuts.selectTemplate` configure current behavior. Retired top-level thinking, model, shortcut (including `toggleShortcut`), reinjection, shell, and export keys are not interpreted. Unknown fields remain in the document. The unrelated old `plan-mode.json` filename is not read; legacy-state rejection does not migrate settings from that file. The settings document is distinct from version 3 workflow state and plan-document envelopes; legacy workflow rejection never rewrites old plan files.

## Plan templates and user instructions

The complete prompts are shipped as [`prompts/plan.md`](../prompts/plan.md) and [`prompts/explain.md`](../prompts/explain.md). They are loaded as files and are not assembled from fragments or interpolated. The plan prompt covers workflow safety, permitted tools, questions, saving, and approval, and tells the model to follow the template appended after it: include **every section in order** and follow its HTML comments. There is no shared multi-phase investigation process or mandatory brevity/detail policy.

The built-in templates request a rough range of changed lines, counting **additions plus deletions** across source, tests, and documentation—not net file growth. Their comments also ask for updates when scope changes materially and discourage false precision or mandatory per-file accounting. Custom templates control their own requirements; the shared prompt no longer imposes line estimates. These are model instructions, not completion validation rules.

Explain uses the complete `prompts/explain.md` file and never reads the plan prompt, templates, or planning guidance files. There is no Explain prompt customization UI.

Plan structure and additional guidance are configured under `getAgentDir()` (normally `~/.pi/agent`, respecting `PI_CODING_AGENT_DIR`):

| Path | Role |
| --- | --- |
| `pi-plan-mode-templates/<id>.md` | Defines a custom user template or overrides a built-in template with the same lowercase kebab-case `<id>`. |
| `pi-plan-mode.md` | Appends optional guidance unchanged after the plan prompt and selected template. Missing or blank adds nothing. |

### Built-in and custom templates

Built-in templates are shipped as Markdown in [`templates/`](../templates/), not embedded in TypeScript. Each has a YAML frontmatter header (`label`, `description`) for picker metadata, followed by the exact Markdown skeleton of the finished plan: a task-specific title placeholder, real section headings, and HTML comments defining section semantics and limits. Frontmatter is excluded from the model-visible template body. The built-ins are:

- `decision-brief` (**default**) — concise decision brief (`## Overview`, `## Key Decisions & Architecture`, `## Non-Obvious Changes`, `## Verification`).
- `detailed-spec` — concrete file-by-file and interface-level specification (`## Overview`, `## Affected Files & Interfaces`, `## Implementation Steps`, `## Edge Cases & Invariants`, `## Verification`).
- `checklist` — milestone/component-grouped actionable `- [ ]` checklist (`## Overview`, `## Implementation Checklist`, `## Verification`).
- `ui` — [compare the running UI with a proposed mockup](../README.md#compare-a-screenshot-with-a-mockup).
- `minimal` — compact plan for small, focused changes (`## Goal & Approach`, `## Changes`, `## Verification`).

To create a custom template or override a built-in one, place a UTF-8 Markdown file (up to **64 KiB**, including the header) at `<getAgentDir()>/pi-plan-mode-templates/<id>.md`. For example:

```markdown
---
label: Small change
description: Focused plan with a short overview
hooks:
  on_implementation_complete:
    - name: Release notes
      type: subagent
      remove_tools: [edit, write, bash]
      prompt: |-
        Summarize the implemented changes for the release notes. Do not edit files.
---

# [Plan title]
<!-- Replace with a concise, task-specific title. -->

## Overview
<!-- Short overview of the changes to be made. At most 250 characters. -->

## Changes
<!-- List essential changes by path. -->

## Verification
<!-- Give verification commands and a rough range of changed lines, counting additions plus deletions. -->
```

The planner includes every section, preserves headings and order, replaces placeholders with task-specific content, and follows the HTML comments without copying them into the finished plan. Put overall investigation methods in a comment near the title and section-specific methods and content rules under each heading. Checklist templates may explicitly request repeated groups or items. These are model instructions, not a hard character-count or document-schema validator.

The header is optional. `label` and `description` must be nonblank strings when supplied. Migrate the former top-level `on_implementation_complete` string into a named list item as above. Previously captured workflows retain their old task as one named check. A missing closing delimiter, malformed YAML, or empty body is rejected. Headerless templates remain supported.

Each check requires a nonblank `name`, literal `prompt` (not a shell or slash command), and `type: subagent`. Unknown events, types and check fields are template errors. Optional `model` (`provider/model`) and `effort` (a Pi thinking level) otherwise inherit from the parent. `remove_tools` subtracts names from this worker’s delegable tools; it cannot grant access. An unavailable model, unsupported effort or missing compatible Herdr worker is a runtime failure for that check, not a template error.

The selected template’s checks are captured; later template edits do not affect the workflow. Only implementation completion runs them, after returning to Normal. Omitted hooks or an empty list make no worker requests. Otherwise each potentially billable worker receives its prompt and the complete current saved plan, not the conversation, implementation transcript or sibling results. Up to four checks run concurrently; remaining checks queue. Results appear once in declaration order. Failures are advisory and never trigger retries, fixes or a follow-up request. Use `/plan resume` for more implementation work. Old `verification` settings are ignored and preserved.

Use **Alt+Shift+M**, `/plan template`, or `/plan template <id>` during an active planning workflow to switch templates on the fly. If a plan has already been saved in the current workflow, switching templates immediately transitions back to planning and sends a user request instructing the planner to rewrite the current plan into the new template format using `plan_mode_complete` at the same file path.

### Appended guidance

Existing `pi-plan-mode.md` files retain their appended-guidance role. Write conditional prose when guidance applies only to some repositories:

```markdown
For repositories with event-sourced models, explain material event-schema changes
and the conceptual migration strategy. Keep routine propagation details brief.
```

Specific requests for detail override generic brevity, but appended guidance cannot authorize mutations or bypass the core planning prompt's safety rules or question/completion/edit protocol.

### Snapshots and reset

The selected template and appended guidance (`pi-plan-mode.md`) are captured when a workflow starts (or when `/plan template` switches the active template) and persisted with the workflow. Ordinary turns, follow-ups, updates, supported session restoration, tree navigation, and compaction use these snapshots, not later disk edits.

Both snapshots are sent to the model and stored in the session. Do not put secrets in them. They are not sent to the separate naming request.

Reloading this update intentionally replaces the shared multi-phase prompt with the short template-directed rules; captured template bodies and user guidance remain unchanged. Start a new workflow or explicitly reselect an updated template to capture its new method comments. Within an extension version, ordinary turns retain the same prompt prefix.

## Mode display

The footer uses `[Normal]`, `[Explain]`, `[Plan <template>]`, `[Plan <template>] stem`, or `[Implementing stem]`. Completion returns to `[Normal]`; reported progress stays in its own panel.
