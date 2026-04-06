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
        ["worktree", "add", worktreePath, "-B", branch, startPoint],
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
    const args = ["worktree", "remove", path];
    if (force) args.push("--force");
    const result = await run("git", args);
    return {
        success: result.exitCode === 0,
        output: result.stderr || result.stdout,
    };
}

async function gitWorktreeListPorcelain(): Promise<string> {
    const result = await run("git", ["worktree", "list", "--porcelain"]);
    return result.stdout;
}

async function gitWorktreePrune(): Promise<boolean> {
    const result = await run("git", ["worktree", "prune"]);
    return result.exitCode === 0;
}

async function gitStatusCount(cwd: string): Promise<number> {
    const result = await run("git", ["status", "--porcelain", "-uno"], { cwd });
    if (result.exitCode !== 0 || result.stdout === "") return 0;
    return result.stdout.split("\n").length;
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

export {
    getGitRoot,
    gitFetch,
    gitRevParseVerify,
    gitWorktreeAdd,
    gitWorktreeRemove,
    gitWorktreeListPorcelain,
    gitWorktreePrune,
    gitStatusCount,
    gitAheadBehind,
    gitBranchDelete,
    gitBranchShowCurrent,
    gitBranchList,
    gitUnsetUpstream,
    gitRevParseGitDir,
};
