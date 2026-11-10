# Implementation adherence checks

[Back to README](../README.md)

## What is checked

`/plan verify` checks the implementation associated with the current session, including after resume, completion, or `/plan exit`. It does not guess a plan from prose or choose the most recent saved file. Resume the implementation's session or start implementation through document review if no record exists.

At check start, the checker reads the tracked named plan file from disk and snapshots its **current contents**. That snapshot is the **sole plan target**. There is no immutable approved baseline, revision ancestry, change-reason history, or enforcement against earlier approved text. A missing plan file is an explicit error; cached session contents and the originally reviewed text are not fallbacks. Later edits to the mutable file are not covered by the result: run `/plan verify` again to check the new contents.

The checker examines repository evidence independently against that snapshot. Scoped implementation user messages and transcript evidence provide context for requested work and observed deviations; they do not establish a second plan target or revive approved-ancestry enforcement.

Reports distinguish:

- **OK** (`ok`, green) — no actionable adherence issues found.
- **Minor issues** (`minor_issues`, yellow) — limited gaps, concerns, or nonblocking uncertainty.
- **Issues** (`issues`, red) — material missing requirements, contradictions, unauthorized changes, or inability to make a reliable assessment. The motivation distinguishes inability to verify from a proven implementation defect.

Execution failures, cancellation, unavailable required evidence, and malformed model output are not passing checks. General style, correctness, and security review are outside scope unless a finding directly establishes plan nonadherence. A user-requested change implemented without updating the current plan can be a plan-update failure, not necessarily agent drift. A saved edit alone does not establish user authorization for agent-discovered scope changes.

The report has exactly two fields: `status` and `motivation`. The motivation is free-form Markdown, displayed without rewriting its assessment or requiring particular headings. The checker explains its reasoning, cites relevant files and user requests where useful, and reports meaningful uncertainty. It does not require or invent change reasons. A recovered tool failure does not automatically change the verdict. The report is an observation of the working tree at check time against the captured plan contents—not a permanent guarantee or a verdict on later plan edits. It never starts an automatic repair loop.

The checker submits its result through the private `submit_adherence_report` tool, alone at top level. Its parameters use provider-side JSON Schema constrained sampling with `strict: require`; providers/models that cannot honor this fail visibly rather than silently falling back to prompt-only JSON. Local validation checks structure, not the relationship between the verdict and Markdown prose. Valid submissions terminate the checker; invalid submissions can be corrected within the existing run limits. Assistant prose is never accepted as a substitute. The tool exists only in the checker, not in the main session or the configurable inspection-tool selection.

TUI report headings use semantic success/warning/error colors. RPC and print/JSON retain the explicit status and full Markdown motivation without terminal color codes. Historical reports retain their text fallback; they do not become evidence that later file contents passed. Legacy workflow state is not restored merely because it contains an old check status. Results are displayed separately from the mode footer.

## Completion and further changes

Tracked implementation exposes `plan_mode_edit` (localized changes), `plan_mode_update` (complete plan replacement), `plan_mode_implementation_status` (read the authoritative current plan from disk, including after compaction), and `plan_mode_implementation_complete` (standalone completion signal). The main agent keeps its normal tools. Persistent instructions require saving user-requested plan changes before implementing them, but there is no hard gate after every message. An LLM assessment cannot guarantee recognition of every natural-language request.

`plan_mode_edit` uses exactly Pi's `{path, edits: [{oldText, newText}]}` input and targets only the current named plan. Each replacement must uniquely match a non-overlapping region. It updates the **same file**, preserving tracking rather than publishing another revision. It returns a diff and the same path, not the full plan. Complete replacements also keep that path. There are no reason fields, revision files, or approved ancestry to preserve.

Status/recovery rereads disk instead of presenting a stale cached plan as authoritative. Hash-based stale-read checks reject conflicting updates **before** overwriting newer contents. Reread and reconcile a conflict before retrying; a missing plan is an explicit error, not permission to regenerate it from a former baseline.

Initial implementation always requires explicit approval in document review. During implementation, plan edits continue work without termination or a new approval dialog. Agent-discovered material scope changes still need user authorization. In planning, by contrast, edit is a standalone final action that marks the plan ready and ends the turn. Initial plans and broad planning rewrites use `plan_mode_complete` with the full nonempty plan, at most 50,000 JavaScript characters. Planning save helpers cannot be nested or batched; implementation edits may be nested and do not terminate.

