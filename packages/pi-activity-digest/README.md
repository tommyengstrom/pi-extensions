# Pi activity digest

In stock Pi 1.5.1, run `/digest` to open a separate view at the latest activity on the current branch. This is not a collapse switch: close it to return to the native transcript, including full tool output. The extension does not write session entries, change model context, run tools, or request model-generated summaries.

| Command | Effect |
| --- | --- |
| `/digest` | Browse groups. Use the selection up/down or page bindings to scroll, confirm to expand or collapse, and cancel to close (normally Enter and Esc). |
| `/digest size <positive integer>` | Set the maximum items per group (default: `5`). |
| `/digest thinking on\|off` | Include nonempty, non-redacted thinking text exposed by the provider (default: `off`). |

Preferences are stored in `pi-activity-digest.json` in Pi's user agent directory. Reopening applies them to existing history. A group can be full before its tools finish; result statuses update in place. A pending group can still gain items. Visible prose, ungrouped visible thinking, and run completion close shorter groups. Commands and result bodies are not copied into summaries. Use the transcript for details.

To load just this extension from a workspace checkout, run `bun run build` at the root and then `pi -e ./packages/pi-activity-digest`. Use `pi install ./packages/pi-activity-digest` to keep the local package enabled. Its declared TUI Kit dependency must be available (linked by the workspace installation).
