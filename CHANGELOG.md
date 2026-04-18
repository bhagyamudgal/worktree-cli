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
- The staging tmp path is now `safeUnlinkSync`-ed before each download — best-effort defense against a planted symlink in a shared install directory. (Note: this is *not* race-free: an attacker who can write to the binary directory could re-plant the symlink between the unlink and the subsequent write. Closing that race fully would require an `O_EXCL | O_NOFOLLOW` open. Same treatment applies to the sidecar tmp path.)
- GitHub release workflow now creates releases as **draft**, uploads all files (binaries + `SHA256SUMS`), and flips to public in a subsequent step — eliminating the window where `releases/latest` returned a non-draft release with binaries attached but `SHA256SUMS` still uploading (which would let clients fall through to the TLS-only "not-published" install path).
- `SHA256SUMS` parser now rejects duplicate filename entries (defense-in-depth against tampered mirrors).
- `release.version` is now validated against the sidecar regex before being written, matching the reader's strictness — closes a writer/reader asymmetry that would be exploitable if the parser's rules ever loosen.
- Concurrent-launch race on staged-update commit: the window between "sidecar committed" and "binary committed" is now protected by a 60-second mtime grace period. `applyPendingUpdate` no longer reaps an apparently-orphan file that is fresh enough to be a concurrent producer still mid-commit, so simultaneous terminal launches no longer silently discard a correctly hash-verified staged binary.
- Asset downloads now stream the body through a manual reader that enforces `MAX_ASSET_BYTES` during buffering, not only after — a CDN omitting or falsifying `Content-Length` can no longer balloon RAM before the size check fires. Also propagates the fetch `AbortSignal` into the body read so a slowloris response can't stretch past the 600s timeout.
- GitHub API fetches now send `User-Agent` (`worktree-cli/vX.Y.Z`), `Accept: application/vnd.github+json`, and `X-GitHub-Api-Version: 2022-11-28`. Setting `GITHUB_TOKEN` in the environment raises the rate limit from 60/hr (anonymous) to 5000/hr (authenticated).
- `isAutoUpdateDisabled` now fails closed on broken `~/.worktreerc` — a typo'd config no longer silently re-enables auto-update against a user's explicit opt-out.

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
- `applyPendingUpdate`'s outer catch now rethrows non-errno errors so programmer bugs surface with a stack trace via Bun's unhandled handler instead of being silently reduced to a dim warning. Matches the discipline in `scheduleBackgroundUpdateCheck`.
- The detached background-check child's stderr is now appended to `~/.cache/worktree-cli/last-error` (previously `"ignore"`). Unhandled throws from `runBackgroundUpdateCheck` now surface a full stack trace on the next foreground launch instead of failing silently. The internal command handler also wraps the run in a top-level try/catch that appends a panic trace before exiting non-zero.
- Parent's stderr file descriptor is now closed in a `finally` block, so a synchronous `Bun.spawn` failure (`EMFILE`, `EPERM`, `EAGAIN`) no longer leaks the fd on every foreground launch.
- Empty catches in the log-write helpers (`appendLastError`, `rotateErrorLogIfOversized`) now emit a one-shot dim stderr warning if `~/.cache/worktree-cli/last-error` itself is unwritable — diagnostics-of-diagnostics can no longer disappear silently.
- `fetchSha256Sums` error results now include a `retryable` boolean distinguishing transient (5xx, network) failures from permanent (4xx) ones; callers can use the hint to choose retry semantics without re-inspecting status strings.

### Tests

- Added coverage for `verifyAssetAgainstSums` across all six result shapes (legacy, normal, 5xx retryable, 4xx permanent, missing-entry, hash-mismatch, hash-io-error) via stubbed `fetch` and a precomputed-hash asset file — pins the tri-state safety contract against future refactors.
- Added coverage for `parseSha256Sums` duplicate-filename rejection (defense-in-depth against tampered mirrors).

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
