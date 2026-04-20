import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shouldAutoUpdate, shouldAutoUpdateSync } from "./config";
import { classifyWriteError, isEnoent, safeUnlinkSync } from "./fs-utils";
import {
    compareVersions,
    computeSha256Sync,
    downloadAsset,
    fetchLatestRelease,
    getAssetName,
    isStandalone,
    verifyAssetAgainstSums,
    verifyBinaryHashSync,
} from "./release";
import { tryCatch, tryCatchSync } from "./try-catch";
import { COLORS } from "./logger";
import pkg from "../../package.json";

const STAGING_FILENAME = ".worktree.next";
const META_SIDECAR_FILENAME = ".worktree.next.meta";
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 2_000;
const MAX_ERROR_LOG_BYTES = 64 * 1024;
const ERROR_LOG_KEEP_LINES = 20;
const PROBE_STDERR_TRUNCATE_BYTES = 500;
const INTERNAL_CHECK_SUBCOMMAND = "__internal_update_check";
const SIDECAR_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const SIDECAR_HASH_PATTERN = /^[0-9a-f]{64}$/;
// Defer reaping partial stages: a concurrent producer mid-commit looks identical to an orphan.
const STAGING_ORPHAN_GRACE_MS = 60 * 1000;

function getBinaryDir(): string {
    return path.dirname(process.execPath);
}

function getStagingPath(): string {
    return path.join(getBinaryDir(), STAGING_FILENAME);
}

function getMetaSidecarPath(): string {
    return path.join(getBinaryDir(), META_SIDECAR_FILENAME);
}

function getCacheDir(): string {
    return path.join(os.homedir(), ".cache", "worktree-cli");
}

function getLastCheckPath(): string {
    return path.join(getCacheDir(), "last-check");
}

function getLastErrorPath(): string {
    return path.join(getCacheDir(), "last-error");
}

function ensureCacheDir(): void {
    fs.mkdirSync(getCacheDir(), { recursive: true });
}

let hasWarnedAboutLogFailure = false;
let hasCacheWriteFailed = false;
let hasWarnedAboutCacheWriteFailureOnce = false;

function warnLogFailureOnce(reason: string): void {
    if (hasWarnedAboutLogFailure) return;
    hasWarnedAboutLogFailure = true;
    const { DIM, RESET } = COLORS;
    console.error(
        `${DIM}worktree: auto-update error log unwritable (${reason}) — diagnostics unavailable${RESET}`
    );
}

function warnCacheWriteFailureOnce(reason: string): void {
    if (hasWarnedAboutCacheWriteFailureOnce) return;
    hasWarnedAboutCacheWriteFailureOnce = true;
    const { DIM, RESET } = COLORS;
    console.error(
        `${DIM}worktree: auto-update throttle cache unwritable (${reason}) — disabling auto-update for this process${RESET}`
    );
}

function appendBackgroundCheckPanic(error: unknown): void {
    const detail =
        error instanceof Error
            ? `${error.name}: ${error.message}\n${error.stack ?? "<no stack>"}`
            : String(error);
    appendLastError("check", `PANIC — ${detail.replace(/\n/g, "\n  ")}`);
}

function appendLastError(kind: "apply" | "check", message: string): void {
    try {
        ensureCacheDir();
        const line = `${new Date().toISOString()} ${kind}: ${message}\n`;
        const logPath = getLastErrorPath();
        rotateErrorLogIfOversized(logPath);
        fs.appendFileSync(logPath, line);
    } catch (error) {
        warnLogFailureOnce(
            error instanceof Error ? error.message : String(error)
        );
    }
}

