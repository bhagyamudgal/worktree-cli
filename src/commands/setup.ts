import { boolean, command, string } from "@drizzle-team/brocli";
import * as p from "@clack/prompts";
import fs from "node:fs/promises";
import path from "node:path";
import { getDefaultBranch, getGitRoot, gitRevParseVerify } from "../lib/git";
import { loadConfig, parseConfigContent } from "../lib/config";
import { DEFAULT_WORKTREE_DIR, EXIT_CODES } from "../lib/constants";
import {
    printError,
    printHeader,
    printInfo,
    printSuccess,
    printWarn,
} from "../lib/logger";
import { tryCatch } from "../lib/try-catch";

const CUSTOM_OPTION = "__custom__";
const COMMON_BRANCHES = ["main", "master", "dev", "develop"] as const;

function formatValue(value: string): string {
    if (/[\s#']/.test(value)) return `"${value}"`;
    return value;
}

function validateDirValue(dir: string): string | null {
    if (dir === "") return "Directory name is required.";
    if (dir.includes('"') || dir.includes("\n")) {
        return "Directory name cannot contain quotes or newlines.";
    }
    if (dir.startsWith("/") || dir.includes("..") || dir.includes(path.sep)) {
        return "Use a plain directory name (e.g. .worktrees).";
    }
    return null;
}

function resolveDirInRoot(root: string, dir: string): string | null {
    const resolved = path.resolve(root, dir);
    if (resolved === root || !resolved.startsWith(root + path.sep)) {
        return null;
    }
    return resolved;
}

async function normalizeBase(input: string): Promise<string | null> {
    const trimmed = input.trim();
    if (trimmed === "") return null;
    if (!trimmed.startsWith("origin/")) {
        const originRef = `origin/${trimmed}`;
        if (await gitRevParseVerify(originRef)) return originRef;
    }
    if (await gitRevParseVerify(trimmed)) return trimmed;
    return null;
}

async function collectBaseCandidates(
    currentBase: string | undefined
): Promise<string[]> {
    const candidates: string[] = [];
    function push(ref: string): void {
        if (!candidates.includes(ref)) candidates.push(ref);
    }

    if (currentBase) {
        const normalized = await normalizeBase(currentBase);
        if (normalized) push(normalized);
    }

    const originHead = await getDefaultBranch();
    if (originHead) {
        const ref = `origin/${originHead}`;
        if (await gitRevParseVerify(ref)) push(ref);
    }

    for (const name of COMMON_BRANCHES) {
        const originRef = `origin/${name}`;
        if (await gitRevParseVerify(originRef)) {
            push(originRef);
        } else if (await gitRevParseVerify(name)) {
            push(name);
        }
    }

    return candidates;
}

async function resolveOriginHeadBase(): Promise<string | null> {
    const head = await getDefaultBranch();
    if (!head) return null;
    return normalizeBase(`origin/${head}`);
}

async function promptForBase(
    candidates: string[],
    currentBase: string | undefined
): Promise<string> {
    if (candidates.length > 0) {
        const initial =
            currentBase && candidates.includes(currentBase)
                ? currentBase
                : candidates[0];
        const selected = await p.select({
            message: "Select default base branch",
            options: [
                ...candidates.map((ref) => ({ value: ref, label: ref })),
                { value: CUSTOM_OPTION, label: "Custom..." },
            ],
            initialValue: initial,
        });
        if (p.isCancel(selected)) {
            printInfo("Cancelled.");
            process.exit(EXIT_CODES.SUCCESS);
        }
        if (selected !== CUSTOM_OPTION) return selected;
    }

    const entered = await p.text({
        message: "Enter default base branch",
        initialValue: currentBase ?? candidates[0] ?? "",
        validate: function (value) {
            if (value.trim() === "") return "Base branch is required.";
            return undefined;
        },
    });
    if (p.isCancel(entered)) {
        printInfo("Cancelled.");
        process.exit(EXIT_CODES.SUCCESS);
    }
    return entered;
}

async function promptForDir(currentDir: string): Promise<string> {
    const entered = await p.text({
        message: "Worktree directory name",
        initialValue: currentDir,
        validate: function (value) {
            return validateDirValue(value.trim()) ?? undefined;
        },
    });
    if (p.isCancel(entered)) {
        printInfo("Cancelled.");
        process.exit(EXIT_CODES.SUCCESS);
    }
    return entered.trim();
}

function isGitignoreCovered(content: string, dir: string): boolean {
    const wanted = [`${dir}/`, dir, `/${dir}/`, `/${dir}`];
    return content.split("\n").some((line) => wanted.includes(line.trim()));
}

export const setupCommand = command({
    name: "setup",
    desc: "Configure .worktreerc for this repo (interactive)",
    options: {
        base: string("base").desc(
            "Default base branch (e.g. origin/main, skips prompt)"
        ),
        dir: string("worktree-dir").desc(
            `Worktree directory name (default: ${DEFAULT_WORKTREE_DIR})`
        ),
        yes: boolean().desc("Skip confirmation prompts"),
    },
    handler: async (opts) => {
        const root = await getGitRoot();
        const rcPath = path.join(root, ".worktreerc");

        const { data: rcContent } = await tryCatch(fs.readFile(rcPath, "utf8"));
        const raw = rcContent === null ? {} : parseConfigContent(rcContent);
        const config = await loadConfig(root);
        const currentBase = raw.DEFAULT_BASE;
        const currentDir = raw.WORKTREE_DIR ?? config.WORKTREE_DIR;

        printHeader("Repo setup");
        if (currentBase) printInfo(`  Current base: ${currentBase}`);
        else printInfo("  No DEFAULT_BASE configured yet.");
        printInfo(`  Worktree dir: ${currentDir}`);
        console.error("");

        let base: string;
        if (opts.base !== undefined) {
            const normalized = await normalizeBase(opts.base);
            if (!normalized) {
                printError(
                    `Base branch '${opts.base}' not found locally or on origin.`
                );
                process.exit(EXIT_CODES.ERROR);
            }
            base = normalized;
        } else if (opts.yes) {
            if (currentBase) {
                const normalized = await normalizeBase(currentBase);
                if (!normalized) {
                    printError(
                        `Configured DEFAULT_BASE '${currentBase}' not found locally or on origin. Re-run with --base <branch>.`
                    );
                    process.exit(EXIT_CODES.ERROR);
                }
                base = normalized;
            } else {
                const fallback = await resolveOriginHeadBase();
                if (!fallback) {
                    printError(
                        "No DEFAULT_BASE configured. Re-run with --base <branch>."
                    );
                    process.exit(EXIT_CODES.ERROR);
                }
                base = fallback;
            }
        } else {
            if (process.stdin.isTTY !== true) {
                printError(
                    "No --base given and stdin is not interactive. Re-run with --base <branch>."
                );
                process.exit(EXIT_CODES.ERROR);
            }
            const candidates = await collectBaseCandidates(currentBase);
            base = await promptForBase(candidates, currentBase);
            const normalized = await normalizeBase(base);
            if (!normalized) {
                printError(
                    `Base branch '${base}' not found locally or on origin.`
                );
                process.exit(EXIT_CODES.ERROR);
            }
            base = normalized;
        }

        let dir: string;
        if (opts.dir !== undefined) {
            dir = opts.dir.trim();
        } else if (opts.yes || process.stdin.isTTY !== true) {
            dir = currentDir;
        } else {
            dir = await promptForDir(currentDir);
        }
        const dirError = validateDirValue(dir);
        const worktreeBaseDir =
            dirError === null ? resolveDirInRoot(root, dir) : null;
        if (dirError !== null || worktreeBaseDir === null) {
            printError(
                `Invalid worktree directory '${dir}'. Use a plain name like ${DEFAULT_WORKTREE_DIR} inside the repository.`
            );
            process.exit(EXIT_CODES.ERROR);
        }

        const { error: mkdirError } = await tryCatch(
            fs.mkdir(worktreeBaseDir, { recursive: true })
        );
        if (mkdirError) {
            printError(
                `Could not create ${dir} directory: ${mkdirError.message}`
            );
            process.exit(EXIT_CODES.ERROR);
        }
        const { data: realRoot, error: realRootError } = await tryCatch(
            fs.realpath(root)
        );
        const { data: realDir, error: realDirError } = await tryCatch(
            fs.realpath(worktreeBaseDir)
        );
        if (
            realRootError ||
            realDirError ||
            realDir === realRoot ||
            !realDir.startsWith(realRoot + path.sep)
        ) {
            printError(
                `Worktree directory '${dir}' resolves outside the repository. Use a real directory inside it.`
            );
            process.exit(EXIT_CODES.ERROR);
        }
        await fs
            .writeFile(path.join(worktreeBaseDir, ".gitignore"), "*\n", {
                flag: "wx",
            })
            .catch((error: unknown) => {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                    printWarn(`  Could not create ${dir}/.gitignore.`);
                }
            });

        const preservedLines: string[] = [];
        if (rcContent !== null) {
            const sourceLines = rcContent.split("\n");
            if (sourceLines[sourceLines.length - 1] === "") {
                sourceLines.pop();
            }
            for (const line of sourceLines) {
                const trimmed = line.trim();
                const eqIndex = trimmed.indexOf("=");
                const key =
                    trimmed === "" || trimmed.startsWith("#") || eqIndex === -1
                        ? ""
                        : trimmed.slice(0, eqIndex).trim();
                if (key === "DEFAULT_BASE" || key === "WORKTREE_DIR") continue;
                preservedLines.push(line);
            }
        }
        const lines = [
            `DEFAULT_BASE=${formatValue(base)}`,
            `WORKTREE_DIR=${formatValue(dir)}`,
            ...preservedLines,
        ];
        const { error: writeError } = await tryCatch(
            fs.writeFile(rcPath, `${lines.join("\n")}\n`)
        );
        if (writeError) {
            printError(`Could not write ${rcPath}: ${writeError.message}`);
            process.exit(EXIT_CODES.ERROR);
        }
        printSuccess(`Wrote ${rcPath}`);

        const gitignorePath = path.join(root, ".gitignore");
        const { data: gitignoreContent } = await tryCatch(
            fs.readFile(gitignorePath, "utf8")
        );
        if (
            gitignoreContent !== null &&
            isGitignoreCovered(gitignoreContent, dir)
        ) {
            printInfo(`  .gitignore already covers ${dir}/.`);
        } else {
            let append = opts.yes;
            if (!opts.yes) {
                if (process.stdin.isTTY !== true) {
                    printWarn(
                        `  Skipping .gitignore update (non-interactive). Add '${dir}/' manually.`
                    );
                } else {
                    const confirmed = await p.confirm({
                        message: `Add '${dir}/' to .gitignore?`,
                    });
                    if (p.isCancel(confirmed)) {
                        printInfo("Cancelled.");
                        process.exit(EXIT_CODES.SUCCESS);
                    }
                    append = confirmed;
                }
            }
            if (append) {
                const prefix =
                    gitignoreContent === null || gitignoreContent === ""
                        ? ""
                        : gitignoreContent.endsWith("\n")
                          ? ""
                          : "\n";
                const { error: appendError } = await tryCatch(
                    fs.appendFile(gitignorePath, `${prefix}${dir}/\n`)
                );
                if (appendError) {
                    printWarn(
                        `  Could not update .gitignore: ${appendError.message}`
                    );
                } else {
                    printSuccess(`  Added '${dir}/' to .gitignore.`);
                }
            } else if (process.stdin.isTTY === true) {
                printInfo(
                    `  Left .gitignore unchanged. Add '${dir}/' manually.`
                );
            }
        }

        console.error("");
        printSuccess("Setup complete.");
        printInfo("  Commit .worktreerc so teammates get the same defaults.");
    },
});
