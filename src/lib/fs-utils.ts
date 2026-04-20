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

type WriteErrorCode = "EACCES" | "EPERM" | "EROFS" | "EBUSY" | "ETXTBSY";

// Walks cause chain for errno; EBUSY/ETXTBSY treated as permanent (file locked/busy).
const WRITE_ERROR_CODES = new Set([
    "EACCES",
    "EPERM",
    "EROFS",
    "EBUSY",
    "ETXTBSY",
]);

function classifyWriteError(error: unknown): WriteErrorCode | null {
    let cur: unknown = error;
    while (cur instanceof Error) {
        if ("code" in cur) {
            const code = (cur as NodeJS.ErrnoException).code;
            if (code !== undefined && WRITE_ERROR_CODES.has(code)) {
                return code as WriteErrorCode;
            }
        }
        cur = cur.cause;
    }
    return null;
}

// Unwrap `cause` to surface the original errno message instead of a generic wrapper.
function deepestMessage(error: unknown): string {
    let cur: unknown = error;
    while (cur instanceof Error && cur.cause !== undefined) {
        cur = cur.cause;
    }
    return cur instanceof Error ? cur.message : String(cur);
}

export {
    classifyWriteError,
    deepestMessage,
    isEnoent,
    safeUnlink,
    safeUnlinkSync,
};
export type { WriteErrorCode };
