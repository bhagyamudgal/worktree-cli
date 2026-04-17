import { command } from "@drizzle-team/brocli";
import path from "node:path";
import type { BranchStatus } from "../lib/git";
import {
    getGitRoot,
    gitWorktreePrune,
    gitWorktreeListPorcelain,
    parsePorcelainOutput,
    gitBranchStatus,
    getDefaultBranch,
} from "../lib/git";
import { loadConfig } from "../lib/config";
import { printHeader, printInfo, COLORS } from "../lib/logger";

function printWorktreeInfo(
    wtPath: string,
    branch: string,
    root: string,
    status: BranchStatus
): void {
    const { BOLD, CYAN, YELLOW, GREEN, RED, DIM, RESET } = COLORS;

    let relativePath = path.relative(root, wtPath);
    if (wtPath === root) relativePath = ". (main)";

    console.error(`  ${BOLD}${relativePath}${RESET}`);
    console.error(`    Branch:  ${CYAN}${branch || "detached"}${RESET}`);

    const statusParts: string[] = [];
    if (status.changes > 0)
        statusParts.push(`${YELLOW}${status.changes} changed${RESET}`);
    if (status.ahead > 0)
        statusParts.push(`${GREEN}${status.ahead} ahead${RESET}`);
    if (status.behind > 0)
        statusParts.push(`${RED}${status.behind} behind${RESET}`);

    const localStatus =
        statusParts.length > 0 ? statusParts.join(", ") : `${DIM}clean${RESET}`;

    let mergeStatus = "";
    if (status.isMerged === true)
        mergeStatus = `  |  ${GREEN}origin: merged${RESET}`;
    else if (status.isMerged === false)
        mergeStatus = `  |  ${YELLOW}origin: not merged${RESET}`;

    console.error(`    Status:  ${localStatus}${mergeStatus}`);

    console.error(
        `${DIM}──────────────────────────────────────────────────────${RESET}`
    );
}

export const listCommand = command({
    name: "list",
    desc: "List all worktrees with status",
    handler: async () => {
        const root = await getGitRoot();
        const config = await loadConfig(root);

        await gitWorktreePrune();

        const output = await gitWorktreeListPorcelain();
        if (!output) {
            printInfo("No worktrees found.");
            return;
        }

        const entries = parsePorcelainOutput(output);
        const worktreeEntries = entries.filter((entry) => entry.path !== root);

        if (worktreeEntries.length === 0) {
            printInfo("No additional worktrees found.");
            return;
        }

        const defaultBranch = await getDefaultBranch(config.DEFAULT_BASE);

        const rows = await Promise.all(
            worktreeEntries.map(async (entry) => ({
                entry,
                status: await gitBranchStatus(entry.path, defaultBranch),
            }))
        );

        console.error("");
        printHeader("Active Worktrees");
        console.error(
            `${COLORS.DIM}──────────────────────────────────────────────────────${COLORS.RESET}`
        );

        for (const { entry, status } of rows) {
            printWorktreeInfo(entry.path, entry.branch, root, status);
        }

        console.error("");
    },
});
