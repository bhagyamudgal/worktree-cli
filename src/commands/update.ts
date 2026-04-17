import { command } from "@drizzle-team/brocli";
import fs from "node:fs/promises";
import pkg from "../../package.json";
import { tryCatch } from "../lib/try-catch";
import { printSuccess, printError, printInfo, COLORS } from "../lib/logger";
import { EXIT_CODES } from "../lib/constants";
import {
    compareVersions,
    downloadAsset,
    fetchLatestRelease,
    fetchSha256Sums,
    getAssetName,
    verifyBinaryHash,
} from "../lib/release";

function isStandaloneBinary(): boolean {
    return (
        Bun.main.startsWith("/$bunfs/") || import.meta.url.includes("$bunfs/")
    );
}

function isEaccesError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (!("code" in error)) return false;
    return (error as NodeJS.ErrnoException).code === "EACCES";
}

export const updateCommand = command({
    name: "update",
    desc: "Update worktree CLI to the latest version",
    handler: async () => {
        if (!isStandaloneBinary()) {
            printError(
                "Update is only available for standalone compiled binaries."
            );
            printError("Run from the installed binary, not via bun run.");
            process.exit(EXIT_CODES.ERROR);
        }

        const assetName = getAssetName();
        if (!assetName) {
            printError(
                `Unsupported platform/arch: ${process.platform}/${process.arch}`
            );
            process.exit(EXIT_CODES.ERROR);
        }

        const currentVersion = pkg.version;
        const binaryPath = process.execPath;

        printInfo(`Current version: v${currentVersion}`);

        const { data: release, error: releaseError } =
            await tryCatch(fetchLatestRelease());
        if (releaseError || !release) {
            printError(
                releaseError?.message ??
                    "Failed to check for updates. Check your internet connection."
            );
            process.exit(EXIT_CODES.ERROR);
        }

        printInfo(`Latest version:  v${release.version}`);
        console.error("");

        const cmp = compareVersions(currentVersion, release.version);
        if (cmp === 0) {
            printSuccess("Already up to date!");
            return;
        }
        if (cmp > 0) {
            printSuccess(
                "Current version is newer than the latest release. No update needed."
            );
            return;
        }

        const asset = release.assets.find(function (entry) {
            return entry.name === assetName;
        });
        if (!asset) {
            printError(`Release ${release.tag} is missing asset ${assetName}.`);
            process.exit(EXIT_CODES.ERROR);
        }

        printInfo(`Downloading ${assetName}...`);

        const tmpPath = `${binaryPath}.update-tmp`;
        const { error: dlError } = await tryCatch(
            downloadAsset(asset, tmpPath)
        );
        if (dlError) {
            await fs.unlink(tmpPath).catch(function () {});
            printError(dlError.message);
            process.exit(EXIT_CODES.ERROR);
        }

        const { error: chmodError } = await tryCatch(fs.chmod(tmpPath, 0o755));
        if (chmodError) {
            await fs.unlink(tmpPath).catch(function () {});
            printError(
                `Failed to mark binary executable: ${chmodError.message}`
            );
            process.exit(EXIT_CODES.ERROR);
        }

        const sums = await fetchSha256Sums(release.assets);
        if (sums.kind === "error") {
            await fs.unlink(tmpPath).catch(function () {});
            printError(
                `SHA256SUMS is published but could not be fetched: ${sums.reason}. Refusing to install.`
            );
            process.exit(EXIT_CODES.ERROR);
        }
        if (sums.kind === "ok") {
            const expected = sums.sums[assetName];
            if (!expected) {
                await fs.unlink(tmpPath).catch(function () {});
                printError(
                    `SHA256SUMS is missing an entry for ${assetName}; refusing to install.`
                );
                process.exit(EXIT_CODES.ERROR);
            }
            const ok = await verifyBinaryHash(tmpPath, expected);
            if (!ok) {
                await fs.unlink(tmpPath).catch(function () {});
                printError(
                    `Hash mismatch for ${assetName}; refusing to install.`
                );
                process.exit(EXIT_CODES.ERROR);
            }
            printInfo("Verified SHA256 checksum.");
        } else {
            printInfo(
                "No SHA256SUMS published for this release; proceeding without hash verification."
            );
        }

        const { error: renameError } = await tryCatch(
            fs.rename(tmpPath, binaryPath)
        );
        if (renameError) {
            await fs.unlink(tmpPath).catch(function () {});
            if (isEaccesError(renameError)) {
                printError("Permission denied. Try: sudo worktree update");
            } else {
                printError(`Failed to replace binary: ${renameError.message}`);
            }
            process.exit(EXIT_CODES.ERROR);
        }

        const { BOLD, GREEN, DIM, RESET } = COLORS;
        console.error("");
        console.error(
            `${GREEN}${BOLD}Updated!${RESET} v${currentVersion} → v${release.version}`
        );
        console.error(`  ${DIM}Binary: ${binaryPath}${RESET}`);
    },
});
