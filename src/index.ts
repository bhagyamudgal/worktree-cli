import { run } from "@drizzle-team/brocli";
import { createCommand } from "./commands/create";
import { listCommand } from "./commands/list";
import { openCommand } from "./commands/open";
import { removeCommand } from "./commands/remove";
import pkg from "../package.json";

run([createCommand, listCommand, openCommand, removeCommand], {
    name: "worktree",
    description: pkg.description ?? "Git worktree manager",
    version: pkg.version,
});
