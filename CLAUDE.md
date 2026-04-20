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

## Comment discipline

**Default: write zero comments.** Well-named identifiers + control flow explain WHAT. This project follows the global "no comments unless genuinely complex" rule **strictly** — stricter than the global default.

**Fix rationale belongs in commit messages, not code.** "We added X to prevent Y outage" is commit-message content. It does NOT go in the code — comments drift from the implementation as the code evolves, commit messages and PR descriptions don't.

**The only code comments that earn their keep are footgun warnings** — ones that save a future dev from a specific non-obvious trap AND aren't findable from git blame. Examples that pass the bar:

- `// Bun.spawnSync returns null exitCode on timeout kill.` (runtime quirk)
- `// Constant-time compare prevents timing side-channel on hash compare.` (security invariant the call site alone doesn't communicate)
- `// POSIX setsid(): survives terminal close so a slow download isn't SIGHUPed.` (cross-platform behavior note)

**Anti-patterns — NEVER write any of these** (concrete examples from real commits that violated this rule):

1. **Paraphrasing the next line** — `// Bump throttle on transient network failures so we don't burn the GitHub API quota` above `recordCheckCompleted();`. The function name already says this.
2. **JSDoc-style docblocks for internal helpers** — `// true=exists, false=ENOENT, null=non-ENOENT error logged; caller must bail` above `function checkExists(...): boolean | null`. The return type plus null-checks at call sites already communicate the contract.
3. **Multi-line fix rationale** — any 2+ line comment explaining WHY a PR-level decision was made. That belongs in the commit message. If it's not findable from `git blame`, improve the commit message instead of polluting the code.
4. **Stacked WHY paragraphs** — back-to-back `// line 1 / // line 2 / // line 3` blocks. Treat 2 lines as a warning sign; 3+ lines is always wrong.

**Self-test before writing any comment**: remove it and re-read the function. Would a future reader (including future-me) be meaningfully more confused without it? If the answer is "no" or "barely" — delete the comment.

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
