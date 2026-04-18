import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGlobalConfig } from "./config";
import { classifyWriteError, safeUnlinkSync } from "./fs-utils";
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

function appendLastError(kind: "apply" | "check", message: string): void {
    try {
        ensureCacheDir();
        const line = `${new Date().toISOString()} ${kind}: ${message}\n`;
        const logPath = getLastErrorPath();
        rotateErrorLogIfOversized(logPath);
        fs.appendFileSync(logPath, line);
    } catch {
        // never let the error log itself block anything
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
    } catch {
        // best-effort rotation — if stat/read/write fails, fall through
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

function applyPendingUpdate(): void {
    // Sync on purpose: runs before brocli.run; avoids top-level await.
    if (process.env.WORKTREE_NO_UPDATE === "1") return;
    try {
        if (!isStandalone()) return;
        const stagedPath = getStagingPath();
        if (!fs.existsSync(stagedPath)) {
            // Orphan sidecar from an interrupted stage — clean it up so it
            // doesn't linger forever waiting for a binary that never comes.
            safeUnlinkSync(getMetaSidecarPath());
            return;
        }

        const metaPath = getMetaSidecarPath();
        if (!fs.existsSync(metaPath)) {
            // Staging was partial; clean up the orphaned binary.
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
            // Always cleanup so a persistent rename failure (ETXTBSY, EXDEV,
            // ENOSPC, EIO, EBUSY, EACCES/EPERM/EROFS) doesn't loop on every
            // launch — if rename fails once it's almost certainly going to
            // fail again until the user intervenes.
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
        // Bump the throttle so the sibling scheduleBackgroundUpdateCheck() in
        // src/index.ts doesn't spawn a redundant child-check immediately after
        // a just-applied update — the new binary is already current.
        recordCheckCompleted();

        const { GREEN, BOLD, RESET } = COLORS;
        console.error(
            `worktree ${GREEN}${BOLD}auto-updated${RESET} to ${BOLD}v${meta.version}${RESET}`
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendLastError("apply", message);
        warnApplyFailed(message);
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
    const config = await loadGlobalConfig();
    return config.AUTO_UPDATE === false;
}

async function scheduleBackgroundUpdateCheck(): Promise<void> {
    try {
        if (!isStandalone()) return;
        if (await isAutoUpdateDisabled()) return;

        const lastCheck = await readLastCheckMs();
        const now = Date.now();
        const shouldSkip =
            lastCheck !== null &&
            now - lastCheck >= 0 &&
            now - lastCheck < TWENTY_FOUR_HOURS_MS;
        if (shouldSkip) return;

        // Parent does NOT write last-check; the child writes it after a
        // successful check completes. Simultaneous launches may both spawn
        // (accepted trade-off — worst case 2 API calls within the anon 60/hr
        // limit) but a failed check never burns the 24h window.
        Bun.spawn({
            cmd: [process.execPath, INTERNAL_CHECK_SUBCOMMAND],
            stdio: ["ignore", "ignore", "ignore"],
            stderr: "ignore",
            stdout: "ignore",
            stdin: "ignore",
            // POSIX: setsid() — survives terminal close (SIGHUP) so a slow
            // download isn't cut short when the user's shell exits.
            detached: true,
        }).unref();
    } catch (error) {
        // Only swallow errno-style errors (spawn failures, fs errors). Let
        // programmer bugs (TypeError, ReferenceError) propagate so they
        // surface via Bun's default unhandled-rejection handler.
        if (!(error instanceof Error) || !("code" in error)) {
            throw error;
        }
        appendLastError("check", `spawn: ${error.message}`);
    }
}

function recordCheckCompleted(): void {
    const { error } = tryCatchSync(function () {
        ensureCacheDir();
        fs.writeFileSync(getLastCheckPath(), String(Date.now()));
    });
    if (error) {
        appendLastError("check", `last-check write: ${error.message}`);
    }
}

async function runBackgroundUpdateCheck(): Promise<void> {
    const assetName = getAssetName();
    if (!assetName) {
        // Structural mismatch that won't be fixed by retrying sooner — burn
        // the 24h window to avoid thrashing GitHub's API on every launch.
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
        // Don't record completion — asset-missing is transient (maintainer may
        // upload the missing arch moments later). Let the next launch retry.
        appendLastError(
            "check",
            `release ${release.tag} missing asset ${assetName}`
        );
        return;
    }

    const binaryDir = getBinaryDir();
    const tmpPath = path.join(
        binaryDir,
        `${STAGING_FILENAME}.${process.pid}.tmp`
    );

    // Clear any pre-existing entry (symlink / leftover tmp) so the subsequent
    // write can't follow a planted symlink to an attacker-chosen target.
    safeUnlinkSync(tmpPath);
    const { error: dlError } = await tryCatch(downloadAsset(asset, tmpPath));
    if (dlError) {
        safeUnlinkSync(tmpPath);
        appendLastError("check", `download: ${dlError.message}`);
        return;
    }

    // Verify integrity BEFORE making the binary executable or running it.
    // Running an unverified binary (even just `--version`) is code execution.
    const verify = await verifyAssetAgainstSums(
        tmpPath,
        assetName,
        release.assets
    );
    if (!verify.ok) {
        safeUnlinkSync(tmpPath);
        if (verify.kind === "sums-error") {
            appendLastError(
                "check",
                `SHA256SUMS fetch failed — refusing to stage: ${verify.reason}`
            );
        } else if (verify.kind === "missing-entry") {
            appendLastError(
                "check",
                `SHA256SUMS missing entry for ${assetName}`
            );
        } else if (verify.kind === "hash-io-error") {
            appendLastError(
                "check",
                `hash io-error for ${assetName}: ${verify.cause.message}`
            );
        } else {
            appendLastError("check", `hash mismatch for ${assetName}`);
        }
        return;
    }
    // verify.hash === null → legacy release without SHA256SUMS; trust TLS.
    let verifiedHash: string | null = verify.hash;

    const { error: chmodError } = tryCatchSync(function () {
        fs.chmodSync(tmpPath, 0o755);
    });
    if (chmodError) {
        safeUnlinkSync(tmpPath);
        appendLastError("check", `chmod: ${chmodError.message}`);
        return;
    }

    const probe = probeBinaryRuns(tmpPath);
    if (!probe.ok) {
        safeUnlinkSync(tmpPath);
        appendLastError("check", `probe: ${probe.reason}`);
        return;
    }

    // Legacy releases without SHA256SUMS can't stage via the re-verify path
    // because applyPendingUpdate needs a hash to check. Compute it ourselves
    // from the probed binary so apply can still run.
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

    // Commit sidecar BEFORE the binary rename so applyPendingUpdate never
    // sees a staged binary without its metadata.
    const metaTmpPath = path.join(
        binaryDir,
        `${META_SIDECAR_FILENAME}.${process.pid}.tmp`
    );
    const sidecarContent = formatSidecar({
        version: release.version,
        sha256: verifiedHash,
    });
    // Same symlink-safety treatment as the binary tmpPath.
    safeUnlinkSync(metaTmpPath);
    const { error: metaWriteError } = tryCatchSync(function () {
        fs.writeFileSync(metaTmpPath, sidecarContent);
    });
    if (metaWriteError) {
        safeUnlinkSync(tmpPath);
        appendLastError("check", `sidecar write: ${metaWriteError.message}`);
        return;
    }
    const { error: metaRenameError } = tryCatchSync(function () {
        fs.renameSync(metaTmpPath, getMetaSidecarPath());
    });
    if (metaRenameError) {
        safeUnlinkSync(tmpPath);
        safeUnlinkSync(metaTmpPath);
        appendLastError("check", `sidecar commit: ${metaRenameError.message}`);
        return;
    }

    const { error: renameError } = tryCatchSync(function () {
        fs.renameSync(tmpPath, getStagingPath());
    });
    if (renameError) {
        safeUnlinkSync(tmpPath);
        safeUnlinkSync(getMetaSidecarPath());
        appendLastError("check", `stage: ${renameError.message}`);
        return;
    }

    recordCheckCompleted();
}

type ProbeResult = { ok: true } | { ok: false; reason: string };

function probeBinaryRuns(filePath: string): ProbeResult {
    const { data: result, error } = tryCatchSync(function () {
        return Bun.spawnSync({
            cmd: [filePath, "--version"],
            stdout: "ignore",
            stderr: "pipe",
            timeout: PROBE_TIMEOUT_MS,
            // Disable auto-update in the probe child — otherwise its top-level
            // scheduleBackgroundUpdateCheck could spawn a grandchild, and
            // applyPendingUpdate could consume a stale staged binary.
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
        // Bun.spawnSync returns exitCode=null when the child was killed by the
        // timeout — surface that explicitly instead of the opaque "exit null".
        return {
            ok: false,
            reason: `timed out after ${PROBE_TIMEOUT_MS}ms`,
        };
    }
    if (result.exitCode !== 0) {
        const stderr = decodeProbeStderr(result.stderr);
        const base = `exit ${result.exitCode}`;
        return { ok: false, reason: stderr ? `${base}: ${stderr}` : base };
    }
    return { ok: true };
}

function decodeProbeStderr(stderr: unknown): string {
    if (!(stderr instanceof Uint8Array) && !(stderr instanceof Buffer)) {
        return "";
    }
    const bytes = stderr instanceof Buffer ? new Uint8Array(stderr) : stderr;
    const truncated = bytes.slice(0, PROBE_STDERR_TRUNCATE_BYTES);
    return new TextDecoder().decode(truncated).trim();
}

export {
    applyPendingUpdate,
    scheduleBackgroundUpdateCheck,
    runBackgroundUpdateCheck,
    INTERNAL_CHECK_SUBCOMMAND,
};
