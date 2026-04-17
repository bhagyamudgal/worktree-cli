import * as p from "@clack/prompts";
import path from "node:path";
import { run } from "./shell";
import { printError, printWarn } from "./logger";
import { EXIT_CODES } from "./constants";
import { tryCatch } from "./try-catch";

async function getGitRoot(): Promise<string> {
    const result = await run("git", ["rev-parse", "--show-toplevel"]);
    if (result.exitCode !== 0) {
        printError("Not inside a git repository.");
        process.exit(EXIT_CODES.ERROR);
    }
    return result.stdout;
}

async function gitFetch(): Promise<{ success: boolean }> {
    const { error } = await tryCatch(
        run("git", ["fetch", "origin", "--prune"]).then((r) => {
            if (r.exitCode !== 0) throw new Error(r.stderr);
        })
    );
    return { success: error === null };
}

async function gitRevParseVerify(ref: string): Promise<boolean> {
    const result = await run("git", ["rev-parse", "--verify", ref]);
    return result.exitCode === 0;
}

async function gitWorktreeAdd(
    worktreePath: string,
    branch: string,
    startPoint: string
): Promise<void> {
    const result = await run(
        "git",
        ["worktree", "add", "-B", branch, worktreePath, startPoint],
        { inherit: true }
    );
    if (result.exitCode !== 0) {
        printError("git worktree add failed.");
        process.exit(EXIT_CODES.ERROR);
    }
}

async function gitWorktreeRemove(
    path: string,
    force?: boolean
): Promise<{ success: boolean; output: string }> {
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(path);
    const result = await run("git", args);
    return {
        success: result.exitCode === 0,
        output: result.stderr || result.stdout,
    };
}

async function gitWorktreeListPorcelain(): Promise<string> {
    const result = await run("git", ["worktree", "list", "--porcelain"]);
    if (result.exitCode !== 0) {
        printError(`git worktree list failed: ${result.stderr}`);
        process.exit(EXIT_CODES.ERROR);
    }
    return result.stdout;
}

type WorktreeEntry = {
    path: string;
    branch: string;
};

type BranchStatus = {
    changes: number;
    ahead: number;
    behind: number;
    isMerged: boolean | null;
};

function parsePorcelainOutput(output: string): WorktreeEntry[] {
    const entries: WorktreeEntry[] = [];
    let currentPath = "";
    let currentBranch = "";

    for (const line of output.split("\n")) {
        if (line.startsWith("worktree ")) {
            if (currentPath) {
                entries.push({ path: currentPath, branch: currentBranch });
            }
            currentPath = line.slice("worktree ".length);
            currentBranch = "";
        } else if (line.startsWith("branch refs/heads/")) {
            currentBranch = line.slice("branch refs/heads/".length);
        }
    }

    if (currentPath) {
        entries.push({ path: currentPath, branch: currentBranch });
    }

    return entries;
}

async function gitWorktreePrune(expire?: string): Promise<boolean> {
    const args = ["worktree", "prune"];
    if (expire) args.push("--expire", expire);
    const result = await run("git", args);
    return result.exitCode === 0;
}

async function gitStatusCount(cwd: string): Promise<number> {
    const result = await run("git", ["status", "--porcelain=v2", "-uall"], {
        cwd,
    });
    if (result.exitCode !== 0 || result.stdout === "") return 0;
    return result.stdout.split("\n").filter(Boolean).length;
}

async function gitAheadBehind(
    cwd: string
): Promise<{ ahead: number; behind: number }> {
    const upstreamResult = await run(
        "git",
        ["rev-parse", "--abbrev-ref", "@{upstream}"],
        { cwd }
    );

    if (upstreamResult.exitCode !== 0) {
        return { ahead: 0, behind: 0 };
    }

    const upstream = upstreamResult.stdout;
    const result = await run(
        "git",
        ["rev-list", "--left-right", "--count", `HEAD...${upstream}`],
        { cwd }
    );

    if (result.exitCode !== 0) {
        return { ahead: 0, behind: 0 };
    }

    const parts = result.stdout.split("\t");
    return {
        ahead: parseInt(parts[0] ?? "0", 10),
        behind: parseInt(parts[1] ?? "0", 10),
    };
}

async function gitBranchDelete(
    branch: string,
    force?: boolean
): Promise<boolean> {
    const flag = force ? "-D" : "-d";
    const result = await run("git", ["branch", flag, branch]);
    return result.exitCode === 0;
}

async function gitBranchShowCurrent(cwd: string): Promise<string> {
    const result = await run("git", ["branch", "--show-current"], { cwd });
    return result.stdout;
}

