# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-04-17

### Added

- Origin merge status displayed in `list`, `open`, and `remove` commands — shows whether branch is merged into default branch on origin
- Full branch status in `remove` command — shows uncommitted changes, unpushed commits, and origin merge status before confirming removal
- Auto-detect default branch from `origin/HEAD` when `DEFAULT_BASE` is not set in `.worktreerc`

### Changed

- `remove` command always confirms before removal, displaying comprehensive branch status
- `remove` command fetches from origin before checking merge status (non-fatal on failure)
- Worktree selection hint now shows origin merge status alongside local changes

### Fixed

- Inaccurate file counts: switched from `git status --porcelain` to `--porcelain=v2 -uall` to expand untracked directories into individual files

## [1.1.0] - 2026-04-07

### Added

- Auto-create `.worktrees/.gitignore` with `*` on first worktree create, so users never need to manually update their root `.gitignore`
- Automated test suite for configuration loading, worktree operations, and environment file handling
- Shell alias suggestion (`gw=worktree`) in install script, with automatic shell config detection
- Interactive worktree selection for `open` and `remove` commands when name is omitted
- `update` command to self-update the CLI to the latest GitHub release

### Changed

- `open` and `remove` commands: `name` argument is now optional (shows interactive selector when omitted)

## [1.0.0] - 2026-04-06

### Added

- Rewritten CLI from bash to Bun TypeScript
- Standalone binary compilation via `bun build --compile` (no runtime needed)
- Interactive editor selection with `@clack/prompts`
- Typed argument parsing with `@drizzle-team/brocli`
- Config validation with Zod (`.worktreerc` format unchanged)
- ESLint, Prettier, Husky + lint-staged for code quality
- GitHub Actions CI (lint, format, typecheck) and auto-release workflow
- `release.sh` for one-command tag + push releases
- Platform-specific binary downloads in `install.sh` (macOS ARM/Intel, Linux x64/ARM64)
- MIT license

### Changed

- Editor prompt now uses interactive arrow-key selector instead of numeric input
- Dependency install failure now warns and continues instead of aborting
- Config parser now preserves whitespace in values and supports quoted values
- Updated README with complete CLI options, list output details, safety features, dev commands, CI info, and release workflow
- Reorder `git worktree add` arguments to match Git's documented synopsis
- Abort remove command if force worktree removal fails instead of continuing to success path
- Validate broken worktree against git registry before allowing deletion
- Check `trash` subprocess exit code during worktree removal
- Check `git branch -D` result before printing success message
- Use `--expire now` with `git worktree prune` for immediate cleanup after manual deletion
- Replace deprecated `macos-13` GitHub Actions runner with `macos-15-intel`
- Track `bun.lock` in git for reproducible CI builds with `--frozen-lockfile`
- Filter worktree list by root path instead of assuming index order
- Validate `--editor` flag against supported editor allowlist before spawning
- Handle env file copy failures per file instead of aborting entire flow
- Reorder `git worktree remove` arguments to match Git's documented synopsis

### Removed

- Bash script (`bin/worktree`)
- Bash 3+ requirement (replaced by standalone binary)