function rotateErrorLogIfOversized(logPath: string): void {
    try {
        const stat = fs.statSync(logPath);
        if (stat.size <= MAX_ERROR_LOG_BYTES) return;
        const existing = fs.readFileSync(logPath, "utf8");
        const lines = existing.split("\n").filter(function (line) {
            return line !== "";
        });
        const kept = lines.slice(-ERROR_LOG_KEEP_LINES).join("\n") + "\n";
        fs.writeFileSync(logPath, kept);
    } catch (error) {
        if (isEnoent(error)) return;
        warnLogFailureOnce(
            error instanceof Error ? error.message : String(error)
        );
    }
}

type SidecarMeta = { version: string; sha256: string };

function formatSidecar(meta: SidecarMeta): string {
    return `version=${meta.version}\nsha256=${meta.sha256}\n`;
}

const SIDECAR_KNOWN_KEYS = new Set(["version", "sha256"]);

function parseSidecar(text: string): SidecarMeta | null {
    const kv: Record<string, string> = {};
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) return null;
        const key = trimmed.slice(0, eq).trim();
        if (!SIDECAR_KNOWN_KEYS.has(key)) return null;
        if (Object.prototype.hasOwnProperty.call(kv, key)) return null;
        kv[key] = trimmed.slice(eq + 1).trim();
    }
    const version = kv.version ?? "";
    const sha256 = (kv.sha256 ?? "").toLowerCase();
    if (!SIDECAR_VERSION_PATTERN.test(version)) return null;
    if (!SIDECAR_HASH_PATTERN.test(sha256)) return null;
    return { version, sha256 };
}

function cleanupStagedArtifacts(): void {
    safeUnlinkSync(getStagingPath());
    safeUnlinkSync(getMetaSidecarPath());
}

function checkExists(
    filePath: string,
    kind: "apply" | "check"
): boolean | null {
    const { error } = tryCatchSync(function () {
        return fs.statSync(filePath);
    });
    if (!error) return true;
    if (isEnoent(error)) return false;
    appendLastError(kind, `stat ${filePath}: ${error.message}`);
    return null;
}

function isWithinGracePeriod(filePath: string): boolean {
    const { data: stat, error } = tryCatchSync(function () {
        return fs.statSync(filePath);
    });
    if (error) {
        if (isEnoent(error)) return false;
        // Non-ENOENT: be conservative (return true) — never destroy a peer's stage on incomplete stat info.
        appendLastError("apply", `grace-stat: ${error.message}`);
        return true;
    }
    if (!stat) return false;
    return Date.now() - stat.mtimeMs < STAGING_ORPHAN_GRACE_MS;
}