Automatic checking is **on by default**, using the main session's current model at check time. `/plan settings` can select another checker model or disable automatic checking. Explicit completion then records “not checked”; manual verification is still available. Ordinary prose and agent pauses do not trigger a check. Reports do not trigger automatic fixes or another main-agent response.

**Verification durably ends active implementation at check start**, before any asynchronous work. After capturing the implementation identity and branch-scoped transcript, it persists `phase: "completed"` and removes implementation-only helpers; ordinary parent tools remain unchanged. Completed tracking does not mean adherence passed: reports are separate. The owned checker still displays `[Verifying stem]`.

**Every verification exit returns to actual normal mode**, with a detached/completed implementation record. This includes successful reports, execution failures (including missing plan files), cancellation, and invalidation. It is not merely a footer change while implementation remains active. Use **`/plan verify`** explicitly to check that retained record again, or **`/plan resume` before sending fixes or changes**. Resume opens another tracked implementation segment, clears the current-check status, and avoids including unrelated intervening discussion. Resume itself does not send a model request. Starting new planning creates an independent workflow rather than implicitly resuming the record.

`/plan tools` during implementation may update only the isolated checker selection; it does not narrow implementation tools. In normal mode it configures future planning without changing active tool availability or entering planning. The planning allowlist is inactive in both normal mode and implementation. Preexisting availability is restored before implementation helpers are enabled.

TUI manual checks show a cancellable dialog and progress status. RPC uses supported dialogs/status messages. Print/JSON checks do not require a dialog. `/plan cancel`, cancellation of an automatic tool run, new main-agent work, tree navigation, session replacement, reload, and shutdown invalidate ongoing checks and suppress stale results. Restoring or reloading a branch containing the check-start boundary produces `[Normal]` without implementation helpers. Navigation cancels without writing through the abandoned workflow: another branch follows its own recorded state, including independently active implementation. Late checker results cannot overwrite replacement workflows or append reports. Checker tools are never imposed on the parent.

## Mode footer and progress

The coordinated mode footer uses exactly `[Normal]`, `[Planning]`, `[Planning stem]`, `[Implementing stem]`, and `[Verifying stem]`. Here `stem` is the current filename without `.md`, including any numeric collision suffix. `[Planning]` applies before naming; readiness for review remains `[Planning stem]`. Checking uses `[Verifying stem]`; every exit restores `[Normal]` and actual normal mode. Command hints and verification results never appear in the footer.

