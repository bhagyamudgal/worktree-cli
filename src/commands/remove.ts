import { command, positional } from "@drizzle-team/brocli";
import path from "node:path";
import fs from "node:fs/promises";
import * as p from "@clack/prompts";
import { tryCatch } from "../lib/try-catch";
import {
    getGitRoot,
    gitStatusCount,
    gitWorktreeRemove,
    gitWorktreePrune,
    gitBranchDelete,
    gitBranchShowCurrent,
    gitBranchList,
    gitRevParseGitDir,
} from "../lib/git";
import { loadConfig } from "../lib/config";
import { printSuccess, printError, printWarn, printInfo } from "../lib/logger";
import { EXIT_CODES } from "../lib/constants";

async function confirmOrExit(message: string): Promise<void> {
    const confirmed = await p.confirm({ message });
    if (p.isCancel(confirmed) || !confirmed) {
        printInfo("Cancelled.");
        process.exit(EXIT_CODES.SUCCESS);
    }
}

async function cleanupEmptyParents(dir: string, stopAt: string): Promise<void> {
    let current = path.dirname(dir);

    while (current !== stopAt && current.startsWith(stopAt + path.sep)) {
        const entries = await fs.readdir(current).catch(() => null);
        if (!entries || entries.length > 0) break;
        await fs.rmdir(current).catch(() => null);
        current = path.dirname(current);
    }
}

export const removeCommand = command({
    name: "remove",
    desc: "Remove a worktree",
    options: {
        name: positional("name").desc("Worktree name").required(),
    },
    handler: async (opts) => {
        const root = await getGitRoot();
        const config = await loadConfig(root);
        const worktreeBase = path.join(root, config.WORKTREE_DIR);
        const worktreePath = path.join(worktreeBase, opts.name);

        const dirExists = await fs.stat(worktreePath).catch(() => null);
        if (!dirExists) {
            printError(`Worktree '${opts.name}' not found at ${worktreePath}`);
            process.exit(EXIT_CODES.ERROR);
        }

        const { data: resolvedPath, error: pathErr } = await tryCatch(
            fs.realpath(worktreePath)
        );
        const { data: resolvedBase, error: baseErr } = await tryCatch(
            fs.realpath(worktreeBase)
        );

        if (pathErr || baseErr || !resolvedPath || !resolvedBase) {
            printError("Failed to resolve worktree paths. Aborting.");
            process.exit(EXIT_CODES.ERROR);
        }

        if (!resolvedPath.startsWith(resolvedBase + path.sep)) {
            printError(
                `Path '${opts.name}' resolves outside the worktree directory. Aborting.`
            );
            process.exit(EXIT_CODES.ERROR);
        }

        const isValidWorktree = await gitRevParseGitDir(worktreePath);
        let worktreeBranch = "";

        if (isValidWorktree) {
            worktreeBranch = await gitBranchShowCurrent(worktreePath);
            const changes = await gitStatusCount(worktreePath);

            if (changes > 0) {
                printWarn(
                    `Worktree '${opts.name}' has ${changes} uncommitted change(s).`
                );
                await confirmOrExit("Remove anyway?");
                await gitWorktreeRemove(worktreePath, true);
            } else {
                const result = await gitWorktreeRemove(worktreePath);
                if (!result.success) {
                    printWarn(
                        "Worktree has untracked files. Force removing..."
                    );
                    await confirmOrExit("Continue?");
                    await gitWorktreeRemove(worktreePath, true);
                }
            }
        } else {
            printWarn(
                `Worktree '${opts.name}' has a broken git reference (repo may have been moved).`
            );
            await confirmOrExit("Force remove directory?");

            const hasTrash = Bun.which("trash") !== null;
            if (hasTrash) {
                const proc = Bun.spawn(["trash", worktreePath]);
                await proc.exited;
            } else {
                await fs.rm(worktreePath, { recursive: true, force: true });
            }

            const pruneSuccess = await gitWorktreePrune();
            if (!pruneSuccess) {
                printWarn(
                    "  git worktree prune failed. Run 'git worktree prune' manually."
                );
            }
        }

        printSuccess(`Worktree '${opts.name}' removed.`);

        await cleanupEmptyParents(worktreePath, worktreeBase);

        if (!worktreeBranch) {
            printInfo(
                "No branch to clean up (detached HEAD or broken worktree)."
            );
            return;
        }

        const branchExists = await gitBranchList(worktreeBranch);
        if (!branchExists.trim()) return;

        const isDeleted = await gitBranchDelete(worktreeBranch);
        if (isDeleted) {
            printSuccess(`Branch '${worktreeBranch}' deleted (local only).`);
        } else {
            const confirmed = await p.confirm({
                message: `Delete local branch '${worktreeBranch}'? (not fully merged)`,
            });

            if (p.isCancel(confirmed) || !confirmed) return;

            await gitBranchDelete(worktreeBranch, true);
            printSuccess(
                `Branch '${worktreeBranch}' force deleted (local only).`
            );
        }
    },
});