function applyPendingUpdate(): void {
    if (process.env.WORKTREE_NO_UPDATE === "1") return;
    // Gate on config too: a staged binary must not apply if the user set AUTO_UPDATE=false after it was staged.
    const configAllows = shouldAutoUpdateSync(function (msg) {
        appendLastError("apply", msg);
    });
    if (!configAllows) return;
    try {
        if (!isStandalone()) return;
        const stagedPath = getStagingPath();
        const metaPath = getMetaSidecarPath();
        const stagedExists = checkExists(stagedPath, "apply");
        if (stagedExists === null) return;
        if (!stagedExists) {
            // Within grace window, assume concurrent producer; past it, reap orphan.
            if (isWithinGracePeriod(metaPath)) return;
            safeUnlinkSync(metaPath);
            return;
        }

        const metaExists = checkExists(metaPath, "apply");
        if (metaExists === null) return;
        if (!metaExists) {
            if (isWithinGracePeriod(stagedPath)) return;
            safeUnlinkSync(stagedPath);
            appendLastError(
                "apply",
                "staged binary without sidecar — discarded"
            );
            warnApplyFailed("staged update was incomplete (missing metadata)");
            return;
        }

        const { data: metaText, error: metaReadError } = tryCatchSync(
            function () {
                return fs.readFileSync(metaPath, "utf8");
            }
        );
        if (metaReadError) {
            cleanupStagedArtifacts();
            appendLastError("apply", `sidecar read: ${metaReadError.message}`);
            warnApplyFailed(
                `could not read staged metadata (${metaReadError.message})`
            );
            return;
        }
        const meta = parseSidecar(metaText);
        if (!meta) {
            cleanupStagedArtifacts();
            appendLastError("apply", "sidecar malformed — discarded stage");
            warnApplyFailed("staged metadata was malformed");
            return;
        }

        // Gate against silent downgrade from a stale stage (e.g. foreground update raced a background check).
        const stageCmp = compareVersions(pkg.version, meta.version);
        if (stageCmp > 0) {
            cleanupStagedArtifacts();
            appendLastError(
                "apply",
                `discarded stale stage v${meta.version} (running v${pkg.version})`
            );
            recordCheckCompleted();
            return;
        }
        if (stageCmp === 0) {
            cleanupStagedArtifacts();
            return;
        }

        const verify = verifyBinaryHashSync(stagedPath, meta.sha256);
        if (!verify.ok) {
            cleanupStagedArtifacts();
            if (verify.kind === "io-error") {
                appendLastError(
                    "apply",
                    `hash io-error: ${verify.cause.message}`
                );
                warnApplyFailed(
                    `could not read staged binary (${verify.cause.message})`
                );
            } else {
                appendLastError("apply", "staged binary hash mismatch");
                warnApplyFailed(
                    "staged binary failed integrity check — discarded"
                );
            }
            return;
        }

        const { error: renameError } = tryCatchSync(function () {
            fs.renameSync(stagedPath, process.execPath);
        });
        if (renameError) {
            // Persistent rename failures won't self-heal; cleanup to avoid looping on every launch.
            cleanupStagedArtifacts();
            const writeCode = classifyWriteError(renameError);
            const rawCode = (renameError as NodeJS.ErrnoException).code;
            appendLastError(
                "apply",
                `rename ${rawCode ?? "unknown"}: ${renameError.message}`
            );
            if (writeCode !== null) {
                warnApplyFailed(
                    `binary directory not writable (${writeCode}) — run "sudo worktree update" to install the pending update manually`
                );
            } else {
                warnApplyFailed(
                    `rename failed (${rawCode ?? renameError.message}) — staged update discarded`
                );
            }
            return;
        }
        safeUnlinkSync(metaPath);
        // Bump throttle so the sibling scheduleBackgroundUpdateCheck doesn't redundantly re-check.
        recordCheckCompleted();

        const { GREEN, BOLD, RESET } = COLORS;
        console.error(
            `worktree ${GREEN}${BOLD}auto-updated${RESET} to ${BOLD}v${meta.version}${RESET}`
        );
    } catch (error) {
        // Swallow errno-style I/O only; let programmer bugs propagate with a stack trace.
        if (!(error instanceof Error) || !("code" in error)) {
            throw error;
        }
        appendLastError("apply", error.message);
        warnApplyFailed(error.message);
    }
}

function warnApplyFailed(reason: string): void {
    const { DIM, RESET } = COLORS;
    console.error(
        `${DIM}worktree: could not apply staged update (${reason}); continuing with current version${RESET}`
    );
}

async function readLastCheckMs(): Promise<number | null> {
    const file = Bun.file(getLastCheckPath());
    const { data: exists, error: existsError } = await tryCatch(file.exists());
    if (existsError) {
        appendLastError("check", `last-check exists: ${existsError.message}`);
        return null;
    }
    if (!exists) return null;
    const { data: text, error } = await tryCatch(file.text());
    if (error) {
        appendLastError("check", `last-check read: ${error.message}`);
        return null;
    }
    if (!text) return null;
    const parsed = Number(text.trim());
    if (!Number.isFinite(parsed)) {
        appendLastError(
            "check",
            `last-check corrupt: ${JSON.stringify(text.slice(0, 40))}`
        );
        return null;
    }
    return parsed;
}

