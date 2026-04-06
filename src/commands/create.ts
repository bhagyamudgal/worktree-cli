import { command, positional, string } from "@drizzle-team/brocli";
import path from "node:path";
import fs from "node:fs/promises";
import {
    getGitRoot,
    gitFetch,
    gitRevParseVerify,
    gitWorktreeAdd,
    gitUnsetUpstream,
} from "../lib/git";
import { loadConfig } from "../lib/config";
import { resolveEditor, openInEditor } from "../lib/editor";
import { copyEnvFiles } from "../lib/env-files";
import {
    detectPackageManager,
    installDependencies,
} from "../lib/package-manager";
import {
    printSuccess,
    printError,
    printWarn,
    printHeader,
    printStep,
    COLORS,
} from "../lib/logger";
import { EXIT_CODES } from "../lib/constants";

export const createCommand = command({
    name: "create",
    desc: "Create a new worktree",
    options: {
        name: positional("name").desc("Worktree/branch name").required(),
        base: string("base").desc("Base branch to create from"),
        editor: string("editor").desc("Editor to open (code or cursor)"),
    },
    handler: async (opts) => {
        const root = await getGitRoot();
        const config = await loadConfig(root);
        const isBaseExplicit = opts.base !== undefined;
        let base = opts.base ?? config.DEFAULT_BASE ?? "";
        const worktreePath = path.join(root, config.WORKTREE_DIR, opts.name);

        const worktreeBaseDir = path.join(root, config.WORKTREE_DIR);
        const gitignorePath = path.join(worktreeBaseDir, ".gitignore");
        await fs.mkdir(worktreeBaseDir, { recursive: true });
        await fs.writeFile(gitignorePath, "*\n", { flag: "wx" }).catch((e) => {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
                printWarn("  Could not create .worktrees/.gitignore.");
            }
        });

        const dirExists = await fs.stat(worktreePath).catch(() => null);
        if (dirExists) {
            printError(
                `Worktree '${opts.name}' already exists at ${worktreePath}`
            );
            process.exit(EXIT_CODES.ERROR);
        }

        printHeader(`Creating worktree '${opts.name}'...`);
        console.error("");

        printStep(1, 5, "Fetching latest remote refs...");
        const fetchResult = await gitFetch();
        if (fetchResult.success) {
            printSuccess("  Remote refs updated.");
        } else {
            printWarn(
                "  Fetch failed (network issue or ref conflict). Continuing with local refs..."
            );
        }
        console.error("");

        let isTrackingRemote = false;
        const hasRemoteBranch = await gitRevParseVerify(`origin/${opts.name}`);

        if (hasRemoteBranch) {
            isTrackingRemote = true;
            if (isBaseExplicit) {
                printWarn(
                    `  --base '${base}' ignored: remote branch 'origin/${opts.name}' exists and takes priority.`
                );
            }
        } else {
            if (!base) {
                printError("No default base branch configured.");
                printError("Create a .worktreerc file at your repo root with:");
                printError("  DEFAULT_BASE=origin/dev");
                printError("Or use --base <branch> to specify one.");
                process.exit(EXIT_CODES.ERROR);
            }

            const isBaseValid = await gitRevParseVerify(base);
            if (!isBaseValid) {
                const isOriginBase = await gitRevParseVerify(`origin/${base}`);
                if (!isOriginBase) {
                    printError(
                        `Base branch '${base}' not found locally or on origin.`
                    );
                    process.exit(EXIT_CODES.ERROR);
                }
                base = `origin/${base}`;
            }
        }

        printStep(2, 5, "Creating git worktree...");
        if (isTrackingRemote) {
            await gitWorktreeAdd(
                worktreePath,
                opts.name,
                `origin/${opts.name}`
            );
            printSuccess(
                `  Tracking existing remote branch origin/${opts.name}`
            );
        } else {
            await gitWorktreeAdd(worktreePath, opts.name, base);
            await gitUnsetUpstream(worktreePath);
            printSuccess(
                `  New branch '${opts.name}' created from ${base} (no upstream — push with -u to set)`
            );
        }
        console.error("");

        printStep(3, 5, "Copying env files...");
        await copyEnvFiles(root, worktreePath, config.WORKTREE_DIR);
        console.error("");

        printStep(4, 5, "Installing dependencies...");
        const pm = await detectPackageManager(root);
        if (pm) {
            await installDependencies(pm, worktreePath);
        } else {
            printWarn("  No lockfile found. Skipping dependency install.");
        }
        console.error("");

        printStep(5, 5, "Opening in editor...");
        const editor = await resolveEditor(opts.editor);
        openInEditor(editor, worktreePath);

        const { BOLD, GREEN, DIM, RESET } = COLORS;
        console.error("");
        console.error(`${GREEN}${BOLD}Done!${RESET}`);
        console.error(`  Path:   ${BOLD}${worktreePath}${RESET}`);
        console.error(`  Branch: ${BOLD}${opts.name}${RESET}`);
        if (isTrackingRemote) {
            console.error(
                `  Source: ${DIM}origin/${opts.name} (existing remote branch)${RESET}`
            );
        } else {
            console.error(`  Base:   ${DIM}${base}${RESET}`);
        }
        console.error("");
        console.error(`  ${DIM}cd ${worktreePath}${RESET}`);
    },
});
