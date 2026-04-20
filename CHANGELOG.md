# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-04-20

### Added

- **Background auto-update**: on launch, `worktree` checks GitHub for a newer release at most once every 24 hours in a detached background process. When a newer version is found, the binary is downloaded, verified against SHA256, and staged. The next invocation atomically swaps in the new binary and prints a one-line `worktree auto-updated to vX.Y.Z` note on stderr. Opt out via `AUTO_UPDATE=false` in `~/.worktreerc` or `WORKTREE_NO_UPDATE=1` in the environment.
- **Release integrity**: every GitHub Release now publishes a `SHA256SUMS` file. The `worktree update` command and the background auto-updater both verify the downloaded binary against this hash before installing. Releases without `SHA256SUMS` (legacy) still work but without verification.

### Changed

- Auto-update now bumps its 24-hour throttle when a release is genuinely unusable on the current platform (probe failure), when GitHub is unreachable, or when a download fails for any reason. Previously, every CLI invocation re-downloaded ~50 MB and re-hit the GitHub API, which could trip the 60-requests-per-hour anonymous rate limit on a heavy day.
- Foreground `worktree update` now smoke-tests the downloaded binary (`--version`) before atomically replacing the installed binary. A SHA256-valid release that won't run on the current machine (libc/codesign/macOS-version mismatch) is now refused with a clear error instead of leaving the user with a broken `worktree`.
- A `SHA256SUMS` file containing **duplicate entries** — the canonical signature of supply-chain tampering — now triggers a loud red `SECURITY ALERT` in `worktree update` and a `TAMPER:` prefix in the background error log, instead of being reported as a generic "could not be fetched" outage.
- Project-scope `AUTO_UPDATE=...` is still ignored (matches existing behaviour) but the warning now also reports whether the value is a *valid* boolean-like, so a user moving the line to `~/.worktreerc` later already knows whether it would have taken effect.
- Version comparison now follows SemVer 2.0 §11 for prerelease ordering: `1.2.3-rc.10` is now correctly **greater than** `1.2.3-rc.2`. Previously the comparator used lexicographic string ordering, which would have stranded users on `rc.2` from ever auto-updating to `rc.10`.
- Release binaries are slightly smaller (minified, debug symbols stripped). No behavioural change.
- Release workflow smoke-tests each built binary (`--version`) before publishing so a broken build can't reach users.
- `AUTO_UPDATE` in a project `.worktreerc` now warns once that it is ignored — only `~/.worktreerc` is honoured (matches the README).
- Global and project config files now behave symmetrically on parse errors: both warn and fall back to defaults.
- CI: bumped `actions/checkout`, `actions/upload-artifact`, and `actions/download-artifact` to latest majors (Node.js 24 runtime) following GitHub's deprecation of Node.js 20 actions.

### Security

- Auto-update tmp paths now use `crypto.randomBytes(8)` instead of `process.pid`, removing a predictable-filename primitive that a co-tenant on a group-writable install dir could pre-plant a symlink at. Pre-unlink remains as the primary defense.
- Stage detection no longer silently fails on `EACCES` of the binary directory: `existsSync` was masking permission errors as "no stage". Now logs the diagnostic and bails without destructive cleanup, so a transient permission glitch can't destroy a peer process's mid-commit stage either.
- Release downloads are verified against `SHA256SUMS` using a constant-time hash comparison before being made executable.
- Release-channel fetches are restricted to an allowlist of GitHub-owned hosts, validated on every redirect hop **before** the runtime connects. A malicious `Location:` injection on the first hop can no longer reach an arbitrary host. `GITHUB_TOKEN` is stripped on any cross-origin hop and not re-attached if the chain bounces back to the origin.
- Release assets with a declared `Content-Length` over 200 MB are rejected outright, and byte-counts are enforced as the body streams in — a CDN omitting or forging `Content-Length` cannot exhaust memory before the size check fires. The download timeout is honoured throughout the body read so a slowloris response can't stretch past it.
- The staging tmp path is pre-unlinked before each download as a best-effort defense against a planted symlink in a shared install directory. (Not race-free — a writable install directory still allows re-planting between the unlink and the subsequent write. Closing that race fully would require `O_EXCL | O_NOFOLLOW`. Same treatment applies to the sidecar tmp path.)
- GitHub releases are now published as **draft**, uploaded with all files (binaries + `SHA256SUMS`), and flipped to public in a subsequent step — eliminating the window where `releases/latest` exposed a public release with binaries but no sums, forcing clients onto the TLS-only install path.
- `SHA256SUMS` parser rejects duplicate filename entries and is immune to prototype-pollution from a tampered sums file.
- Release tag and staged version strings are validated against the same strict regex at the writer and the reader, so a crafted tag can't propagate into paths, logs, or sidecar metadata.
- Concurrent launches no longer discard a correctly-staged update mid-commit: a 60-second mtime grace window distinguishes a concurrent producer from a real orphan.
- Auto-update now fails **closed** on a malformed `~/.worktreerc` — a typo can no longer silently re-enable auto-update against an explicit opt-out.
- Applying a staged update now also respects `AUTO_UPDATE=false` in `~/.worktreerc`. Previously, a user who opted out in config after a binary was already staged would still get the staged binary installed on the next launch.
- GitHub API fetches now send a proper `User-Agent` (`worktree-cli/vX.Y.Z`), `Accept: application/vnd.github+json`, and `X-GitHub-Api-Version` header. Setting `GITHUB_TOKEN` in the environment raises the rate limit from 60/hr (anonymous) to 5000/hr (authenticated).