async function isAutoUpdateDisabled(): Promise<boolean> {
    if (process.env.WORKTREE_NO_UPDATE === "1") return true;
    // Fail CLOSED on broken config so a typo can't silently disable auto-update.
    return !(await shouldAutoUpdate(function (msg) {
        appendLastError("check", msg);
    }));
}

async function scheduleBackgroundUpdateCheck(): Promise<void> {
    try {
        if (!isStandalone()) return;
        // Skip spawn if cache is unwritable; the child would also fail and burn API quota.
        if (hasCacheWriteFailed) return;
        if (await isAutoUpdateDisabled()) return;

        const lastCheck = await readLastCheckMs();
        const now = Date.now();
        const shouldSkip =
            lastCheck !== null &&
            now - lastCheck >= 0 &&
            now - lastCheck < TWENTY_FOUR_HOURS_MS;
        if (shouldSkip) return;

        // Only the child writes last-check on success, so a failed check never burns the 24h window.
        // Child stderr is funneled to last-error so background panics are visible on the next launch.
        const { data: stderrFd, error: stderrOpenError } = tryCatchSync(
            function () {
                ensureCacheDir();
                return fs.openSync(getLastErrorPath(), "a");
            }
        );
        if (stderrOpenError) {
            // If we can't capture the child's stderr, don't spawn blind — the
            // throttle cache lives in the same dir, so it's likely unwritable too.
            hasCacheWriteFailed = true;
            warnCacheWriteFailureOnce(stderrOpenError.message);
            return;
        }
        try {
            Bun.spawn({
                cmd: [process.execPath, INTERNAL_CHECK_SUBCOMMAND],
                stdin: "ignore",
                stdout: "ignore",
                stderr: stderrFd,
                // POSIX setsid(): survives terminal close so a slow download isn't SIGHUPed.
                detached: true,
            }).unref();
        } finally {
            // Close parent's fd copy even if Bun.spawn throws synchronously (else fd leak per launch).
            const inheritedFd = stderrFd;
            tryCatchSync(function () {
                fs.closeSync(inheritedFd);
            });
        }
    } catch (error) {
        // Swallow errno-style only; let programmer bugs propagate.
        if (!(error instanceof Error) || !("code" in error)) {
            throw error;
        }
        appendLastError("check", `spawn: ${error.message}`);
    }
}

function recordCheckCompleted(): void {
    if (hasCacheWriteFailed) return;
    const { error } = tryCatchSync(function () {
        ensureCacheDir();
        fs.writeFileSync(getLastCheckPath(), String(Date.now()));
    });
    if (error) {
        // Latch: future calls and scheduleBackgroundUpdateCheck short-circuit.
        hasCacheWriteFailed = true;
        appendLastError("check", `last-check write: ${error.message}`);
        warnCacheWriteFailureOnce(error.message);
    }
}

