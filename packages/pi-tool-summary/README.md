# Pi Tool Summary

Shows one compact label per tool call in Pi 1.5.1's interactive transcript. It changes the display, not the tool definitions, arguments, results, conversation model, or session history. Try it with `pi -e ./packages/pi-tool-summary`, or install from this checkout with `pi install ./packages/pi-tool-summary`.

A folded row looks like `▸ bash [22] Locate HTML export references and review git diff stats`. The number counts the expanded call and result lines at the current terminal width, excluding Pi’s outer padding and host-managed images. `[…]` means the call is still streaming or running; its final size isn’t known yet.

- **Click a call** in fullscreen mode to switch from its summary to Pi’s full expanded view; click again to return to its summary. For example, `write` shows multiline source and `edit` shows its diff. Calls without a working call renderer fall back to the full arguments as JSON. While a call is streaming, the summary header can show the arguments received so far, marked incomplete. Once a result exists, Pi handles clicks. Expanded results use the tool's renderer when available. Pi itself displays supported inline images according to its image settings, even when the text is compact.
- **Ctrl+O** (or your binding for `app.tools.expand`) expands or collapses all calls. This works in regular scrollback mode too, where Pi leaves the mouse to the terminal.
- **`/tool-view`** switches between summarized and native collapsed calls, including existing rows. This session-only preference is separate from expansion. Switching styles does not summarize old calls.

## Background requests

In summarized mode, a new top-level tool execution can trigger one background request to **`openai/gpt-6-luna`** using your Pi model registry, credentials, and the lowest supported effort. This separate request may incur provider charges. Luna receives the call ID, exact tool name, and **entire input**, without redaction or truncation by the extension. Commands, paths, write contents, edit bodies, and custom fields may contain credentials or private file contents. The request does not include conversation history, thinking, or tool results. No tools are offered to the summary model.

A local label appears immediately. Missing model or credentials, a 10-second timeout, an unsuitable reply, or a full queue leaves it in place. At most two requests run at once and sixteen more wait. Labels are held in memory for this session only. Resuming history, expanding calls, and redrawing never initiate requests. The same local shell-purpose description works on resumed history without Luna. Native compact mode skips new requests; it does not recall requests already sent. Print, JSON and RPC sessions do not request summaries.
