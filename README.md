# Pi extensions

A personal workspace for developing [pi-plan-mode](packages/pi-plan-mode/README.md), [thinking shortcuts](packages/pi-thinking-shortcuts/README.md), and future Pi extensions, forked from [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions).

## Packages

- [`packages/pi-plan-mode`](packages/pi-plan-mode): read-only `/plan` collaboration mode.
- [`packages/pi-thinking-shortcuts`](packages/pi-thinking-shortcuts): Codex-style **Alt+,** / **Alt+.** to decrease/increase thinking effort.
- [`packages/pi-tui-kit`](packages/pi-tui-kit): the internal UI library used by Plan mode for menus, questionnaires, status widgets, and other terminal interactions.

All packages retain their source, tests, documentation, and licenses. TUI Kit has no further dependencies on packages in this repository. Bun workspaces link it locally; the root build script explicitly builds TUI Kit before Plan mode.

## Development

The **repository root is the workspace root**: `package.json`, `packages/`, and `process-compose.yaml` live together. From there, use the [Nix development environment](./flake.nix):

```sh
nix develop
process-compose run dev
```

The flake supplies Bun 1.4.4, Node 26.13.0, and process-compose. `process-compose run dev` attaches Pi directly to the terminal; `process-compose up dev` is the interactive PTY/TUI alternative. The dev job waits for a successful `install` job, which runs `bun install --frozen-lockfile` in this workspace. Use `process-compose run install` from the repository root for installation only.

The dev job runs `bun run dev` here: it builds TUI Kit, then Plan mode, typechecks the source-loaded thinking shortcuts, and starts Pi with only the two local extensions, avoiding duplicate loading of installed copies. Extensions execute with Pi's permissions; only load code you trust. Use `/plan` to open Plan mode.

This workspace declares `packageManager: bun@1.4.4` and uses `bun.lock`, not `package-lock.json`. `bunfig.toml` configures a hoisted linker, a three-day minimum release age (excluding the local TUI Kit package), and `run.bun = false` with the system shell. Node remains the runtime; do not use `--bun`. Only `esbuild` is trusted for dependency lifecycle scripts. The root pins it and globally overrides all copies, including transitive ones, to `0.28.2`; this preserves version-specific approval despite Bun's name-only `trustedDependencies`. Review lifecycle approval when changing that version. For intentional dependency/lockfile updates, run `bun install` here and review the resulting changes; regular installs use the frozen process-compose job.

Run checks from the **repository root**:

```sh
process-compose run check           # Builds/static checks, no tests
process-compose run test-plan-mode  # Plan mode extension tests
process-compose run test-tui-kit    # TUI Kit library tests
process-compose run test-thinking-shortcuts # Thinking shortcut extension tests
```

These jobs belong to the `tests` namespace and are disabled by default; each command explicitly enables its job without starting `dev`. Each performs a frozen install inline so installation failures propagate rather than allowing process-compose to return zero when a failed dependency prevents the job from starting. The test jobs build the workspace and filter Vitest by package directory, preserving shared and isolated execution. **Run the jobs sequentially, never concurrently with each other or `dev`**, because their builds overlap; do not start the whole namespace concurrently.

Other scripts, also run from the **repository root**:

```sh
bun run build                 # TUI Kit, Plan mode, then thinking shortcuts
bun run typecheck             # Build, then typecheck packages and tests
bun run format                # Apply Biome formatting
bun run lint                  # Run Biome linting
```

Use `bun run test`, not `bun test` (Bun's different test runner). Do not run builds, checks, or tests concurrently because they rebuild TUI Kit.

For package-directory loading, build first:

```sh
bun run build
./node_modules/.bin/pi --no-extensions -e ./packages/pi-plan-mode
```

To add another extension, create `packages/<name>/` with its own manifest, source, tests, and TypeScript configuration, then add its `src/index.ts` entrypoint to the root `package.json` under `pi.extensions`. Keep internal dependencies as workspaces. Update the root build and typecheck scripts for each new workspace, explicitly building libraries before consumers; workspace listing order does not determine build order.

Upstream release automation, Git hooks, project-local extensions, and unrelated packages have been removed. Package names and upstream repository metadata are retained for provenance; this checkout does not publish automatically.

## License

[MIT](LICENSE). See each package's license for its notices.