async function runBackgroundUpdateCheck(): Promise<void> {
    const assetName = getAssetName();
    if (!assetName) {
        // Structural — burn throttle so we don't thrash the API.
        appendLastError("check", `unsupported platform/arch`);
        recordCheckCompleted();
        return;
    }

    const { data: release, error: releaseError } =
        await tryCatch(fetchLatestRelease());
    if (releaseError || !release) {
        appendLastError(
            "check",
            `fetchLatestRelease: ${releaseError?.message ?? "unknown"}`
        );
        recordCheckCompleted();
        return;
    }

    if (compareVersions(pkg.version, release.version) >= 0) {
        recordCheckCompleted();
        return;
    }

    const asset = release.assets.find(function (entry) {
        return entry.name === assetName;
    });
    if (!asset) {
        // Transient: maintainer may upload the missing arch later; don't burn throttle.
        appendLastError(
            "check",
            `release ${release.tag} missing asset ${assetName}`
        );
        return;
    }

    const binaryDir = getBinaryDir();
    const tmpPath = path.join(
        binaryDir,
        `${STAGING_FILENAME}.${randomBytes(8).toString("hex")}.tmp`
    );

    // Pre-unlink to prevent the write from following a planted symlink.
    safeUnlinkSync(tmpPath);
    const { error: dlError } = await tryCatch(
        downloadAsset(asset, tmpPath, undefined, function (op, downloadErr) {
            appendLastError("check", `${op}: ${downloadErr.message}`);
        })
    );
    if (dlError) {
        safeUnlinkSync(tmpPath);
        appendLastError("check", `download: ${dlError.message}`);
        recordCheckCompleted();
        return;
    }

    // Verify BEFORE chmod/probe: running an unverified binary is code execution.
    const verify = await verifyAssetAgainstSums(
        tmpPath,
        assetName,
        release.assets
    );
    if (!verify.ok) {
        safeUnlinkSync(tmpPath);
        if (verify.kind === "sums-tamper") {
            appendLastError(
                "check",
                `TAMPER: SHA256SUMS for ${assetName} is malformed (${verify.reason}) — refusing to stage`
            );
            recordCheckCompleted();
        } else if (verify.kind === "sums-error") {
            appendLastError(
                "check",
                `SHA256SUMS fetch failed — refusing to stage: ${verify.reason}`
            );
            // Burn throttle for permanent failures; transient ones keep retrying.
            if (!verify.retryable) {
                recordCheckCompleted();
            }
        } else if (verify.kind === "missing-entry") {
            appendLastError(
                "check",
                `SHA256SUMS missing entry for ${assetName}`
            );
            recordCheckCompleted();
        } else if (verify.kind === "hash-io-error") {
            // Local IO may be transient (disk full mid-write); don't burn throttle.
            appendLastError(
                "check",
                `hash io-error for ${assetName}: ${verify.cause.message}`
            );
        } else {
            appendLastError("check", `hash mismatch for ${assetName}`);
            recordCheckCompleted();
        }
        return;
    }
    let verifiedHash: string | null = verify.hash;

    const { error: chmodError } = tryCatchSync(function () {
        fs.chmodSync(tmpPath, 0o755);
    });
    if (chmodError) {
        safeUnlinkSync(tmpPath);
        appendLastError("check", `chmod: ${chmodError.message}`);
        if (classifyWriteError(chmodError) !== null) {
            recordCheckCompleted();
        }
        return;
    }

    const probe = probeBinaryRuns(tmpPath);
    if (!probe.ok) {
        safeUnlinkSync(tmpPath);
        appendLastError("check", `probe: ${probe.reason}`);
        // Probe fail is structural for this release — burn throttle or we redownload 50 MB every launch.
        recordCheckCompleted();
        return;
    }

    // Legacy release lacks SHA256SUMS; self-hash only detects local stage→apply corruption, not upstream tampering.
    if (verifiedHash === null) {
        const { data: computed, error: hashError } = tryCatchSync(function () {
            return computeSha256Sync(tmpPath);
        });
        if (hashError || !computed) {
            safeUnlinkSync(tmpPath);
            appendLastError(
                "check",
                `post-probe hash: ${hashError?.message ?? "unknown"}`
            );
            return;
        }
        verifiedHash = computed;
    }

    // Lock writer to reader's pattern so a future parser relaxation can't turn a crafted tag into a hash-spoof.
    if (!SIDECAR_VERSION_PATTERN.test(release.version)) {
        safeUnlinkSync(tmpPath);
        appendLastError(
            "check",
            `invalid release version for sidecar: ${JSON.stringify(release.version.slice(0, 40))}`
        );
        return;
    }

    const metaTmpPath = path.join(
        binaryDir,
        `${META_SIDECAR_FILENAME}.${randomBytes(8).toString("hex")}.tmp`
    );
    const sidecarContent = formatSidecar({
        version: release.version,
        sha256: verifiedHash,
    });
    safeUnlinkSync(metaTmpPath);
    const { error: metaWriteError } = tryCatchSync(function () {
        fs.writeFileSync(metaTmpPath, sidecarContent);
    });
    if (metaWriteError) {
        safeUnlinkSync(tmpPath);
        safeUnlinkSync(metaTmpPath);
        appendLastError("check", `sidecar write: ${metaWriteError.message}`);
        // Structural permission/readonly errors won't self-heal; burn throttle.
        if (classifyWriteError(metaWriteError) !== null) {
            recordCheckCompleted();
        }
        return;
    }
    const { error: metaRenameError } = tryCatchSync(function () {
        fs.renameSync(metaTmpPath, getMetaSidecarPath());
    });
    if (metaRenameError) {
        safeUnlinkSync(tmpPath);
        safeUnlinkSync(metaTmpPath);
        appendLastError("check", `sidecar commit: ${metaRenameError.message}`);
        if (classifyWriteError(metaRenameError) !== null) {
            recordCheckCompleted();
        }
        return;
    }

    const { error: renameError } = tryCatchSync(function () {
        fs.renameSync(tmpPath, getStagingPath());
    });
    if (renameError) {
        safeUnlinkSync(tmpPath);
        safeUnlinkSync(getMetaSidecarPath());
        appendLastError("check", `stage: ${renameError.message}`);
        if (classifyWriteError(renameError) !== null) {
            recordCheckCompleted();
        }
        return;
    }

    recordCheckCompleted();
}

