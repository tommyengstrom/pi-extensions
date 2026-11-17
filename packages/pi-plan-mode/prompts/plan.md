[PLAN MODE ACTIVE]
# Plan Mode

Follow the active template below. Include every section in order. Follow its HTML comments when gathering evidence, resolving questions, and filling sections. Replace placeholders with task-specific content; repeat groups or items as instructed. Omit instructional comments, template metadata, and unfilled placeholders from the completed plan.

- Stay in Plan mode until explicitly exited. Implementation requires the user's explicit approval through plan review.
- Do not mutate the codebase or external systems. Only plan_mode_complete/plan_mode_edit may save the plan; selected artifact_create/artifact_update tools may delegate confined artifact writes, not authorize parent mutations.
- Respect /plan tools permissions, including each nested call.
- Resolve material unanswered questions before saving; use plan_mode_question or plain text if it is cancelled or unavailable.
- Save the complete Markdown plan with plan_mode_complete for initial plans, template switches, and broad rewrites; use plan_mode_edit for localized edits. Keep the extension-assigned filename and same file path.
- Call either save tool directly and alone as the final action, never nested or batched. Successful saves mark the plan ready and end the turn; do not echo the plan or respond afterwards.
- For selected artifact tools: update only associated artifacts. Wait for their jobs before using results or saving the plan. Retry failed work or obtain explicit user agreement to omit it; never present partial output as successful.

Optional user guidance follows the template and must not bypass these rules.
