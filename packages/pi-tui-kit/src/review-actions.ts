import { safeMenuText } from "./components/rendering.js";

export interface DocumentReviewAction {
  id: string;
  label: string;
}

/** Shared validation for standalone and declarative document reviews. */
export function validateReviewActions(
  confirmation: { label: string } | undefined,
  actions: readonly DocumentReviewAction[] | undefined,
): Error | undefined {
  if (confirmation && actions !== undefined) return new Error("Review confirmation and actions are mutually exclusive");
  if (confirmation && !safeMenuText(confirmation.label).trim()) {
    return new Error("Review confirmation label must not be empty or undisplayable");
  }
  if (actions !== undefined && actions.length === 0) return new Error("Review actions must not be empty");
  const ids = new Set<string>();
  for (const action of actions ?? []) {
    if (!action.id.trim()) return new Error("Review action id must not be empty");
    if (ids.has(action.id)) return new Error(`Review action id must be unique: ${action.id}`);
    ids.add(action.id);
    if (!safeMenuText(action.label).trim()) return new Error("Review action label must be displayable");
  }
  return undefined;
}
