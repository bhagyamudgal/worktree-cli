import { command } from "@drizzle-team/brocli";
import fs from "node:fs/promises";
import pkg from "../../package.json";
import { tryCatch } from "../lib/try-catch";
import { printSuccess, printError, printInfo, COLORS } from "../lib/logger";
import { EXIT_CODES } from "../lib/constants";
import {
    classifyWriteError,
    deepestMessage,
    safeUnlink,
} from "../lib/fs-utils";
import {
    compareVersions,
    downloadAsset,
    fetchLatestRelease,
    getAssetName,
    isStandalone,
    verifyAssetAgainstSums,
} from "../lib/release";
import {
    cleanupStagedArtifacts,
    recordCheckCompleted,
} from "../lib/auto-update";

export const updateCommand = command({
    name: "update",
    desc: "Update worktree CLI to the latest version",
    handler: async () => {
        if (!isStandalone()) {
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
                releaseError
                    ? `Failed to check for updates: ${deepestMessage(releaseError)}`
                    : "Failed to check for updates. Check your internet connection."
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
        // Pre-unlink to prevent symlink-follow in shared install dirs.
        await safeUnlink(tmpPath);
        const { error: dlError } = await tryCatch(
            downloadAsset(asset, tmpPath)
        );
        if (dlError) {
            await safeUnlink(tmpPath);
            if (classifyWriteError(dlError) !== null) {
                printError(
                    `Permission denied (${deepestMessage(dlError)}). Try: sudo worktree update`
                );
            } else {
                printError(deepestMessage(dlError));
            }
            process.exit(EXIT_CODES.ERROR);
        }

        const verify = await verifyAssetAgainstSums(
            tmpPath,
            assetName,
            release.assets
        );
        if (!verify.ok) {
            await safeUnlink(tmpPath);
            if (verify.kind === "sums-error") {
                printError(
                    `SHA256SUMS is published but could not be fetched: ${verify.reason}. Refusing to install.`
                );
            } else if (verify.kind === "missing-entry") {
                printError(
                    `SHA256SUMS is missing an entry for ${assetName}; refusing to install.`
                );
            } else if (verify.kind === "hash-io-error") {
                printError(
                    `Could not read downloaded binary for hash check: ${verify.cause.message}.`
                );
            } else {
                printError(
                    `Hash mismatch for ${assetName}; refusing to install.`
                );
            }
            process.exit(EXIT_CODES.ERROR);
        }
        if (verify.hash !== null) {
            printInfo("Verified SHA256 checksum.");
        } else {
            printInfo(
                "No SHA256SUMS published for this release; proceeding without hash verification."
            );
        }

        const { error: chmodError } = await tryCatch(fs.chmod(tmpPath, 0o755));
        if (chmodError) {
            await safeUnlink(tmpPath);
            printError(
                `Failed to mark binary executable: ${chmodError.message}`
            );
            process.exit(EXIT_CODES.ERROR);
        }

        const { error: renameError } = await tryCatch(
            fs.rename(tmpPath, binaryPath)
        );
        if (renameError) {
            await safeUnlink(tmpPath);
            if (classifyWriteError(renameError) !== null) {
                printError(
                    `Permission denied (${deepestMessage(renameError)}). Try: sudo worktree update`
                );
            } else {
                printError(
                    `Failed to replace binary: ${deepestMessage(renameError)}`
                );
            }
            process.exit(EXIT_CODES.ERROR);
        }

        // Invalidate pending stage + bump throttle to prevent silent downgrade on next launch.
        cleanupStagedArtifacts();
        recordCheckCompleted();

        const { BOLD, GREEN, DIM, RESET } = COLORS;
        console.error("");
        console.error(
            `${GREEN}${BOLD}Updated!${RESET} v${currentVersion} → v${release.version}`
        );
        console.error(`  ${DIM}Binary: ${binaryPath}${RESET}`);
    },
});
