# Pi extensions

A personal workspace for developing [pi-plan-mode](packages/pi-plan-mode/README.md), [thinking shortcuts](packages/pi-thinking-shortcuts/README.md), and future Pi extensions, forked from [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions).

## Packages

- [`packages/pi-plan-mode`](packages/pi-plan-mode): read-only `/plan` collaboration mode.
- [`packages/pi-artifacts`](packages/pi-artifacts): background text artifact agents with confined native writes and persistent feedback conversations.
- [`packages/pi-thinking-shortcuts`](packages/pi-thinking-shortcuts): Codex-style **Alt+,** / **Alt+.** to decrease/increase thinking effort.
- [`packages/pi-tui-kit`](packages/pi-tui-kit): the internal UI library used by Plan mode for menus, questionnaires, status widgets, and other terminal interactions.

All packages retain their source, tests, documentation, and licenses. TUI Kit has no further dependencies on packages in this repository. Workspaces link it locally; both the installation and development builds explicitly build TUI Kit before Plan mode.

## Install from GitHub

With Pi 1.5.0 installed, install **all three extensions from one reference**:

```sh
pi install git:github.com/tommyengstrom/pi-extensions
```

Restart Pi or run `/reload`, then use `/plan` and **Alt+,** / **Alt+.**. Only pushed commits are available through GitHub; local changes in this checkout are not installed by that command. Extensions execute with Pi's permissions, so review and trust the source before installation.

Consumers need Git, npm, a Node version compatible with Pi 1.5.0, and enabled installation scripts—**not Bun**, an `npmCommand` override, or a manual build. Pi's default production npm install runs a Node-only root `postinstall`: it transpiles this workspace's TUI Kit to JavaScript and builds Plan mode's split package runtime. Artifacts and thinking shortcuts remain source-loaded. Artifacts require Node's built-in `node:sqlite` support (available in the workspace's Node 26). Pi supplies its own host packages; they are not installed as physical runtime dependencies here.

Update the installed reference with:

```sh
pi update git:github.com/tommyengstrom/pi-extensions
```

Restart or `/reload` afterwards. For optional pinning, install `git:github.com/tommyengstrom/pi-extensions@<tag-or-commit>` (replace the placeholder with a pushed tag or commit). Updates reconcile that pinned ref rather than advancing it; use a different ref to change the version.

If you added `npmCommand: ["bun"]` solely for this repository, it is no longer needed. Review it yourself before removing it: it may serve other packages. Installation does not edit that setting.

Bun's frozen lockfile and minimum-release-age policy below protect **development** installs. npm consumer installs do not inherit those guarantees from `bun.lock`; the declared pins and npm overrides still apply. Installation produces runtime files only, not declarations or typechecking. The normal development build and `prepack` validation remain necessary for independently packaging the typed library.

## Development

The **repository root is the workspace root**: `package.json`, `packages/`, and `process-compose.yaml` live together. From there, use the [Nix development environment](./flake.nix):

```sh
nix develop
process-compose run dev
```

The flake supplies Bun 1.4.4, Node 26.13.0, and process-compose. `process-compose run dev` attaches Pi directly to the terminal; `process-compose up dev` is the interactive PTY/TUI alternative. The dev job waits for a successful `install` job, which runs `bun install --frozen-lockfile` in this workspace. Use `process-compose run install` from the repository root for installation only.

The dev job runs `bun run dev` here: it builds TUI Kit, typechecks artifacts, then builds Plan mode and typechecks thinking shortcuts, and starts Pi with only the three local extensions, avoiding duplicate loading of installed copies. Extensions execute with Pi's permissions; only load code you trust. Use `/plan` to open Plan mode.

This workspace declares `packageManager: bun@1.4.4` and uses `bun.lock`, not `package-lock.json`. `bunfig.toml` configures a hoisted linker, a three-day minimum release age (excluding the local TUI Kit package), and `run.bun = false` with the system shell. Node remains the runtime; do not use `--bun`. Only `esbuild` is trusted for dependency lifecycle scripts. The root pins it and globally overrides all copies, including transitive ones, to `0.28.2`; this preserves version-specific approval despite Bun's name-only `trustedDependencies`. Review lifecycle approval when changing that version. For intentional dependency/lockfile updates, run `bun install` here and review the resulting changes; regular installs use the frozen process-compose job.

Run checks from the **repository root**:

```sh
process-compose run check           # Builds/static checks, no tests
process-compose run test-plan-mode  # Plan mode extension tests
process-compose run test-artifacts  # Artifact extension tests
process-compose run test-tui-kit    # TUI Kit library tests
process-compose run test-thinking-shortcuts # Thinking shortcut extension tests
```

These jobs belong to the `tests` namespace and are disabled by default; each command explicitly enables its job without starting `dev`. Each performs a frozen install inline so installation failures propagate rather than allowing process-compose to return zero when a failed dependency prevents the job from starting. The test jobs build the workspace and filter Vitest by package directory, preserving shared and isolated execution. **Run the jobs sequentially, never concurrently with each other or `dev`**, because their builds overlap; do not start the whole namespace concurrently.

Other scripts, also run from the **repository root**:

```sh
bun run build                 # TUI Kit, artifacts, Plan mode, then thinking shortcuts
bun run typecheck             # Build, then typecheck packages and tests
bun run format                # Apply Biome formatting
bun run lint                  # Run Biome linting
bun run test test/install-runtime.test.ts # Root installation contract tests
node scripts/test-packaging.mjs # Or: bun run test:packaging (network-backed)
```

Use `bun run test`, not `bun test` (Bun's different test runner). Do not run builds, checks, or tests concurrently because they rebuild TUI Kit.

The explicit packaging smoke check stages the current candidate outside the checkout, uses an isolated npm cache/config and a PATH without Bun, and tests cold, repeat, and update-cleanup installs through a separate Pi 1.5.0 host. It checks manifest discovery, all three extensions, and lazy Plan mode UI rendering without credentials or model requests. Network/install/loader failures fail the check; this is intentionally outside timed Vitest tests.

For local development package-directory loading, build first (Git installation does this automatically):

```sh
bun run build
./node_modules/.bin/pi --no-extensions -e ./packages/pi-plan-mode
```

To add another extension, create `packages/<name>/` with its own manifest, source, tests, and TypeScript configuration, then add its `src/index.ts` entrypoint to the root `package.json` under `pi.extensions`. Keep internal dependencies as workspaces. Update the root build and typecheck scripts for each new workspace, explicitly building libraries before consumers; workspace listing order does not determine build order.

Upstream release automation, Git hooks, project-local extensions, and unrelated packages have been removed. Package names and upstream repository metadata are retained for provenance; this checkout does not publish automatically.

## License

[MIT](LICENSE). See each package's license for its notices.
