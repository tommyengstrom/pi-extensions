# Implementation adherence checks

[Back to README](../README.md)

## What is checked

`/plan verify` checks the implementation associated with the current session, including after resume, completion, or `/plan exit`. It does not guess a plan from prose or choose the most recent saved file. Resume the implementation's session or start implementation through document review if no record exists.

The baseline is exactly the revision reviewed for implementation. Every subsequent revision in that implementation's active ancestry participates in the check. The checker examines repository evidence independently and reconciles it with those plans and implementation-phase user requests.

Reports distinguish:

- **Adherent** — recorded requirements and user changes are accounted for, with sufficient evidence.
- **Deviations found** — implementation differences, unsupported scope changes, or missing plan updates.
- **Inconclusive** — insufficient evidence or inspection limitations.

Execution failures, cancellation, missing/tampered history, and malformed model output are not passing checks. General style, correctness, and security review are outside scope unless a finding directly establishes plan nonadherence. A reason alone does not authorize a scope change. A user-requested change implemented without updating the plan is a plan-update failure, not necessarily agent drift.

The report includes file/location evidence, revision references, user-message citations, recorded reasons when available, authorization evidence, and limitations. Reasons are optional: absence alone is not a deviation, and the checker must not invent one. It is an observation of the working tree at check time—not a permanent guarantee. It never starts an automatic repair loop.

## Completion and further changes

Tracked implementation exposes `plan_mode_edit` (localized changes), `plan_mode_update` (complete plan with an optional reason), `plan_mode_implementation_status` (read the authoritative current plan after compaction), and `plan_mode_implementation_complete` (standalone completion signal). The main agent keeps its normal tools. Persistent instructions require saving user-requested plan changes before implementing them, but there is no hard gate after every message. An LLM assessment cannot guarantee recognition of every natural-language request.

`plan_mode_edit` uses exactly Pi's `{path, edits: [{oldText, newText}]}` input, without a reason field, and targets only the current active revision. It preserves the source and saves a new numbered revision in the same series, advancing tracking without changing the approved baseline or losing ancestry. It returns a diff and new path, not the full plan; subsequent edits use that path. During implementation it continues work without termination or a new approval dialog. Agent-discovered material scope changes still need user authorization. In planning, by contrast, edit is a standalone final action that marks the plan ready and ends the turn. Initial plans and broad planning rewrites still use `plan_mode_complete` with the full plan and an optional reason.

Automatic checking is **on by default**, using the main session's current model at check time. `/plan settings` can select another checker model or disable automatic checking. Explicit completion then records “not checked”; manual verification is still available.

After completion or exit, run **`/plan resume` before sending fixes or changes**. This explicitly opens another implementation segment, clears the current-check status, and avoids including unrelated intervening discussion. Resume itself does not send a model request. `/plan tools` changes the checker tools without narrowing implementation tools.

TUI manual checks show a cancellable dialog and progress status. RPC uses supported dialogs/status messages. Print/JSON checks do not require a dialog. `/plan cancel`, cancellation of an automatic tool run, new main-agent work, tree navigation, session replacement, reload, and shutdown invalidate ongoing checks and suppress stale results.

## Diagnosing failed checks

Checker-run failures report the stage, provider/model, turns started, permitted tool calls attempted, last assistant stop reason, and last inspection/failed tool when available. Provider error details are retained as bounded, terminal-safe text in the error recorded by the check; the full child conversation is still not persisted. These diagnostics distinguish caller cancellation, a provider-aborted response, missing responses, the 60-turn and 200-tool-call limits, and invalid reports. Tool-source loading failures identify the extension and its load error.

Malformed report diagnostics give the validation failure and response length without copying report or transcript excerpts. Invalid output that ends at the model's output-token limit points to choosing a checker model with more output capacity. Fix the reported provider/tool configuration issue or choose another checker model in `/plan settings`, then retry `/plan verify`. A failed check is not an implementation-deviation finding.

## Fresh checker and transcript boundary

Each check uses a new in-memory SDK session, not a conversation fork. Its initial task contains:

1. The exact approved baseline and implementation revisions, with reasons where recorded.
2. All implementation-phase user messages on the active branch, in chronological order.
3. A transcript index and path for on-demand inspection.
4. Normal project context instructions, such as `AGENTS.md`, and fixed adherence-check instructions.

The transcript is used primarily to identify user-originated plan changes and investigate why deviations occurred. The checker must inspect surrounding context before labeling a deviation requested, approved, explained-but-unapproved, or unexplained. Assistant assertions and summaries are not proof of user authorization or current implementation. Historical tool results are identified as historical evidence.

The transcript export includes assistant responses, readable recorded rationale, tool calls/results, and relevant extension messages within explicit implementation segments. It excludes earlier planning, unrelated/abandoned branches, other implementations, internal session state, inherited system prompts, and prior checker reports. Original branch messages survive compaction for export; compaction and abandoned-branch summaries are not substitutes for them. Explicit context edits/omissions are respected and reported as evidence limitations. Unsupported attachments and opaque/unrecorded reasoning are not fabricated.

Input provenance distinguishes interactive/RPC input from extension-generated user-role messages where known. Unknown provenance is labeled, not treated as proof of human approval. Source entry IDs remain in reports for citation after artifact cleanup.

The private temporary artifact is outside the repository, with restrictive filesystem permissions. It is cleaned up on success, failure, and cancellation. The full transcript is not injected upfront; permitted tools inspect it in chunks. If plans plus all upfront user evidence exceed the model's conservative context budget, checking fails visibly instead of silently omitting requests. Checks also have bounded turn/tool-call counts.

**Privacy:** scoped user messages and any transcript content the checker inspects are sent to the selected checker provider. Do not assume a different checker provider has the same data policy as the implementation provider. Historical content remains evidence, not live instructions to the checker.

## Tools and compatibility

The child recreates the workflow's selected inspection tools and verifies their provenance/exposure. It does not receive the question, plan-save, plan-edit, plan-update, implementation-status, or implementation-completion helpers. These helpers are inactive outside their applicable planning or tracked-implementation workflow; the checker is not such a workflow. Each nested tool call must be explicitly allowed; selecting an orchestrator does not authorize its callees. Model-only and deferred exposure rules remain in force.

The `read` tool is required to access the local transcript artifact. A custom `read` implementation must support reading that path. Missing tools, changed provenance/exposure, and SDK-only/dynamic tools that cannot be reconstructed fail visibly rather than broadening permissions or substituting canonical tools. Selected file-backed extension sources and supported built-in sources are loaded; unrelated ambient extensions/skills/templates are not discovered.

Explicitly trusting a shell, editing tool, or other nondefault planning tool still trusts its implementation. The checker is instructed not to mutate anything, but this is a workflow restriction, **not an OS sandbox or confidentiality boundary**. Loaded extension code has Pi's operating-system permissions.

New revisions store versioned parent/hash metadata and any supplied reason in a comment header atomically with the Markdown plan body. Existing optional reasons remain readable; absent reasons are neither required nor fabricated. Existing plain Markdown plans remain readable as baselines. Old sessions without implementation records cannot reconstruct an implementation from conversation heuristics. Saved plan files are not rewritten or migrated automatically.
