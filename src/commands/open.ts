import { command, positional, string } from "@drizzle-team/brocli";
import path from "node:path";
import fs from "node:fs/promises";
import { getGitRoot, getDefaultBranch, selectWorktree } from "../lib/git";
import { loadConfig } from "../lib/config";
import { resolveEditor, openInEditor } from "../lib/editor";
import { printError } from "../lib/logger";
import { EXIT_CODES } from "../lib/constants";

export const openCommand = command({
    name: "open",
    desc: "Open an existing worktree in editor",
    options: {
        name: positional("name").desc("Worktree name (interactive if omitted)"),
        editor: string("editor").desc("Editor to open (code or cursor)"),
    },
    handler: async (opts) => {
        const root = await getGitRoot();
        const config = await loadConfig(root);

        const defaultBranch = await getDefaultBranch(config.DEFAULT_BASE);
        const name =
            opts.name ??
            (await selectWorktree(root, config.WORKTREE_DIR, defaultBranch));
        const worktreePath = path.join(root, config.WORKTREE_DIR, name);

        const dirExists = await fs.stat(worktreePath).catch(() => null);

        if (!dirExists) {
            printError(`Worktree '${name}' not found at ${worktreePath}`);
            process.exit(EXIT_CODES.ERROR);
        }

        const editor = await resolveEditor(opts.editor);
        openInEditor(editor, worktreePath);
    },
});
