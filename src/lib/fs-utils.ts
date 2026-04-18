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

type WriteErrorCode = "EACCES" | "EPERM" | "EROFS";

// release.ts wraps errno errors as `new Error(msg, { cause })` — walk the
// cause chain so the "binary directory not writable" branch fires even
// when the top-level Error lacks a .code field.
function classifyWriteError(error: unknown): WriteErrorCode | null {
    let cur: unknown = error;
    while (cur instanceof Error) {
        if ("code" in cur) {
            const code = (cur as NodeJS.ErrnoException).code;
            if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
                return code;
            }
        }
        cur = cur.cause;
    }
    return null;
}

// Walk `Error.cause` to the deepest leaf so the original errno message
// (ENOTFOUND, ECONNRESET, ETIMEDOUT) surfaces to the user instead of the
// generic wrapper ("Failed to reach GitHub releases API").
function deepestMessage(error: unknown): string {
    let cur: unknown = error;
    while (cur instanceof Error && cur.cause !== undefined) {
        cur = cur.cause;
    }
    return cur instanceof Error ? cur.message : String(cur);
}

export { classifyWriteError, deepestMessage, safeUnlink, safeUnlinkSync };
export type { WriteErrorCode };
