import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { COLORS } from "./logger";

function isEnoent(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}

function warnUnlinkFailure(filePath: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const { DIM, RESET } = COLORS;
    console.error(
        `${DIM}worktree: could not remove ${filePath} (${message})${RESET}`
    );
}

async function safeUnlink(filePath: string): Promise<void> {
    await fsPromises.unlink(filePath).catch(function (error) {
        if (isEnoent(error)) return;
        warnUnlinkFailure(filePath, error);
    });
}

function safeUnlinkSync(filePath: string): void {
    try {
        fs.unlinkSync(filePath);
    } catch (error) {
        if (isEnoent(error)) return;
        warnUnlinkFailure(filePath, error);
    }
}

export { safeUnlink, safeUnlinkSync };
