# Pi thinking shortcuts

Codex-style thinking-effort shortcuts for Pi's main editor:

| Shortcut | Action |
| --- | --- |
| **Alt+,** | Decrease thinking effort by one supported level |
| **Alt+.** | Increase thinking effort by one supported level |

The shortcuts stop at the lowest/highest level instead of wrapping. They use the active model's Pi capabilities, skipping unsupported levels, including `off`, `xhigh`, and `max` only when available. Models without reasoning support are left unchanged. A notification confirms the result; Pi's normal thinking indicator updates too.

## Install or try

From this repository's root:

```sh
# Install only this extension from the local checkout:
pi install ./packages/pi-thinking-shortcuts

# Or try it for one invocation:
pi --no-extensions -e ./packages/pi-thinking-shortcuts
```

Restart Pi after installation, or use `/reload` to reload configured resources. `process-compose run dev` also loads this extension alongside Plan mode.

Pi loads the TypeScript source directly; no generated runtime or extra runtime dependencies are required. The workspace build step typechecks this package. Requires Pi's `@earendil-works/*` APIs (tested with 1.5.0).

## Behavior and compatibility

- Changes use Pi's session-scoped thinking API: they survive session resume without rewriting the default for new sessions. They affect subsequent model requests, not a request already in flight.
- Unlike Codex's separate Plan-mode effort override, this extension changes the current Pi session's thinking level in both normal and Plan mode. It does not depend on Plan mode.
- Pi defines the levels and their provider mappings, not Codex's catalogue or its Ultra picker. Unsupported current levels are normalized with Pi's own clamping policy before stepping.
- The extension does not alter prompts, tools, model selection, editor text, or thinking-block visibility. Pi's existing Shift+Tab and Ctrl+T bindings remain unchanged.
- Shortcuts use Pi's native registration/dispatch, not raw terminal interception or a replacement editor. `/hotkeys` lists them. Terminal focus, paste handling, and shortcut conflicts are managed by Pi. No actions run in print, JSON, or RPC mode.
- Your terminal must send Alt/Meta combinations to Pi. On macOS, configure Option as Alt/Meta if necessary.

## Tests

From the repository root, run sequentially with other checks/tests:

```sh
process-compose run test-thinking-shortcuts
```

## License

[MIT](LICENSE).
