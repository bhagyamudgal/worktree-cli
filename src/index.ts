import { run } from "@drizzle-team/brocli";
import { createCommand } from "./commands/create";
import { internalUpdateCheckCommand } from "./commands/internal-update-check";
import { listCommand } from "./commands/list";
import { openCommand } from "./commands/open";
import { removeCommand } from "./commands/remove";
import { updateCommand } from "./commands/update";
import {
    appendBackgroundCheckPanic,
    applyPendingUpdate,
    INTERNAL_CHECK_SUBCOMMAND,
    scheduleBackgroundUpdateCheck,
} from "./lib/auto-update";
import { COLORS } from "./lib/logger";
import pkg from "../package.json";

const META_FLAGS = new Set(["--version", "-v", "--help", "-h"]);
const FOREGROUND_UPDATE_SUBCOMMAND = "update";

function isMetaInvocation(): boolean {
    // Match only the first positional arg so flag-as-value (e.g. `create my-feature -h`) still auto-updates.
    const first = process.argv[2];
    return first !== undefined && META_FLAGS.has(first);
}

function shouldSkipAutoUpdate(): boolean {
    const first = process.argv[2];
    if (first === INTERNAL_CHECK_SUBCOMMAND) return true;
    // Skip for the foreground updater to avoid racing its own binary install.
    if (first === FOREGROUND_UPDATE_SUBCOMMAND) return true;
    return isMetaInvocation();
}

if (!shouldSkipAutoUpdate()) {
    try {
        applyPendingUpdate();
    } catch (error) {
        // Never crash the entry point — the user's command (including `worktree update`) must still run.
        appendBackgroundCheckPanic(error);
        const { DIM, RESET } = COLORS;
        console.error(
            `${DIM}worktree: auto-update apply failed unexpectedly — set WORKTREE_NO_UPDATE=1 to disable; see ~/.cache/worktree-cli/last-error${RESET}`
        );
    }
    // Funnel async throws into the panic logger, not an unhandled rejection.
    void scheduleBackgroundUpdateCheck().catch(appendBackgroundCheckPanic);
}

run(
    [
        createCommand,
        listCommand,
        openCommand,
        removeCommand,
        updateCommand,
        internalUpdateCheckCommand,
    ],
    {
        name: "worktree",
        description: pkg.description ?? "Git worktree manager",
        version: pkg.version,
    }
);
