import { run } from "@drizzle-team/brocli";
import { createCommand } from "./commands/create";
import { internalUpdateCheckCommand } from "./commands/internal-update-check";
import { listCommand } from "./commands/list";
import { openCommand } from "./commands/open";
import { removeCommand } from "./commands/remove";
import { updateCommand } from "./commands/update";
import {
    applyPendingUpdate,
    INTERNAL_CHECK_SUBCOMMAND,
    scheduleBackgroundUpdateCheck,
} from "./lib/auto-update";
import pkg from "../package.json";

if (!process.argv.slice(2).includes(INTERNAL_CHECK_SUBCOMMAND)) {
    applyPendingUpdate();
    void scheduleBackgroundUpdateCheck();
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
