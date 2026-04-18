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
    // Match only the FIRST positional arg so `worktree create my-feature -h`
    // (where `-h` is e.g. a base-branch value) doesn't accidentally skip
    // auto-update; only the literal `worktree --version` / `worktree -h`
    // forms qualify as "pure metadata".
    const first = process.argv[2];
    return first !== undefined && META_FLAGS.has(first);
}

function shouldSkipAutoUpdate(): boolean {
    const first = process.argv[2];
    if (first === INTERNAL_CHECK_SUBCOMMAND) return true;
    // `worktree update` is the foreground updater itself — racing the
    // background spawn against it lets the background child stage the same
    // version foreground just installed and then "auto-update" the user
    // back to it on the next launch (apply path no-op, but logs noise).
    if (first === FOREGROUND_UPDATE_SUBCOMMAND) return true;
    return isMetaInvocation();
}

if (!shouldSkipAutoUpdate()) {
    try {
        applyPendingUpdate();
    } catch (error) {
        // applyPendingUpdate re-throws non-errno errors so a programmer bug
        // doesn't silently degrade. But we MUST NOT crash the entry point —
        // the user's actual command (including `worktree update` for manual
        // recovery) needs to run. Log the panic, hint at the escape hatch,
        // and continue.
        appendBackgroundCheckPanic(error);
        const { DIM, RESET } = COLORS;
        console.error(
            `${DIM}worktree: auto-update apply failed unexpectedly — set WORKTREE_NO_UPDATE=1 to disable; see ~/.cache/worktree-cli/last-error${RESET}`
        );
    }
    // .catch funnels future programmer-bug throws into the panic logger
    // instead of becoming an unhandled rejection that prints a stack trace
    // mixed with the user's command output.
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