Reported implementation progress remains a separate panel above the editor, controlled by `/plan progress`. Verification closes it at start; inactive tracking cannot reopen an observer during checking or afterward until explicit `/plan resume`. It is transcript-only observation, not repository verification. `/plan cancel` cancels adherence checks only. Completion stops the observer with its last summary labeled **completed tracking; not verified**; leaving implementation and session/branch changes clear it, and resume does not reopen it automatically. See [live reported progress](../README.md#live-reported-progress) for timing, costs, privacy, and evidence boundaries.

## Diagnosing failed checks

Checker-run failures report the stage, provider/model, turns started, permitted tool calls attempted, last assistant stop reason, and last inspection/failed tool when available. Provider error details are retained as bounded, terminal-safe text in the error recorded by the check; the full child conversation is still not persisted. These diagnostics distinguish caller cancellation, a provider-aborted response, missing responses, the 60-turn and 200-tool-call limits, and invalid reports. Tool-source loading failures identify the extension and its load error.

A checker that ends without an accepted report submission fails explicitly; diagnostics do not copy report or transcript excerpts. A run that ends at the model's output-token limit points to choosing a checker model with more output capacity. Fix the reported provider/tool configuration issue or choose another checker model in `/plan settings`, then retry `/plan verify`. A failed check is not an implementation-deviation finding. If the plan file is missing or unreadable, resolve that explicit file error; the checker does not silently switch to another plan or reconstruct an approved baseline.

## Fresh checker and transcript boundary

Each check uses a new in-memory SDK session, not a conversation fork. Its initial task contains:

1. The current named plan contents snapshotted from disk at check start, as the only plan target.
2. All implementation-phase user messages on the active branch, in chronological order.
3. A transcript index and path for on-demand inspection.
4. Normal project context instructions, such as `AGENTS.md`, and fixed adherence-check instructions.

The transcript is used primarily to identify user-originated changes and investigate why deviations occurred. The checker must inspect surrounding context before labeling a deviation requested, approved, explained-but-unapproved, or unexplained. These contextual distinctions do not turn old plan text into a second baseline. Assistant assertions and summaries are not proof of user authorization or current implementation. Historical tool results are identified as historical evidence.

The transcript export includes assistant responses, readable recorded rationale, tool calls/results, and relevant extension messages within explicit implementation segments. It excludes earlier planning, unrelated/abandoned branches, other implementations, internal session state, inherited system prompts, and prior checker reports. Original branch messages survive compaction for export; compaction and abandoned-branch summaries are not substitutes for them. Explicit context edits/omissions are respected and reported as evidence limitations. Unsupported attachments and opaque/unrecorded reasoning are not fabricated.

Input provenance distinguishes interactive/RPC input from extension-generated user-role messages where known. Unknown provenance is labeled, not treated as proof of human approval. Source entry IDs remain in reports for citation after artifact cleanup.

The private temporary artifact is outside the repository, with restrictive filesystem permissions. It is cleaned up on success, failure, and cancellation. The full transcript is not injected upfront; permitted tools inspect it in chunks. If the plan snapshot plus all upfront user evidence exceed the model's conservative context budget, checking fails visibly instead of silently omitting requests. Checks also have bounded turn/tool-call counts.

**Privacy:** the plan snapshot, scoped user messages, and any transcript content the checker inspects are sent to the selected checker provider. Do not assume a different checker provider has the same data policy as the implementation provider. Historical content remains evidence, not live instructions to the checker. This request is separate from the early naming call, which receives only bounded task text, and from progress assessments, which have their own transcript budget.

## Tools and compatibility

The child has its **own read-only tool policy**, independent of the parent's active tools. It recreates the selected inspection tool sources and verifies their provenance/exposure. It does not receive the question, plan-save, plan-edit, plan-update, implementation-status, or implementation-completion helpers. These helpers are inactive outside their applicable planning or tracked-implementation workflow; the checker is not such a workflow. Every artifact tool is excluded from checker identities, source loading, and execution, even if selected for planning. The checker can inspect referenced artifact files but cannot generate artifacts.

Each nested tool call must be explicitly allowed in the child; selecting an orchestrator does not authorize its callees. Model-only and deferred exposure rules remain in force. Checker startup removes implementation-only helpers; completion, failure, and cancellation preserve ordinary parent tool availability. The planning allowlist is not reused as a parent-side restriction during verification or normal/implementation work.

The `read` tool is required to access the local transcript artifact. A custom `read` implementation must support reading that path. Missing tools, changed provenance/exposure, and SDK-only/dynamic tools that cannot be reconstructed fail visibly rather than broadening permissions or substituting canonical tools. Selected file-backed extension sources and supported built-in sources are loaded; unrelated ambient extensions/skills/templates are not discovered.

Explicitly trusting a shell, editing tool, or other nondefault planning tool still trusts its implementation. The checker's own read-only policy and instructions do not make arbitrary loaded extension code safe: there is no shell parser, command-level side-effect analysis, OS sandbox, or confidentiality boundary. Loaded extension code has Pi's operating-system permissions. Tool annotations are not verified permissions.

## Version 3 and explicit import

Workflows and plan-document envelopes are **version 3**, representing a single mutable named file. Legacy workflow state is rejected without modifying its files. Legacy revision files are excluded from the saved-plan browser; there is no automatic migration, ancestry reconstruction, or legacy baseline fallback. Old sessions without supported implementation records cannot reconstruct implementation from conversation heuristics.

Use `/plan import <Markdown path>` to read a legacy/plain Markdown document explicitly, strip any legacy envelope, and create a new independent current-format named plan for review. The source remains unchanged. Import does not transfer reasons, ancestry, approval, or an implementation record, and does not authorize implementation. An independent name collision gets a numeric suffix; later changes to that imported plan update its single file at the same configured storage path. Review and explicit implementation selection establish new tracking before verification can run.
