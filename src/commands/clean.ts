import { boolean, command } from "@drizzle-team/brocli";
import * as p from "@clack/prompts";
import {
    checkMergedIntoOrigin,
    getDefaultBranch,
    getGitRoot,
    gitBranchDeleteIfMatches,
    gitBranchShowCurrent,
    gitDiscardHuskyResidue,
    gitFetch,
    gitRevParseHead,
    gitRevParseGitDir,
    gitWorktreeChangePaths,
    gitWorktreeHasSubmodules,
    gitWorktreeListPorcelain,
    gitWorktreeOperation,
    gitWorktreeRemove,
    parsePorcelainOutput,
    type WorktreeEntry,
} from "../lib/git";
import { loadConfig } from "../lib/config";
import { EXIT_CODES } from "../lib/constants";
import { tryCatch } from "../lib/try-catch";
import {
    printError,
    printHeader,
    printInfo,
    printSuccess,
    printWarn,
} from "../lib/logger";

function isAllowedCleanChangePath(filePath: string): boolean {
    return filePath === ".husky/_" || filePath.startsWith(".husky/_/");
}

async function checkCleanEligibility(
    entry: WorktreeEntry,
    defaultBranch: string
): Promise<string | Error | null> {
    if (entry.isLocked) return "locked";
    if (entry.isPrunable || !(await gitRevParseGitDir(entry.path))) {
        return "broken";
    }

    const operation = await gitWorktreeOperation(entry.path);
    if (operation !== null) return `${operation} in progress`;

    const [changePaths, isMerged, hasSubmodules] = await Promise.all([
        gitWorktreeChangePaths(entry.path),
        checkMergedIntoOrigin(entry.path, defaultBranch),
        gitWorktreeHasSubmodules(entry.path),
    ]);
    if (changePaths === null)
        return new Error("could not read worktree status");
    if (isMerged === null) return new Error("could not verify merge status");
    if (hasSubmodules === null)
        return new Error("could not inspect worktree submodules");

    const blockingChanges = changePaths.filter(function (filePath) {
        return !isAllowedCleanChangePath(filePath);
    });
    if (blockingChanges.length > 0) {
        const suffix = blockingChanges.length === 1 ? "" : "s";
        return `${blockingChanges.length} uncommitted change${suffix}`;
    }
    if (hasSubmodules) return "contains submodules";
    if (!isMerged) return `not merged into origin/${defaultBranch}`;
    return null;
}

async function removeCleanWorktree(
    entry: WorktreeEntry,
    defaultBranch: string,
    root: string
): Promise<[boolean, string | null]> {
    const eligibility = await checkCleanEligibility(entry, defaultBranch);
    if (eligibility !== null) {
        const reason =
            eligibility instanceof Error ? eligibility.message : eligibility;
        return [false, `no longer eligible after preview (${reason})`];
    }

    if (!(await gitDiscardHuskyResidue(entry.path))) {
        return [false, "could not discard Husky residue"];
    }
    const finalEligibility = await checkCleanEligibility(entry, defaultBranch);
    if (finalEligibility !== null) {
        const reason =
            finalEligibility instanceof Error
                ? finalEligibility.message
                : finalEligibility;
        return [false, `no longer eligible after residue cleanup (${reason})`];
    }

    const [branch, head] = await Promise.all([
        gitBranchShowCurrent(entry.path),
        gitRevParseHead(entry.path),
    ]);
    if (!head) return [false, "could not capture the verified HEAD"];

    const isCapturedHeadMerged = await checkMergedIntoOrigin(
        entry.path,
        defaultBranch,
        head
    );
    if (isCapturedHeadMerged !== true) {
        return [
            false,
            "captured HEAD is not merged into the origin default branch",
        ];
    }

    const removal = await gitWorktreeRemove(entry.path);
    if (!removal.success) {
        return [false, removal.output || "git worktree remove failed"];
    }

    if (branch) {
        const branchDeletion = await gitBranchDeleteIfMatches(
            root,
            branch,
            head,
            defaultBranch
        );
        if (branchDeletion === "checked-out") {
            return [
                true,
                `removed worktree but kept local branch '${branch}' because another worktree uses it`,
            ];
        }
        if (branchDeletion === "changed") {
            return [
                true,
                `removed worktree but kept local branch '${branch}' because it changed after verification`,
            ];
        }
        if (branchDeletion === "failed") {
            return [
                true,
                `removed worktree but could not delete local branch '${branch}'`,
            ];
        }
    }

    return [true, null];
}

