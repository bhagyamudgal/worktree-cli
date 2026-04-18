import { command } from "@drizzle-team/brocli";
import fs from "node:fs/promises";
import pkg from "../../package.json";
import { tryCatch } from "../lib/try-catch";
import { printSuccess, printError, printInfo, COLORS } from "../lib/logger";
import { EXIT_CODES } from "../lib/constants";
import { safeUnlink } from "../lib/fs-utils";
import {
    compareVersions,
    downloadAsset,
    fetchLatestRelease,
    fetchSha256Sums,
    getAssetName,
    isStandalone,
    verifyBinaryHash,
} from "../lib/release";

function isEaccesError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if ("code" in error && (error as NodeJS.ErrnoException).code === "EACCES") {
        return true;
    }
    // release.ts wraps errno errors as `new Error(msg, { cause })` — walk the
    // chain so EACCES surfaces even when the top-level Error lacks .code.
    if ("cause" in error && error.cause) return isEaccesError(error.cause);
    return false;
}

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
            await safeUnlink(tmpPath);
            if (isEaccesError(dlError)) {
                printError("Permission denied. Try: sudo worktree update");
            } else {
                printError(dlError.message);
            }
            process.exit(EXIT_CODES.ERROR);
        }

        const sums = await fetchSha256Sums(release.assets);
        if (sums.kind === "error") {
            await safeUnlink(tmpPath);
            printError(
                `SHA256SUMS is published but could not be fetched: ${sums.reason}. Refusing to install.`
            );
            process.exit(EXIT_CODES.ERROR);
        }
        if (sums.kind === "ok") {
            const expected = sums.sums[assetName];
            if (!expected) {
                await safeUnlink(tmpPath);
                printError(
                    `SHA256SUMS is missing an entry for ${assetName}; refusing to install.`
                );
                process.exit(EXIT_CODES.ERROR);
            }
            const result = await verifyBinaryHash(tmpPath, expected);
            if (!result.ok) {
                await safeUnlink(tmpPath);
                if (result.kind === "io-error") {
                    printError(
                        `Could not read downloaded binary for hash check: ${result.cause.message}.`
                    );
                } else {
                    printError(
                        `Hash mismatch for ${assetName}; refusing to install.`
                    );
                }
                process.exit(EXIT_CODES.ERROR);
            }
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