type ProbeResult = { ok: true } | { ok: false; reason: string };

const PROBE_VERSION_PATTERN = /\d+\.\d+\.\d+/;

function probeBinaryRuns(filePath: string): ProbeResult {
    const { data: result, error } = tryCatchSync(function () {
        return Bun.spawnSync({
            cmd: [filePath, "--version"],
            // Capture stdout to reject exit-0-with-garbage as a valid probe.
            stdout: "pipe",
            stderr: "pipe",
            timeout: PROBE_TIMEOUT_MS,
            // Disable auto-update in the probe to prevent grandchild spawn / stale-stage consumption.
            env: { ...process.env, WORKTREE_NO_UPDATE: "1" },
        });
    });
    if (error || !result) {
        return {
            ok: false,
            reason: error?.message ?? "spawn failed",
        };
    }
    if (result.exitCode === null) {
        // Bun.spawnSync returns null exitCode on timeout kill.
        return {
            ok: false,
            reason: `timed out after ${PROBE_TIMEOUT_MS}ms`,
        };
    }
    if (result.exitCode !== 0) {
        const stderr = decodeProbeStream(result.stderr);
        const base = `exit ${result.exitCode}`;
        return { ok: false, reason: stderr ? `${base}: ${stderr}` : base };
    }
    const stdout = decodeProbeStream(result.stdout);
    if (!PROBE_VERSION_PATTERN.test(stdout)) {
        const truncated = stdout.slice(0, 80);
        return {
            ok: false,
            reason: `version output did not match expected format: ${JSON.stringify(truncated)}`,
        };
    }
    return { ok: true };
}

function decodeProbeStream(stream: unknown): string {
    if (!(stream instanceof Uint8Array) && !(stream instanceof Buffer)) {
        // Emit a debuggable marker (not "") so a Bun API shape change is visible in last-error.
        return `<probe stream type=${typeof stream}>`;
    }
    const bytes = stream instanceof Buffer ? new Uint8Array(stream) : stream;
    const truncated = bytes.slice(0, PROBE_STDERR_TRUNCATE_BYTES);
    return new TextDecoder().decode(truncated).trim();
}

export {
    appendBackgroundCheckPanic,
    applyPendingUpdate,
    cleanupStagedArtifacts,
    probeBinaryRuns,
    recordCheckCompleted,
    scheduleBackgroundUpdateCheck,
    runBackgroundUpdateCheck,
    INTERNAL_CHECK_SUBCOMMAND,
};
