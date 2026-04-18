# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-04-17

### Added

- **Background auto-update**: on launch, `worktree` checks GitHub for a newer release at most once every 24 hours in a detached background process. When a newer version is found, the binary is downloaded, verified against SHA256, and staged. The next invocation atomically swaps in the new binary and prints a one-line `worktree auto-updated to vX.Y.Z` note on stderr. Opt out via `AUTO_UPDATE=false` in `~/.worktreerc` or `WORKTREE_NO_UPDATE=1` in the environment.
- **Release integrity**: every GitHub Release now publishes a `SHA256SUMS` file. The `worktree update` command and the background auto-updater both verify the downloaded binary against this hash before installing. Releases without `SHA256SUMS` (legacy) still work but without verification.

### Changed

- CI: bumped `actions/checkout`, `actions/upload-artifact`, and `actions/download-artifact` to latest majors (Node.js 24 runtime) to address GitHub's deprecation of Node.js 20 actions.
- Release binaries now built with `--minify --sourcemap=none` and stripped of debug symbols (`llvm-strip` on Linux, `strip` on macOS). Binary sizes are slightly smaller; functional behavior unchanged.
- Release workflow smoke-tests each built binary via `--version` before publishing to catch regressions.
- `AUTO_UPDATE` set in a project `.worktreerc` now warns once that it is ignored — the flag only takes effect in `~/.worktreerc`, matching the README.
- `readConfigFile` is now fail-open on parse errors (warn + return defaults) for both project and global configs, instead of asymmetrically swallowing for project / propagating for global.
- SHA256SUMS verification is centralized in a new `verifyAssetAgainstSums` helper; the foreground `update` command and the background check share the same discriminated-union result contract.

### Security

- SHA256SUMS parser now allocates its result map with `Object.create(null)` to block `__proto__`/`constructor`/`prototype` pollution from a tampered sums file.
- SHA256 hash comparison now uses `node:crypto.timingSafeEqual` (C-level constant-time) instead of a userland XOR loop that V8/JSC may short-circuit.
- Release asset downloads now reject responses whose declared `Content-Length` exceeds 200 MB, capping the blast radius of a malicious CDN before SHA verification fires.
- The staging tmp path is now `safeUnlinkSync`-ed before each download, so an attacker-planted symlink in a shared install directory cannot redirect the write to an arbitrary target. Same treatment applies to the sidecar tmp path.
- GitHub release workflow now creates releases as **draft**, uploads all files (binaries + `SHA256SUMS`), and flips to public in a subsequent step — eliminating the window where `releases/latest` returned a non-draft release with binaries attached but `SHA256SUMS` still uploading (which would let clients fall through to the TLS-only "not-published" install path).
- `SHA256SUMS` parser now rejects duplicate filename entries (defense-in-depth against tampered mirrors).

### Fixed

- macOS releases (darwin-arm64, darwin-x64) are now **ad-hoc codesigned** in the release workflow after stripping. Prior releases shipped unsigned binaries, which Apple Silicon (arm64) macOS SIGKILLs on execution. Users who hit `killed: 9` errors after downloading the raw binary should re-install from v1.3.0 onward.
- Startup hash verification of a staged binary now reads in 64 KB chunks instead of buffering the full binary in memory, keeping peak RSS flat on every launch.
- Asset-download phase now streams directly from `fetch` to disk via `Bun.write(destPath, response)` instead of round-tripping through an `ArrayBuffer`.
- A missing per-arch asset in the latest release no longer burns the 24h auto-update throttle — the next launch retries so users on the lagging arch get updated promptly once the asset is uploaded.
- `worktree auto-update` failures caused by a read-only binary directory (`EACCES`/`EPERM`/`EROFS` on the atomic swap) now clean up the staged artifacts and print a one-line `run "sudo worktree update"` hint on stderr instead of looping on every launch.
- Non-permission rename failures (`ETXTBSY`, `EXDEV`, `ENOSPC`, `EIO`, `EBUSY`) now cleanup the staged artifacts too, so a persistent rename failure can't pin a warning on every single launch.
- Orphan `.worktree.next.meta` sidecar left by an interrupted background stage is now cleaned up on the next launch instead of lingering indefinitely.
- Background check's 24h throttle no longer thrashes if the cache file's `.exists()` probe errors out — the error is logged and the check proceeds as if no check has run, matching the symmetric `.text()` read-error behavior.
- `worktree update` now recognises `EACCES`/`EPERM`/`EROFS` on the download and rename steps (previously only `EACCES`) and surfaces the deepest `Error.cause` message so users see the real errno (`ENOTFOUND`, `ECONNRESET`, etc.) instead of the generic wrapper.
- Unlink errors in cleanup paths now distinguish `ENOENT` (silent, expected) from real failures (`EACCES`, `EPERM`, etc.) — real failures emit a dim stderr warning instead of being silently swallowed.
- Probe-timeout failures now surface as `timed out after 2000ms` instead of the opaque `exit null`.
- Network errors from `fetchLatestRelease`/`downloadAsset` now preserve the underlying errno chain via `Error.cause`, so callers can classify failures accurately.
- The background update child is now spawned with `detached: true` (POSIX `setsid()`), so a slow download isn't cut short when the user's shell/terminal exits — the child finishes the check in its own session.

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
- `DEFAULT_BASE=origin/main` (the documented format) no longer produces an invalid `origin/origin/main` ref in the merge check — `getDefaultBranch` now strips a leading `origin/` so all consumers see a bare branch name
- `checkMergedIntoOrigin` now distinguishes "not an ancestor" (exit code 1 → `false`) from ref-missing / corrupt-state errors (other non-zero → `null` = unknown), avoiding misleading "NOT merged" messages on error states

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