export const cleanCommand = command({
    name: "clean",
    desc: "Remove clean worktrees merged into the default branch",
    options: {
        yes: boolean().desc("Remove eligible worktrees without confirmation"),
    },
    handler: async (opts) => {
        const root = await getGitRoot();
        const config = await loadConfig(root);
        const fetchResult = await gitFetch();
        if (!fetchResult.success) {
            printError("Fetch failed. No worktrees were removed.");
            process.exit(EXIT_CODES.ERROR);
        }

        const defaultBranch = await getDefaultBranch(config.DEFAULT_BASE);
        if (!defaultBranch) {
            printError(
                "Could not determine the default branch. No worktrees were removed."
            );
            process.exit(EXIT_CODES.ERROR);
        }

        const output = await gitWorktreeListPorcelain();
        const entries = parsePorcelainOutput(output);
        const primaryPath = entries[0]?.path;
        const candidates: WorktreeEntry[] = [];
        const skipped: string[] = [];
        const failures: string[] = [];

        for (const entry of entries) {
            if (entry.path === primaryPath) continue;
            if (entry.path === root) {
                skipped.push(`${entry.path}: current worktree`);
                continue;
            }

            const { data: eligibility, error } = await tryCatch(
                checkCleanEligibility(entry, defaultBranch)
            );
            if (error) {
                failures.push(`${entry.path}: ${error.message}`);
                continue;
            }
            if (eligibility !== null) {
                skipped.push(`${entry.path}: ${eligibility}`);
                continue;
            }

            candidates.push(entry);
        }

        if (candidates.length > 0) {
            printHeader(`Cleanable worktrees (${candidates.length})`);
            for (const entry of candidates) {
                const branch = entry.branch || "detached";
                console.error(
                    `  ${entry.path} (${branch}): merged into origin/${defaultBranch}`
                );
            }
        }

        if (skipped.length > 0) {
            printHeader(`Skipped worktrees (${skipped.length})`);
            for (const message of skipped) printWarn(`  ${message}`);
        }

        if (failures.length > 0) {
            printHeader(`Inspection failures (${failures.length})`);
            for (const message of failures) printError(`  ${message}`);
        }

        if (candidates.length === 0) {
            printInfo("No clean, merged worktrees found.");
            if (failures.length > 0) process.exit(EXIT_CODES.ERROR);
            return;
        }

        if (!opts.yes) {
            const confirmed = await p.confirm({
                message: `Remove ${candidates.length} worktree${candidates.length === 1 ? "" : "s"}?`,
            });
            if (p.isCancel(confirmed) || !confirmed) {
                printInfo("Cancelled.");
                return;
            }
        }

        let removedCount = 0;
        for (const entry of candidates) {
            const { data: removal, error } = await tryCatch(
                removeCleanWorktree(entry, defaultBranch, root)
            );
            if (error) {
                failures.push(`${entry.path}: ${error.message}`);
                continue;
            }
            const [isRemoved, failure] = removal;
            if (isRemoved) {
                removedCount++;
                printSuccess(`Removed ${entry.path}.`);
            }
            if (failure !== null) failures.push(`${entry.path}: ${failure}`);
        }

        printHeader("Cleanup summary");
        printInfo(`  Removed: ${removedCount}`);
        printInfo(`  Skipped: ${skipped.length}`);
        printInfo(`  Failed: ${failures.length}`);

        if (failures.length > 0) {
            for (const message of failures) printError(`  ${message}`);
            process.exit(EXIT_CODES.ERROR);
        }
    },
});