async function gitBranchList(branch: string): Promise<string> {
    const result = await run("git", ["branch", "--list", branch]);
    return result.stdout;
}

async function gitUnsetUpstream(cwd: string): Promise<void> {
    await run("git", ["branch", "--unset-upstream"], { cwd });
}

async function gitRevParseGitDir(cwd: string): Promise<boolean> {
    const result = await run("git", ["rev-parse", "--git-dir"], { cwd });
    return result.exitCode === 0;
}

async function getDefaultBranch(configBase?: string): Promise<string | null> {
    const ORIGIN_PREFIX = "origin/";

    if (configBase) {
        return configBase.startsWith(ORIGIN_PREFIX)
            ? configBase.slice(ORIGIN_PREFIX.length)
            : configBase;
    }

    const result = await run("git", [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
    ]);

    if (result.exitCode !== 0 || result.stdout === "") return null;

    const REF_PREFIX = "refs/remotes/origin/";
    return result.stdout.startsWith(REF_PREFIX)
        ? result.stdout.slice(REF_PREFIX.length)
        : result.stdout;
}

async function gitBranchStatus(
    cwd: string,
    defaultBranch: string | null
): Promise<BranchStatus> {
    const [changes, { ahead, behind }, isMerged] = await Promise.all([
        gitStatusCount(cwd),
        gitAheadBehind(cwd),
        checkMergedIntoOrigin(cwd, defaultBranch),
    ]);

    return { changes, ahead, behind, isMerged };
}

async function checkMergedIntoOrigin(
    cwd: string,
    defaultBranch: string | null
): Promise<boolean | null> {
    if (!defaultBranch) return null;

    const result = await run(
        "git",
        ["merge-base", "--is-ancestor", "HEAD", `origin/${defaultBranch}`],
        { cwd }
    );

    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    return null;
}

function formatBranchStatusHint(status: BranchStatus): string {
    const parts: string[] = [];
    if (status.changes > 0)
        parts.push(`${status.changes} change${status.changes > 1 ? "s" : ""}`);
    if (status.ahead > 0) parts.push(`${status.ahead} ahead`);
    if (status.behind > 0) parts.push(`${status.behind} behind`);
    const localHint = parts.length > 0 ? parts.join(", ") : "clean";

    let mergeHint = "";
    if (status.isMerged === true) mergeHint = "merged";
    else if (status.isMerged === false) mergeHint = "not merged";

    return mergeHint ? `${localHint} | ${mergeHint}` : localHint;
}

async function selectWorktree(
    root: string,
    worktreeDir: string,
    defaultBranch?: string | null
): Promise<string> {
    const pruneSuccess = await gitWorktreePrune();
    if (!pruneSuccess) {
        printWarn(
            "git worktree prune failed. Listing may include stale entries."
        );
    }

    const output = await gitWorktreeListPorcelain();
    if (!output) {
        printError(
            "No worktrees found. Create one with: worktree create <name>"
        );
        process.exit(EXIT_CODES.ERROR);
    }

    const worktreeBase = path.join(root, worktreeDir);
    const entries = parsePorcelainOutput(output);
    const worktreeEntries = entries.filter(
        (entry) =>
            entry.path !== root &&
            entry.path.startsWith(worktreeBase + path.sep)
    );

    if (worktreeEntries.length === 0) {
        printError(
            "No worktrees found. Create one with: worktree create <name>"
        );
        process.exit(EXIT_CODES.ERROR);
    }

    const options = await Promise.all(
        worktreeEntries.map(async (entry) => {
            const status = await gitBranchStatus(
                entry.path,
                defaultBranch ?? null
            );
            const hint = formatBranchStatusHint(status);
            const name = path.relative(worktreeBase, entry.path);
            return { value: name, label: entry.branch || name, hint };
        })
    );

    const selected = await p.select({
        message: "Select a worktree",
        options,
    });

    if (p.isCancel(selected)) {
        process.exit(EXIT_CODES.SUCCESS);
    }

    // p.select returns string | symbol, but isCancel above exits on symbol — library types don't narrow
    return selected as string;
}

export {
    getGitRoot,
    gitFetch,
    gitRevParseVerify,
    gitWorktreeAdd,
    gitWorktreeRemove,
    gitWorktreeListPorcelain,
    parsePorcelainOutput,
    gitWorktreePrune,
    gitBranchDelete,
    gitBranchShowCurrent,
    gitBranchList,
    gitUnsetUpstream,
    gitRevParseGitDir,
    getDefaultBranch,
    gitBranchStatus,
    formatBranchStatusHint,
    selectWorktree,
};
export type { WorktreeEntry, BranchStatus };
