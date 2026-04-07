import { command } from "@drizzle-team/brocli";
import fs from "node:fs/promises";
import pkg from "../../package.json";
import { tryCatch } from "../lib/try-catch";
import { printSuccess, printError, printInfo, COLORS } from "../lib/logger";
import { EXIT_CODES } from "../lib/constants";

const REPO = "bhagyamudgal/worktree-cli";

function getAssetName(): string {
    const platform = process.platform;
    const arch = process.arch;

    if (platform !== "darwin" && platform !== "linux") {
        printError(`Unsupported platform: ${platform}`);
        process.exit(EXIT_CODES.ERROR);
    }
    if (arch !== "arm64" && arch !== "x64") {
        printError(`Unsupported architecture: ${arch}`);
        process.exit(EXIT_CODES.ERROR);
    }

    return `worktree-${platform}-${arch}`;
}

export const updateCommand = command({
    name: "update",
    desc: "Update worktree CLI to the latest version",
    handler: async () => {
        const currentVersion = pkg.version;
        const binaryPath = process.execPath;

        printInfo(`Current version: v${currentVersion}`);

        const { data: response, error: fetchError } = await tryCatch(
            fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
        );
        if (fetchError || !response) {
            printError(
                "Failed to check for updates. Check your internet connection."
            );
            process.exit(EXIT_CODES.ERROR);
        }

        if (!response.ok) {
            printError(
                `GitHub API error: ${response.status} ${response.statusText}`
            );
            process.exit(EXIT_CODES.ERROR);
        }

        const { data: release, error: jsonError } = await tryCatch(
            response.json()
        );
        if (
            jsonError ||
            !release ||
            typeof release !== "object" ||
            typeof release.tag_name !== "string"
        ) {
            printError("Failed to parse release data.");
            process.exit(EXIT_CODES.ERROR);
        }

        const latestVersion = release.tag_name.replace(/^v/, "");
        printInfo(`Latest version:  v${latestVersion}`);
        console.error("");

        if (currentVersion === latestVersion) {
            printSuccess("Already up to date!");
            return;
        }

        const [curMajor, curMinor, curPatch] = currentVersion
            .split(".")
            .map(Number);
        const [latMajor, latMinor, latPatch] = latestVersion
            .split(".")
            .map(Number);

        const isNewer =
            curMajor > latMajor ||
            (curMajor === latMajor && curMinor > latMinor) ||
            (curMajor === latMajor &&
                curMinor === latMinor &&
                curPatch > latPatch);

        if (isNewer) {
            printSuccess(
                "Current version is newer than the latest release. No update needed."
            );
            return;
        }

        const assetName = getAssetName();
        const downloadUrl = `https://github.com/${REPO}/releases/download/v${latestVersion}/${assetName}`;

        printInfo(`Downloading ${assetName}...`);

        const { data: downloadResponse, error: dlError } = await tryCatch(
            fetch(downloadUrl)
        );
        if (dlError || !downloadResponse || !downloadResponse.ok) {
            printError(`Failed to download ${assetName}.`);
            process.exit(EXIT_CODES.ERROR);
        }

        const { data: buffer, error: bufError } = await tryCatch(
            downloadResponse.arrayBuffer()
        );
        if (bufError || !buffer) {
            printError("Failed to read download.");
            process.exit(EXIT_CODES.ERROR);
        }

        const tmpPath = `${binaryPath}.update-tmp`;
        const { error: writeError } = await tryCatch(
            fs.writeFile(tmpPath, Buffer.from(buffer), { mode: 0o755 })
        );
        if (writeError) {
            await fs.unlink(tmpPath).catch(() => {});
            if ("code" in writeError && writeError.code === "EACCES") {
                printError("Permission denied. Try: sudo worktree update");
            } else {
                printError(`Failed to write update: ${writeError.message}`);
            }
            process.exit(EXIT_CODES.ERROR);
        }

        const { error: renameError } = await tryCatch(
            fs.rename(tmpPath, binaryPath)
        );
        if (renameError) {
            await fs.unlink(tmpPath).catch(() => {});
            printError(`Failed to replace binary: ${renameError.message}`);
            process.exit(EXIT_CODES.ERROR);
        }

        const { BOLD, GREEN, DIM, RESET } = COLORS;
        console.error("");
        console.error(
            `${GREEN}${BOLD}Updated!${RESET} v${currentVersion} → v${latestVersion}`
        );
        console.error(`  ${DIM}Binary: ${binaryPath}${RESET}`);
    },
});