### Fixed

- `release.ts` download path no longer silently swallows three classes of error (writer post-finish flush errors, reader `releaseLock` failures, partial-write cleanup failures). Errors now route through an `onError` callback that the auto-updater logs to `~/.cache/worktree-cli/last-error`.
- Removed an off-by-one in the redirect loop (`<=` instead of `<`) — the loop was allowing 6 hops while the error message claimed a limit of 5.
- Aggregated SHA256SUMS in the release workflow now compares against the actual binary count instead of a hardcoded `expected=4` — adding or removing a build target no longer requires editing two places.
- macOS releases (darwin-arm64, darwin-x64) are now **ad-hoc codesigned** after stripping. Prior releases shipped unsigned binaries, which Apple Silicon macOS SIGKILLs on execution. Users who hit `killed: 9` errors after downloading the raw binary should re-install from v1.3.0 onward.
- Auto-update no longer buffers the full binary in memory during download or verification — peak memory stays flat regardless of binary size.
- A missing per-arch asset in the latest release no longer burns the 24h auto-update throttle; the next launch retries so users on the lagging arch get updated once the asset is uploaded.
- `worktree update` and the background auto-updater now recognise the full set of write-permission errors on download, `chmod`, and rename (not just `EACCES`), clean up any partial staged files, and print a one-line `run "sudo worktree update"` hint instead of looping on every launch.
- Persistent structural failures (read-only install directory, busy binary, disk full, filesystem boundary) now throttle the background check so a stuck install directory no longer burns the GitHub API quota on every launch.
- Orphan staging artifacts left by an interrupted background update are cleaned up on the next launch instead of lingering indefinitely.
- First-ever auto-update launch no longer prints a spurious "error log unwritable" warning on a not-yet-created log file.
- Background updater no longer spawns a blind detached child when the cache log can't be opened — the same condition that short-circuits the throttle now also short-circuits the spawn, and the parent's copy of the log fd is released even if the spawn itself throws synchronously.
- Probe-timeout failures on a freshly-downloaded binary now surface as `timed out after 2000ms` instead of the opaque `exit null`.
- Network errors during update checks now preserve the underlying errno (`ENOTFOUND`, `ECONNRESET`, `ETIMEDOUT`, etc.) instead of being hidden behind a generic wrapper.
- The background update child is detached (POSIX `setsid`) so a slow download isn't killed when the user's shell or terminal exits.
- Unhandled throws from the background update path now write a full stack trace to `~/.cache/worktree-cli/last-error` and surface on the next foreground launch instead of failing silently.
- Unlink errors during cleanup distinguish "already gone" from real failures — only real failures emit a warning.

### Tests

- Added coverage for the SHA256 verification flow across all result shapes (legacy, normal, transient, permanent, missing-entry, hash-mismatch, hash-io-error) using stubbed `fetch` and a precomputed-hash asset file — pins the safety contract against future refactors.
- Added coverage for the `SHA256SUMS` parser's duplicate-entry rejection.
- Added coverage for SemVer 2.0 §11 prerelease ordering (numeric, string, numeric-vs-string, longer-wins-on-tie).

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
