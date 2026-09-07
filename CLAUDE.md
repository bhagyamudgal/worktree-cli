# worktree-cli

Git worktree manager CLI built with Bun 1.4.0 + TypeScript. Compiles to a standalone binary via `bun build --compile`.

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
- `src/commands/` — One file per CLI command. Each exports a brocli `command()`.
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

## Code comments

> **No comments in code. Rename or restructure instead.** Two exceptions, and each must fit on one line:
>
> 1. A `/** */` docstring on an exported symbol, stating a contract the signature cannot show.
> 2. A citation for a constraint the code cannot express: a URL, a spec section, an ADR or `docs/` path, or an issue number. The line carries the pointer, never the explanation.
>
> Everything else is banned. That includes any comment that explains what the code does, why it has its shape, what would break, or what you learned while writing it. Put that reasoning in the PR body, a test name, or an ADR.
>
> Existing comments in a file are not a style to match and not a license to add more. Leave them alone when you touch the file for another reason.
>
> Before reporting a code change done, print every added comment line that lacks a citation token and delete each comment it shows. The pattern is a net, not a parser: a printed line that is not a comment is a false positive to leave alone.
>
> ```bash
> CITED='https?://|docs/|ADR|#[0-9]+|§'
> git diff -U0 <base> -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.go' '*.rs' '*.java' '*.kt' '*.swift' '*.c' '*.h' '*.cpp' '*.cs' \
>   | grep -E '^\+([[:space:]]*(//|/\*|\* )|.*[[:space:]](//|/\*))' \
>   | grep -vE "$CITED|^\+[[:space:]]*/\*\*.*\*/[[:space:]]*\$"
> git diff -U0 <base> -- '*.py' '*.sh' '*.zsh' '*.rb' '*.toml' '*.yml' '*.yaml' \
>   | grep -E '^\+([[:space:]]*#|.*[[:space:]]#)' | grep -vE "$CITED|^\+#!"
> ```

## Dependencies

- `@drizzle-team/brocli` — CLI arg parsing (typed commands + options)
- `@clack/prompts` — Interactive terminal prompts (select, confirm)
- `zod` — Config schema validation

## Changesets and releases

Run `bun changeset` for every user-visible change and commit the generated file with the pull request. The release workflow owns `package.json` versions, `CHANGELOG.md`, tags, and GitHub Releases. See `.changeset/README.md` for bump rules and the release sequence.
