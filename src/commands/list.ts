import { command } from "@drizzle-team/brocli";
import path from "node:path";
import {
    getGitRoot,
    gitWorktreePrune,
    gitWorktreeListPorcelain,
    parsePorcelainOutput,
    gitStatusCount,
    gitAheadBehind,
} from "../lib/git";
import { printHeader, printInfo, COLORS } from "../lib/logger";

async function printWorktreeInfo(
    wtPath: string,
    branch: string,
    root: string
): Promise<void> {
    const { BOLD, CYAN, YELLOW, GREEN, RED, DIM, RESET } = COLORS;

    let relativePath = path.relative(root, wtPath);
    if (wtPath === root) relativePath = ". (main)";

    const changes = await gitStatusCount(wtPath);
    const { ahead, behind } = await gitAheadBehind(wtPath);

    console.error(`  ${BOLD}${relativePath}${RESET}`);
    console.error(`    Branch:  ${CYAN}${branch || "detached"}${RESET}`);

    const statusParts: string[] = [];
    if (changes > 0) statusParts.push(`${YELLOW}${changes} changed${RESET}`);
    if (ahead > 0) statusParts.push(`${GREEN}${ahead} ahead${RESET}`);
    if (behind > 0) statusParts.push(`${RED}${behind} behind${RESET}`);

    if (statusParts.length > 0) {
        console.error(`    Status:  ${statusParts.join(", ")}`);
    } else {
        console.error(`    Status:  ${DIM}clean${RESET}`);
    }

    console.error(
        `${DIM}──────────────────────────────────────────────────────${RESET}`
    );
}

export const listCommand = command({
    name: "list",
    desc: "List all worktrees with status",
    handler: async () => {
        const root = await getGitRoot();

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

        console.error("");
        printHeader("Active Worktrees");
        console.error(
            `${COLORS.DIM}──────────────────────────────────────────────────────${COLORS.RESET}`
        );

        for (const entry of worktreeEntries) {
            await printWorktreeInfo(entry.path, entry.branch, root);
        }

        console.error("");
    },
});
