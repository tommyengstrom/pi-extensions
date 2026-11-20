# Pi Herdr Core workers

Delegate a question to a fresh, one-shot **Pi CLI** in a local Herdr Core terminal. Herdr owns the terminal; the originating Pi session owns the task. There is no background SDK agent, second planning workflow, or recursive delegation.

## Use

- `/subagent investigate where Alt+M is decoded` starts a worker. `/subagent --agent reviewer investigate the input path` selects a named Pi profile. With no arguments the command lists workers in this scope.
- Model tools: `subagent({ task, agent? })`, `subagent_query` (list/status/result), `subagent_wait`, and `subagent_cancel`. Launch acknowledges the job; it does not return the answer. Wait when the answer becomes a dependency. `hc read tN` and `hc attach tN` show the ordinary Pi terminal. Do not send it another task.
- The process-compose `dev` job already starts inside Core. Alternatively, from the repo root in `nix develop`, stop that job, then `hc run --bg --name pi-extensions --cwd "$PWD" -- "$(command -v nix)" develop -c bun run dev` and `hc attach pi-extensions`.
- Requires local `HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET`; no autostart, remote routing or process fallback. Targets stock Core 0.1.18 (also accepts 0.1.21) and the Node Pi CLI 1.5.1. Uses the installed CLI, not a `pi` found on PATH.

### `/btw [prompt]`: ask on the side

In interactive Pi, try `/btw why did we choose that approach?`. A focused overlay answers using a snapshot of the current branch and the selected model. Type follow-ups in the overlay, or start with bare `/btw` to open the editor without sending a request. Replies use the configured provider (normal usage charges apply), without tools or edits. Close the overlay with the displayed cancel key to discard it; nothing is appended to the main chat.

After a completed answer, submit `/herdr` **inside the overlay** to save the thread as a separate Pi session and select it in a new Herdr desktop tab. It resumes after the last answer without resending the question. This is a normal interactive Pi CLI with its own configuration, not a one-shot worker; it stays open when the original chat ends. The selected model/provider must also be configured for that CLI. Handoff is unavailable under Plan/Explain restrictions or a review hold.

Inline chat needs no Herdr installation. Handoff needs `herdr-app` on PATH and an open desktop app supporting `ls` and `do tab.new`. Use one local space, or invoke `/btw` from the intended space's terminal. Remote spaces and legacy `herdr` TUI windows aren't targets. Focus selects the tab inside Herdr; it does not raise the OS window. If launch is unconfirmed, check Herdr before reopening the saved session.

### Named profiles

Optional, user-controlled files in `<getAgentDir()>/pi-herdr-core/profiles/`. For example `reviewer.json`:

```json
{"instructions":"Review for regressions and cite file paths.","tools":["read","grep","find","ls","websearch"]}
```

Omit `tools` to inherit the parent's delegable selection. `[]` means **no tools**. A profile never selects an executable, changes models, or grants a missing tool. No repo-local profile discovery.

### Permissions and results

The CLI runs in the parent cwd at the selected provider/model and thinking level, with Plan/Explain guidance captured before launch. Only the parent can change modes, delegate, manage artifacts or save/approve a plan. The child does not inherit parent messages. CLI configuration and authentication must be available to the child through the same agent directory or Core environment; ephemeral transports cannot be cloned.

Both launch paths require `subagent` to be selected live and allowed by the workflow. Tool identities and direct/nested access are captured before the profile is read; workflow and profile lists can only narrow that selection. Exact tool names are selected through Pi's CLI. Reproducible trusted file-backed tools (including search) load explicitly. When no MCP tool is selected, `--no-mcp` disables the built-in entirely. With selected MCP tools, ordinary Pi MCP configuration applies; a worker-only extension checks provenance, availability and direct/nested calls against the captured ceiling. Launch reports tools it omits and why (including aggregate MCP resource tools, whose connected server set cannot be verified). A child-side identity mismatch is reported with the job result. The worker may proceed with no tools; inability to establish the permission boundary still stops the task. Extensions execute trusted code; this is not an OS sandbox.

Up to four active/unconfirmed direct workers, ten minutes per run. Scope replacement or parent shutdown cancels owned work. Failed or uncertain launches are not automatically retried. A lost Core response can leave an unconfirmed allocation; check Herdr rather than blindly relaunching. Each worker publishes one settled result from Pi's structured assistant events; a finished terminal alone is not success. Job status and automatic delivery belong only to the live scope. The terminal, native transcript and full `answer.json` (see `job.resultPath` when a result preview is truncated) under `<getAgentDir()>/pi-herdr-core/workers/<id>/` remain for human inspection. Existing older records are left untouched, not adopted or deleted. Remove finished terminals manually with `hc rm`.

### Verification

`bun run check` and `bun run test` from the workspace root. Separate real-process acceptance: `nix develop -c node packages/pi-herdr-core/test/acceptance.mjs` after the workspace build. It starts a private Core server and local HTTP provider and does not require a provider account.
