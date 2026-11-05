# Plan mode settings

[Back to README](../README.md)

## File and menu

Use `/plan settings` while the agent is idle, or edit `<getAgentDir()>/pi-plan-mode.json` (normally `~/.pi/agent/pi-plan-mode.json`, with `PI_CODING_AGENT_DIR` respected).

The menu offers:

- **Default planning tools** — save an explicit tool selection for future workflows.
- **Reset to strict inspection tools** — remove the override and use canonical built-in defaults.
- **Plans subdirectory** — change where future workflows store their revisions.
- **Automatic adherence checks** — on by default; off disables the completion-triggered checker.
- **Adherence checker model** — select a provider/model or reset to the current main-session model.

These are the only supported settings:

```json
{
  "plansDirectory": "plans",
  "tools": ["read", "grep", "find", "ls"],
  "verification": {
    "automatic": true,
    "model": { "provider": "provider-id", "id": "model-id" }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `plansDirectory` | `"plans"` | Relative storage subdirectory under `<getAgentDir()>/pi-plan-mode`. |
| `tools` | Omitted | Exact names of explicitly trusted planning tools. Omission uses canonical inspection defaults; `[]` permits only the required helpers. |

| `verification.automatic` | `true` | Run a fresh adherence check on explicit implementation completion. Explicit `false` is preserved. |
| `verification.model` | Omitted | Use the current main-session model at check time, or an explicit `{ provider, id }`. |

Verification defaults are read at completion/check time, so menu changes affect the next check without restarting tracking. Missing models or authentication fail visibly, never silently switch providers. The checker inherits the current thinking preference, clamped to its model's capabilities. Its model selection does not change the main session's model.

Automatic checks incur a separate model run and disclose scoped implementation user messages and inspected transcript evidence to the selected provider. Use `verification.automatic: false` to disable automatic checks; `/plan verify` remains available.

Missing settings return defaults without creating a file. There is no watcher: new workflows read current defaults; an existing workflow keeps its captured settings. Changing defaults does not change a running workflow's tools or move its saved files. Use `/plan tools` while idle for an explicit workflow-local tool change.

## Storage subdirectory

The default layout is:

```text
<agent-dir>/pi-plan-mode/plans/<project-key>/<title>-01.md
```

For example, `"plansDirectory": "design/plans"` stores revisions beneath `<agent-dir>/pi-plan-mode/design/plans/<project-key>/`.

Use a nonempty relative path with `/` separators. Storage rejects absolute paths, backslashes, NUL, empty components, and `.` or `..` components. Storage directories beneath the agent-directory anchor must be real directories, not symlinks. This setting is not an arbitrary export path.

The project key derives from the canonical Git root, or the canonical working directory when no Git root is available. It combines a readable directory name with a path hash. Copies at different paths therefore have different plan collections.

Changing the subdirectory redirects future workflows and the saved-plan browser; it does not relocate existing revisions. An already active workflow continues using its captured location. Switch the setting back to browse plans in a previous location.

## Tool selection and trust

Without `tools`, Plan mode selects available canonical built-in `read`, `grep`, `find`, and `ls`. A custom override with the same name is not canonical. The registered `plan_mode_question` and `plan_mode_complete` helpers are always required; do not add them manually.

Explicit `tools` replaces the optional defaults rather than adding to them. Names must be nonempty strings; duplicates are removed in first-seen order. Names are exact: namespace names, wildcards, and Pi's `+name`/`-name` settings syntax are not expanded here.

For example, this trusts a codemode orchestrator and one MCP callee in addition to `read`:

```json
{
  "plansDirectory": "plans",
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

Only `plansDirectory`, `tools`, and `verification` have an effect. Retired top-level thinking, model, shortcut, reinjection, shell, and export keys are not interpreted. Unknown fields may remain in the document, but there is no compatibility or migration path, and the old `plan-mode.json` filename is not read.

## Plan style and user instructions

Optional `<getAgentDir()>/pi-plan-mode.md` adds user-wide planning guidance. It is plain UTF-8 Markdown, not JSON, and has a 64 KiB limit. There are no per-project profiles in this feature; write conditional prose when guidance applies only to some repositories:

```markdown
For repositories with event-sourced models, explain material event-schema changes
and the conceptual migration strategy. Keep routine propagation details brief.
```

The planner first grounds decisions in repository evidence. Plans should explain consequential choices, non-obvious work, and focused verification for an equally capable implementer without the planning conversation. They need not enumerate routine mechanics or follow a fixed exhaustive outline. Specific requests for detail override generic brevity, but guidance cannot authorize mutations or bypass the question/completion protocol.

Guidance is read once when a new workflow starts and saved with that workflow. Follow-ups, revisions, and restored workflows use the captured guidance, not later edits to the file. Missing or blank guidance adds nothing; read errors, invalid UTF-8, or oversized content block activation. There is no watcher or built-in editor for it.

Guidance is sent to the model and stored in the session. Do not put secrets in it.
