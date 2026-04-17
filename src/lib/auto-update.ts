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
    verifyBinaryHash,
} from "./release";
import { tryCatch, tryCatchSync } from "./try-catch";
import { COLORS } from "./constants";
import pkg from "../../package.json";

const STAGING_FILENAME = ".worktree.next";
const VERSION_SIDECAR_FILENAME = ".worktree.next.version";
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 2_000;
const INTERNAL_CHECK_SUBCOMMAND = "__internal_update_check";

function isStandalone(): boolean {
    return (
        Bun.main.startsWith("/$bunfs/") || import.meta.url.includes("$bunfs/")
    );
}

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
        fs.appendFileSync(getLastErrorPath(), line);
    } catch {
        // never let the error log itself block anything
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

        // Best-effort throttle: two simultaneous launches may both check.
        // Accepted trade-off — worst case is 2 API calls within the anon 60/hr limit.
        ensureCacheDir();
        fs.writeFileSync(getLastCheckPath(), String(now));

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

    if (compareVersions(pkg.version, release.version) >= 0) return;

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

    const probe = probeBinaryVersion(tmpPath);
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

    tryCatchSync(function () {
        fs.writeFileSync(getVersionSidecarPath(), probe.version);
    });
}

type ProbeResult =
    | { ok: true; version: string }
    | { ok: false; reason: string };

function probeBinaryVersion(filePath: string): ProbeResult {
    let result;
    try {
        result = Bun.spawnSync({
            cmd: [filePath, "--version"],
            stdout: "pipe",
            stderr: "pipe",
            timeout: PROBE_TIMEOUT_MS,
        });
    } catch (error) {
        return {
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
        };
    }

    if (result.exitCode !== 0) {
        return { ok: false, reason: `exit ${result.exitCode}` };
    }

    const stdout = result.stdout.toString("utf8");
    const stderr = result.stderr.toString("utf8");
    const match = /v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(
        stdout + "\n" + stderr
    );
    if (!match) return { ok: false, reason: "no version in --version output" };
    return { ok: true, version: match[1] };
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
