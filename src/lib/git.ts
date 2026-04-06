import * as p from "@clack/prompts";
import path from "node:path";
import { run } from "./shell";
import { printError } from "./logger";
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
    const result = await run("git", ["status", "--porcelain"], { cwd });
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

async function selectWorktree(
    root: string,
    worktreeDir: string
): Promise<string> {
    await gitWorktreePrune();

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
            const [changes, { ahead, behind }] = await Promise.all([
                gitStatusCount(entry.path),
                gitAheadBehind(entry.path),
            ]);

            const parts: string[] = [];
            if (changes > 0)
                parts.push(`${changes} change${changes > 1 ? "s" : ""}`);
            if (ahead > 0) parts.push(`${ahead} ahead`);
            if (behind > 0) parts.push(`${behind} behind`);
            const hint = parts.length > 0 ? parts.join(", ") : "clean";

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
    gitStatusCount,
    gitAheadBehind,
    gitBranchDelete,
    gitBranchShowCurrent,
    gitBranchList,
    gitUnsetUpstream,
    gitRevParseGitDir,
    selectWorktree,
};
export type { WorktreeEntry };
