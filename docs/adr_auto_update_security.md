# ADR: auto-update security model

Status: accepted.

Worktree-cli self-updates by downloading compiled binaries from GitHub
releases in a background child process and swapping them in on the next
launch. The updater fetches over the network, writes executables, and runs
them, so every input is untrusted until verified.

## 1. Threat model

Attackers considered: a network adversary off GitHub origins, a compromised
CDN or release asset, a tampered SHA256SUMS file, a local user planting
symlinks in shared install dirs, and stale or rolled-back stages.
Non-goals: defending a machine whose running binary is already compromised,
and hiding version numbers.

## 2. Host pinning and redirects

Fetches go only to allowlisted GitHub origins: api.github.com, github.com,
codeload.github.com, objects.githubusercontent.com,
release-assets.githubusercontent.com, and
github-releases.githubusercontent.com. Redirects are followed manually so
each hop's host is validated before connecting. Authorization is stripped on
any cross-origin hop and never re-added, so a chain that bounces back to the
origin cannot re-attach the token. Refusals log the host only, because signed
CDN URLs can carry tokens in the query string.

## 3. Size caps

Asset downloads are capped at 200 MB, which is headroom over the current
~50 MB binary, and oversized responses are rejected before verification.
Chunks stream to disk with the cap enforced as bytes arrive instead of
buffering the whole body in memory.

## 4. Release metadata and checksums

Release tags must match a strict version pattern before they are used in
paths or logs. The SHA256SUMS parser lowercases hex, skips blanks and
`#` comments, rejects BSD-tagged `SHA256 (file) = hex` lines, and treats
duplicate entries as tampering. Tamper (parsed but malformed sums) is a
distinct outcome from fetch errors: tamper escalates loudly and burns the
throttle, while fetch errors retry when transient. Retryable statuses are
5xx plus 403 and 429, which are the GitHub rate-limit signals; other 4xx are
permanent. Releases without SHA256SUMS fall back to a self-hash, which
detects local stage-to-apply corruption only, not upstream tampering.
Requests identify as worktree-cli and use GITHUB_TOKEN when present, since
authenticated calls get a far higher rate limit than anonymous ones.

## 5. Staging and apply integrity

Temp and sidecar files are pre-unlinked so writes cannot follow planted
symlinks. Verification runs before chmod and before the probe, because
executing an unverified binary is code execution. The probe requires the
staged binary to run `--version` successfully with version-shaped output,
because a hash match does not prove runnability, and it runs with
auto-update disabled so the probe cannot spawn grandchildren or consume a
stale stage. The sidecar writer is locked to the reader's version and hash
pattern so a future parser relaxation cannot turn a crafted tag into a hash
spoof. A stage older than the running version is discarded as stale, since a
foreground update may have raced a background check, and applying it would
silently downgrade. Hash comparison is constant-time to close the timing
side channel, and the sums object has a null prototype to block `__proto__`
pollution from a tampered file.

## 6. Throttle policy

A completed check burns the 24h throttle window on structural or permanent
outcomes, so a broken release does not cost a download or API call on every
launch. Transient outcomes keep retrying: a missing arch asset (the
maintainer may upload it later), transient sums errors, local hash I/O
errors, and sidecar or stage writes that fail for non-permission reasons.
