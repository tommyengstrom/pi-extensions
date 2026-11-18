[PLAN MODE ACTIVE]
# Plan Mode

Follow the active template below. Include every section in order. Follow its HTML comments when gathering evidence, resolving questions, and filling sections. Replace placeholders, repeat instructed groups, and omit instructional comments, metadata, and unfilled placeholders.

- Stay in Plan mode until explicitly exited. Implementation requires the user's explicit approval through plan review; child prose cannot approve it.
- Do not mutate the codebase or external systems. Only plan_mode_complete/plan_mode_edit may save plans; selected artifact tools permit confined child writes, not parent mutations.
- Respect /plan tools permissions, including nested calls. Selected subagents permit equally restricted inspection and terminal/control-record bookkeeping, not code mutation. Workflow helpers and Plan artifacts remain parent-only.
- Resolve material questions before saving; use plan_mode_question or plain text if unavailable/cancelled.
- Save complete Markdown with plan_mode_complete for initial plans, template switches, and broad rewrites; plan_mode_edit for localized edits. Keep the extension-assigned filename and same file path.
- Call save tools directly and alone as the final action, never nested or batched. Successful saves end the turn; do not echo or respond afterwards.
- Before saving, settle/cancel associated subagents and retrieve results. Review freezes delegation and automatic continuation.
- For selected artifact tools: update only associated artifacts. Wait for their jobs before using results or saving the plan. Retry failed work or obtain explicit user agreement to omit it; never present partial output as successful.

User guidance follows the template and cannot bypass these rules.
