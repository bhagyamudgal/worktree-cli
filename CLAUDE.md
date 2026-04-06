# worktree-cli

Git worktree manager CLI built with Bun + TypeScript. Compiles to a standalone binary via `bun build --compile`.

## Commands

```bash
bun run dev -- <command>     # run locally
bun run build                # compile standalone binary to dist/
bun run typecheck            # TypeScript type-check
bun run lint                 # ESLint
bun run format               # Prettier
```

## Architecture

- `src/index.ts` — Entry point. Registers commands with brocli's `run()`.
- `src/commands/` — One file per CLI command (create, list, open, remove). Each exports a brocli `command()`.
- `src/lib/` — Shared utilities:
  - `git.ts` — All git subprocess wrappers. Uses `run()` from `shell.ts` with array args.
  - `shell.ts` — Thin `Bun.spawn` wrapper. Returns `{ stdout, stderr, exitCode }`.
  - `config.ts` — `.worktreerc` loader with Zod schema validation.
  - `constants.ts` — Named constants (colors, defaults, exclude patterns).
  - `logger.ts` — Colored stderr output functions.
  - `editor.ts` — Editor detection and interactive selection via `@clack/prompts`.
  - `env-files.ts` — Find and copy `.env` files to worktrees.
  - `package-manager.ts` — Detect lockfile and run install.
  - `try-catch.ts` — `tryCatch`/`tryCatchSync` utilities.

## Conventions

- All user-facing output goes to **stderr** (`console.error`), not stdout.
- Git commands use `run("git", [...args])` with array-based args (never string interpolation).
- Errors in git wrappers use `printError()` + `process.exit()` for clean output — never throw uncaught errors.
- Every `@clack/prompts` call must check `p.isCancel()` and exit gracefully.
- `shell.ts` reads stdout and stderr concurrently with `Promise.all` to avoid pipe deadlocks.

## Dependencies

- `@drizzle-team/brocli` — CLI arg parsing (typed commands + options)
- `@clack/prompts` — Interactive terminal prompts (select, confirm)
- `zod` — Config schema validation

## Changelog

When making changes, always update `CHANGELOG.md` before committing. The file follows [Keep a Changelog](https://keepachangelog.com) format.

- Add entries under an `## [Unreleased]` section at the top while work is in progress.
- When releasing, rename `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD` with the version from `package.json`.
- Use these categories: `Added`, `Changed`, `Fixed`, `Removed`.
- Write entries from the user's perspective — describe what changed, not implementation details.

## Release

```bash
# 1. Update version in package.json
# 2. Update CHANGELOG.md
# 3. Commit
# 4. Run:
./release.sh
```

This tags the version and pushes to trigger GitHub Actions, which builds binaries for all platforms and creates a GitHub Release.
