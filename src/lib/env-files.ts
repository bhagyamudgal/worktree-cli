import path from "node:path";
import fs from "node:fs/promises";
import {
    ENV_FILE_NAMES,
    ENV_SEARCH_MAX_DEPTH,
    ENV_EXCLUDE_DIRS,
    COLORS,
} from "./constants";
import { printSuccess, printWarn } from "./logger";
import { tryCatch } from "./try-catch";

async function findEnvFiles(
    root: string,
    worktreeDir: string
): Promise<string[]> {
    const results: string[] = [];
    const excludeDirs = new Set<string>([...ENV_EXCLUDE_DIRS, worktreeDir]);

    async function walk(dir: string, depth: number): Promise<void> {
        if (depth > ENV_SEARCH_MAX_DEPTH) return;

        const { data: names, error } = await tryCatch(fs.readdir(dir));
        if (error || !names) return;

        for (const name of names) {
            const fullPath = path.join(dir, name);
            const stat = await fs.stat(fullPath).catch(() => null);
            if (!stat) continue;

            if (stat.isDirectory()) {
                if (excludeDirs.has(name)) continue;
                await walk(fullPath, depth + 1);
            } else if (
                stat.isFile() &&
                ENV_FILE_NAMES.includes(name as (typeof ENV_FILE_NAMES)[number])
            ) {
                results.push(fullPath);
            }
        }
    }

    await walk(root, 0);
    return results.sort();
}

async function copyEnvFiles(
    root: string,
    worktreePath: string,
    worktreeDir: string
): Promise<void> {
    const envFiles = await findEnvFiles(root, worktreeDir);

    if (envFiles.length === 0) {
        printWarn("  No .env/.env.local files found to copy.");
        return;
    }

    let copied = 0;

    for (const envFile of envFiles) {
        const relativePath = path.relative(root, envFile);
        const targetPath = path.join(worktreePath, relativePath);
        const targetDir = path.dirname(targetPath);

        const { error } = await tryCatch(
            (async () => {
                await fs.mkdir(targetDir, { recursive: true });
                await fs.copyFile(envFile, targetPath);
            })()
        );

        if (error) {
            printWarn(`  Failed to copy ${relativePath}: ${error.message}`);
            continue;
        }

        console.error(`  ${COLORS.DIM}Copied${COLORS.RESET} ${relativePath}`);
        copied++;
    }

    printSuccess(`  ${copied} env file(s) copied.`);
}

export { copyEnvFiles, findEnvFiles };
