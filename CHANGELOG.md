# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Auto-create `.worktrees/.gitignore` with `*` on first worktree create, so users never need to manually update their root `.gitignore`
- Automated test suite for configuration loading, worktree operations, and environment file handling
- Shell alias suggestion (`gw=worktree`) in install script, with automatic shell config detection
- Interactive worktree selection for `open` and `remove` commands when name is omitted

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
