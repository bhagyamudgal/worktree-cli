import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGlobalConfig } from "./config";
import {
    compareVersions,
    downloadAsset,
    fetchLatestRelease,
    fetchSha256Sums,
    getAssetName,
    isStandalone,
    verifyBinaryHash,
} from "./release";
import { tryCatch, tryCatchSync } from "./try-catch";
import { COLORS } from "./logger";
import pkg from "../../package.json";

const STAGING_FILENAME = ".worktree.next";
const VERSION_SIDECAR_FILENAME = ".worktree.next.version";
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 2_000;
const MAX_ERROR_LOG_BYTES = 64 * 1024;
const ERROR_LOG_KEEP_LINES = 20;
const INTERNAL_CHECK_SUBCOMMAND = "__internal_update_check";

function getBinaryDir(): string {
    return path.dirname(process.execPath);
}

function getStagingPath(): string {
    return path.join(getBinaryDir(), STAGING_FILENAME);
}

function getVersionSidecarPath(): string {
    return path.join(getBinaryDir(), VERSION_SIDECAR_FILENAME);
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

function applyPendingUpdate(): void {
    // Sync on purpose: runs before brocli.run; avoids top-level await.
    try {
        if (!isStandalone()) return;
        const stagedPath = getStagingPath();
        if (!fs.existsSync(stagedPath)) return;

        let newVersion = "";
        try {
            newVersion = fs
                .readFileSync(getVersionSidecarPath(), "utf8")
                .trim();
        } catch {
            // missing sidecar is not fatal
        }

        fs.renameSync(stagedPath, process.execPath);
        try {
            fs.unlinkSync(getVersionSidecarPath());
        } catch {
            // best-effort cleanup
        }

        const { GREEN, BOLD, RESET } = COLORS;
        const label = newVersion ? ` to ${BOLD}v${newVersion}${RESET}` : "";
        console.error(`worktree ${GREEN}${BOLD}auto-updated${RESET}${label}`);
    } catch (error) {
        appendLastError(
            "apply",
            error instanceof Error ? error.message : String(error)
        );
    }
}

async function readLastCheckMs(): Promise<number | null> {
    const { data: text, error } = await tryCatch(
        Bun.file(getLastCheckPath()).text()
    );
    if (error || !text) return null;
    const parsed = Number(text.trim());
    if (!Number.isFinite(parsed)) return null;
    return parsed;
}

async function isAutoUpdateDisabled(): Promise<boolean> {
    if (process.env.WORKTREE_NO_UPDATE === "1") return true;
    const { data: config, error } = await tryCatch(loadGlobalConfig());
    if (error || !config) return false;
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
        }).unref();
    } catch {
        // never block the user's command
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
        appendLastError("check", `unsupported platform/arch`);
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

    const { error: dlError } = await tryCatch(downloadAsset(asset, tmpPath));
    if (dlError) {
        safeUnlink(tmpPath);
        appendLastError("check", `download: ${dlError.message}`);
        return;
    }

    // Verify integrity BEFORE making the binary executable or running it.
    // Running an unverified binary (even just `--version`) is code execution.
    const sums = await fetchSha256Sums(release.assets);
    if (sums.kind === "error") {
        safeUnlink(tmpPath);
        appendLastError(
            "check",
            `SHA256SUMS fetch failed — refusing to stage: ${sums.reason}`
        );
        return;
    }
    if (sums.kind === "ok") {
        const expected = sums.sums[assetName];
        if (!expected) {
            safeUnlink(tmpPath);
            appendLastError(
                "check",
                `SHA256SUMS missing entry for ${assetName}`
            );
            return;
        }
        const ok = await verifyBinaryHash(tmpPath, expected);
        if (!ok) {
            safeUnlink(tmpPath);
            appendLastError("check", `hash mismatch for ${assetName}`);
            return;
        }
    }
    // sums.kind === "not-published" → legacy release without SHA256SUMS; trust TLS.

    const { error: chmodError } = tryCatchSync(function () {
        fs.chmodSync(tmpPath, 0o755);
    });
    if (chmodError) {
        safeUnlink(tmpPath);
        appendLastError("check", `chmod: ${chmodError.message}`);
        return;
    }

    const probe = probeBinaryRuns(tmpPath);
    if (!probe.ok) {
        safeUnlink(tmpPath);
        appendLastError("check", `probe: ${probe.reason}`);
        return;
    }

    const { error: renameError } = tryCatchSync(function () {
        fs.renameSync(tmpPath, getStagingPath());
    });
    if (renameError) {
        safeUnlink(tmpPath);
        appendLastError("check", `stage: ${renameError.message}`);
        return;
    }

    const { error: sidecarError } = tryCatchSync(function () {
        fs.writeFileSync(getVersionSidecarPath(), release.version);
    });
    if (sidecarError) {
        appendLastError("check", `sidecar: ${sidecarError.message}`);
    }

    recordCheckCompleted();
}

type ProbeResult = { ok: true } | { ok: false; reason: string };

function probeBinaryRuns(filePath: string): ProbeResult {
    const { data: result, error } = tryCatchSync(function () {
        return Bun.spawnSync({
            cmd: [filePath, "--version"],
            stdout: "ignore",
            stderr: "ignore",
            timeout: PROBE_TIMEOUT_MS,
        });
    });
    if (error || !result) {
        return {
            ok: false,
            reason: error?.message ?? "spawn failed",
        };
    }
    if (result.exitCode !== 0) {
        return { ok: false, reason: `exit ${result.exitCode}` };
    }
    return { ok: true };
}

function safeUnlink(filePath: string): void {
    try {
        fs.unlinkSync(filePath);
    } catch {
        // best-effort
    }
}

export {
    applyPendingUpdate,
    scheduleBackgroundUpdateCheck,
    runBackgroundUpdateCheck,
    INTERNAL_CHECK_SUBCOMMAND,
};
