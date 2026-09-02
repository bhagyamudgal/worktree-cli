import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitBranchDeleteIfMatches } from "../lib/git";
import { run } from "../lib/shell";

type TestRepository = {
    directory: string;
    root: string;
};

const cleanupDirectories: string[] = [];
const cliPath = path.resolve(import.meta.dir, "../index.ts");
const INTEGRATION_TEST_TIMEOUT_MS = 20_000;

setDefaultTimeout(INTEGRATION_TEST_TIMEOUT_MS);

async function createTestRepository(): Promise<TestRepository> {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "worktree-clean-test-")
    );
    cleanupDirectories.push(directory);

    const remote = path.join(directory, "remote.git");
    const root = path.join(directory, "repository");
    await fs.mkdir(root);

    await run("git", ["init", "--bare", remote]);
    await run("git", ["init", "-b", "main"], { cwd: root });
    await run("git", ["config", "user.name", "Test User"], { cwd: root });
    await run("git", ["config", "user.email", "test@example.com"], {
        cwd: root,
    });

    await fs.mkdir(path.join(root, ".husky", "_"), { recursive: true });
    await fs.writeFile(path.join(root, "app.ts"), "export const value = 1;\n");
    await fs.writeFile(
        path.join(root, ".gitignore"),
        "node_modules/\n.husky/_/*\n!.husky/_/tracked-hook\n"
    );
    await fs.writeFile(
        path.join(root, ".husky", "_", "tracked-hook"),
        "initial\n"
    );
    await fs.writeFile(
        path.join(root, ".worktreerc"),
        "DEFAULT_BASE=origin/main\n"
    );
    await run("git", ["add", "."], { cwd: root });
    await run("git", ["commit", "-m", "initial"], { cwd: root });
    await run("git", ["remote", "add", "origin", remote], { cwd: root });
    await run("git", ["push", "-u", "origin", "main"], { cwd: root });

    return { directory, root };
}

async function runClean(root: string): Promise<{
    stderr: string;
    exitCode: number;
}> {
    const cliProcess = Bun.spawn(
        [process.execPath, "run", cliPath, "clean", "--yes"],
        {
            cwd: root,
            env: { ...Bun.env, WORKTREE_NO_UPDATE: "1", NO_COLOR: "1" },
            stdout: "pipe",
            stderr: "pipe",
        }
    );
    const [stderr, exitCode] = await Promise.all([
        new Response(cliProcess.stderr).text(),
        cliProcess.exited,
    ]);
    return { stderr, exitCode };
}

afterEach(async () => {
    await Promise.all(
        cleanupDirectories.splice(0).map(function (directory) {
            return fs.rm(directory, { recursive: true, force: true });
        })
    );
});

describe("clean command", () => {
    it("removes a merged worktree with ignored residue and its local branch", async () => {
        const { directory, root } = await createTestRepository();
        const worktreePath = path.join(directory, "clean-worktree");
        await run(
            "git",
            ["worktree", "add", "-b", "clean-branch", worktreePath, "main"],
            { cwd: root }
        );
        await fs.mkdir(path.join(worktreePath, "node_modules"));
        await fs.writeFile(
            path.join(worktreePath, "node_modules", "stale"),
            "generated\n"
        );

        const result = await runClean(root);

        expect(result.exitCode).toBe(0);
        expect(await fs.stat(worktreePath).catch(() => null)).toBeNull();
        const branch = await run("git", ["branch", "--list", "clean-branch"], {
            cwd: root,
        });
        expect(branch.stdout).toBe("");
        expect(result.stderr).toContain("Removed: 1");
    });

    it("removes tracked Husky residue but preserves code changes", async () => {
        const { directory, root } = await createTestRepository();
        const huskyPath = path.join(directory, "husky-worktree");
        const codePath = path.join(directory, "code-worktree");
        await run(
            "git",
            ["worktree", "add", "-b", "husky-branch", huskyPath, "main"],
            { cwd: root }
        );
        await run(
            "git",
            ["worktree", "add", "-b", "code-branch", codePath, "main"],
            { cwd: root }
        );
        await fs.writeFile(
            path.join(huskyPath, ".husky", "_", "tracked-hook"),
            "stale\n"
        );
        await fs.writeFile(
            path.join(codePath, "app.ts"),
            "export const value = 2;\n"
        );

        const result = await runClean(root);

        expect(result.exitCode).toBe(0);
        expect(await fs.stat(huskyPath).catch(() => null)).toBeNull();
        expect(await fs.stat(codePath).catch(() => null)).not.toBeNull();
        expect(result.stderr).toContain("code-worktree");
        expect(result.stderr).toContain("uncommitted change");
    });

    it("preserves an unmerged worktree", async () => {
        const { directory, root } = await createTestRepository();
        const worktreePath = path.join(directory, "unmerged-worktree");
        await run(
            "git",
            ["worktree", "add", "-b", "unmerged-branch", worktreePath, "main"],
            { cwd: root }
        );
        await fs.writeFile(
            path.join(worktreePath, "app.ts"),
            "export const value = 3;\n"
        );
        await run("git", ["add", "app.ts"], { cwd: worktreePath });
        await run("git", ["commit", "-m", "unmerged"], {
            cwd: worktreePath,
        });

        const result = await runClean(root);

        expect(result.exitCode).toBe(0);
        expect(await fs.stat(worktreePath).catch(() => null)).not.toBeNull();
        expect(result.stderr).toContain("not merged into origin/main");
    });

    it("removes a merged detached worktree outside the repository", async () => {
        const { directory, root } = await createTestRepository();
        const worktreePath = path.join(directory, "detached-worktree");
        await run(
            "git",
            ["worktree", "add", "--detach", worktreePath, "main"],
            { cwd: root }
        );

        const result = await runClean(root);

        expect(result.exitCode).toBe(0);
        expect(await fs.stat(worktreePath).catch(() => null)).toBeNull();
        expect(result.stderr).toContain("detached");
    });

    it("removes a worktree whose path contains a newline", async () => {
        const { directory, root } = await createTestRepository();
        const worktreePath = path.join(directory, "line\nbreak-worktree");
        await run(
            "git",
            ["worktree", "add", "-b", "newline-branch", worktreePath, "main"],
            { cwd: root }
        );

        const result = await runClean(root);

        expect(result.exitCode).toBe(0);
        expect(await fs.stat(worktreePath).catch(() => null)).toBeNull();
    });

    it("preserves a worktree with a merge in progress", async () => {
        const { directory, root } = await createTestRepository();
        await run("git", ["switch", "-c", "empty-side"], { cwd: root });
        await run("git", ["commit", "--allow-empty", "-m", "empty side"], {
            cwd: root,
        });
        await run("git", ["switch", "main"], { cwd: root });

        const worktreePath = path.join(directory, "merging-worktree");
        await run(
            "git",
            ["worktree", "add", "-b", "merging-branch", worktreePath, "main"],
            { cwd: root }
        );
        await run("git", ["merge", "--no-commit", "--no-ff", "empty-side"], {
            cwd: worktreePath,
        });

        const result = await runClean(root);

        expect(result.exitCode).toBe(0);
        expect(await fs.stat(worktreePath).catch(() => null)).not.toBeNull();
        expect(result.stderr).toContain("merge in progress");
    });

    it("preserves a worktree with code changes inside a submodule", async () => {
        const { directory, root } = await createTestRepository();
        const submoduleSource = path.join(directory, "submodule-source");
        await fs.mkdir(submoduleSource);
        await run("git", ["init", "-b", "main"], { cwd: submoduleSource });
        await run("git", ["config", "user.name", "Test User"], {
            cwd: submoduleSource,
        });
        await run("git", ["config", "user.email", "test@example.com"], {
            cwd: submoduleSource,
        });
        await fs.writeFile(
            path.join(submoduleSource, "module.ts"),
            "export const moduleValue = 1;\n"
        );
        await run("git", ["add", "module.ts"], { cwd: submoduleSource });
        await run("git", ["commit", "-m", "module"], {
            cwd: submoduleSource,
        });
        await run(
            "git",
            [
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                submoduleSource,
                "modules/example",
            ],
            { cwd: root }
        );
        await run("git", ["commit", "-m", "add submodule"], { cwd: root });
        await run("git", ["push", "origin", "main"], { cwd: root });

        const worktreePath = path.join(directory, "submodule-worktree");
        await run(
            "git",
            ["worktree", "add", "-b", "submodule-branch", worktreePath, "main"],
            { cwd: root }
        );
        await run(
            "git",
            [
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "update",
                "--init",
            ],
            { cwd: worktreePath }
        );
        await fs.writeFile(
            path.join(worktreePath, "modules", "example", "module.ts"),
            "export const moduleValue = 2;\n"
        );

        const result = await runClean(root);

        expect(result.exitCode).toBe(0);
        expect(await fs.stat(worktreePath).catch(() => null)).not.toBeNull();
        expect(result.stderr).toContain("uncommitted change");
    });

    it("preserves worktrees with clean initialized or uninitialized submodules", async () => {
        const { directory, root } = await createTestRepository();
        const submoduleSource = path.join(directory, "clean-submodule-source");
        await fs.mkdir(submoduleSource);
        await run("git", ["init", "-b", "main"], { cwd: submoduleSource });
        await run("git", ["config", "user.name", "Test User"], {
            cwd: submoduleSource,
        });
        await run("git", ["config", "user.email", "test@example.com"], {
            cwd: submoduleSource,
        });
        await fs.writeFile(path.join(submoduleSource, "module.ts"), "clean\n");
        await run("git", ["add", "module.ts"], { cwd: submoduleSource });
        await run("git", ["commit", "-m", "module"], {
            cwd: submoduleSource,
        });
        await run(
            "git",
            [
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                submoduleSource,
                "modules/example",
            ],
            { cwd: root }
        );
        await run("git", ["commit", "-m", "add submodule"], { cwd: root });
        await run("git", ["push", "origin", "main"], { cwd: root });

        const worktreePath = path.join(directory, "clean-submodule-worktree");
        const uninitializedPath = path.join(
            directory,
            "uninitialized-submodule-worktree"
        );
        await run(
            "git",
            [
                "worktree",
                "add",
                "-b",
                "clean-submodule-branch",
                worktreePath,
                "main",
            ],
            { cwd: root }
        );
        await run(
            "git",
            [
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "update",
                "--init",
            ],
            { cwd: worktreePath }
        );
        await run(
            "git",
            [
                "worktree",
                "add",
                "-b",
                "uninitialized-submodule-branch",
                uninitializedPath,
                "main",
            ],
            { cwd: root }
        );
        const submoduleConfigBefore = await run(
            "git",
            ["config", "--get-regexp", "^submodule\\."],
            { cwd: root }
        );

        const result = await runClean(root);

        expect(result.exitCode).toBe(0);
        expect(await fs.stat(worktreePath).catch(() => null)).not.toBeNull();
        expect(
            await fs.stat(uninitializedPath).catch(() => null)
        ).not.toBeNull();
        expect(result.stderr).toContain("contains submodules");
        const submoduleConfigAfter = await run(
            "git",
            ["config", "--get-regexp", "^submodule\\."],
            { cwd: root }
        );
        expect(submoduleConfigAfter.stdout).toBe(submoduleConfigBefore.stdout);
    });

    it("skips locked worktrees", async () => {
        const { directory, root } = await createTestRepository();
        const worktreePath = path.join(directory, "locked-worktree");
        await run(
            "git",
            ["worktree", "add", "-b", "locked-branch", worktreePath, "main"],
            { cwd: root }
        );
        await run("git", ["worktree", "lock", worktreePath], { cwd: root });

        const result = await runClean(root);

        expect(result.exitCode).toBe(0);
        expect(await fs.stat(worktreePath).catch(() => null)).not.toBeNull();
        expect(result.stderr).toContain(`${worktreePath}: locked`);
    });

    it("continues after one worktree removal fails", async () => {
        const { directory, root } = await createTestRepository();
        const blockedParent = path.join(directory, "blocked-parent");
        const blockedPath = path.join(blockedParent, "blocked-worktree");
        const removablePath = path.join(directory, "removable-worktree");
        await fs.mkdir(blockedParent);
        await run(
            "git",
            ["worktree", "add", "-b", "blocked-branch", blockedPath, "main"],
            { cwd: root }
        );
        await run(
            "git",
            [
                "worktree",
                "add",
                "-b",
                "removable-branch",
                removablePath,
                "main",
            ],
            { cwd: root }
        );
        await fs.chmod(blockedParent, 0o555);

        const result = await runClean(root);
        await fs.chmod(blockedParent, 0o755);

        expect(result.exitCode).toBe(1);
        expect(await fs.stat(removablePath).catch(() => null)).toBeNull();
        expect(result.stderr).toContain("Removed: 1");
        expect(result.stderr).toContain("Failed: 1");
    });

    it("aborts before removal when fetch fails", async () => {
        const { directory, root } = await createTestRepository();
        const worktreePath = path.join(directory, "clean-worktree");
        await run(
            "git",
            ["worktree", "add", "-b", "clean-branch", worktreePath, "main"],
            { cwd: root }
        );
        await run(
            "git",
            ["remote", "set-url", "origin", path.join(directory, "missing")],
            { cwd: root }
        );

        const result = await runClean(root);

        expect(result.exitCode).toBe(1);
        expect(await fs.stat(worktreePath).catch(() => null)).not.toBeNull();
        expect(result.stderr).toContain(
            "Fetch failed. No worktrees were removed."
        );
    });

    it("keeps a branch when its tip no longer matches the verified HEAD", async () => {
        const { root } = await createTestRepository();
        const expectedHead = (
            await run("git", ["rev-parse", "HEAD"], { cwd: root })
        ).stdout;
        await run("git", ["branch", "candidate", expectedHead], { cwd: root });
        await run("git", ["switch", "-c", "advanced"], { cwd: root });
        await run("git", ["commit", "--allow-empty", "-m", "advanced"], {
            cwd: root,
        });
        const advancedHead = (
            await run("git", ["rev-parse", "HEAD"], { cwd: root })
        ).stdout;
        await run("git", ["switch", "main"], { cwd: root });
        await run("git", ["update-ref", "refs/heads/candidate", advancedHead], {
            cwd: root,
        });

        const isDeleted = await gitBranchDeleteIfMatches(
            root,
            "candidate",
            expectedHead,
            "main"
        );

        expect(isDeleted).toBe("changed");
        const candidateHead = await run("git", ["rev-parse", "candidate"], {
            cwd: root,
        });
        expect(candidateHead.stdout).toBe(advancedHead);
    });

    it("keeps a branch used by another worktree", async () => {
        const { directory, root } = await createTestRepository();
        const firstPath = path.join(directory, "shared-first");
        const secondPath = path.join(directory, "shared-second");
        await run(
            "git",
            ["worktree", "add", "-b", "shared", firstPath, "main"],
            { cwd: root }
        );
        const duplicate = await run(
            "git",
            ["worktree", "add", "--force", secondPath, "shared"],
            { cwd: root }
        );
        expect(duplicate.exitCode).toBe(0);
        await fs.writeFile(
            path.join(secondPath, "app.ts"),
            "export const value = 4;\n"
        );

        const result = await runClean(root);

        expect(result.exitCode).toBe(1);
        expect(await fs.stat(firstPath).catch(() => null)).toBeNull();
        expect(await fs.stat(secondPath).catch(() => null)).not.toBeNull();
        const sharedHead = await run("git", ["rev-parse", "shared"], {
            cwd: root,
        });
        expect(sharedHead.exitCode).toBe(0);
        expect(result.stderr).toContain("because another worktree uses it");
    });

    it("does not delete a branch used by a worktree during rebase", async () => {
        const { directory, root } = await createTestRepository();
        const worktreePath = path.join(directory, "rebasing-worktree");
        await run(
            "git",
            ["worktree", "add", "-b", "rebasing", worktreePath, "main"],
            { cwd: root }
        );
        await fs.writeFile(
            path.join(worktreePath, "app.ts"),
            "export const value = 2;\n"
        );
        await run("git", ["add", "app.ts"], { cwd: worktreePath });
        await run("git", ["commit", "-m", "worktree change"], {
            cwd: worktreePath,
        });
        const expectedHead = (
            await run("git", ["rev-parse", "rebasing"], { cwd: root })
        ).stdout;
        await fs.writeFile(
            path.join(root, "app.ts"),
            "export const value = 3;\n"
        );
        await run("git", ["add", "app.ts"], { cwd: root });
        await run("git", ["commit", "-m", "main change"], { cwd: root });
        const rebase = await run("git", ["rebase", "main"], {
            cwd: worktreePath,
        });
        expect(rebase.exitCode).toBe(1);
        const deletion = await gitBranchDeleteIfMatches(
            root,
            "rebasing",
            expectedHead,
            "main"
        );

        expect(deletion).toBe("failed");
        const branch = await run("git", ["rev-parse", "rebasing"], {
            cwd: root,
        });
        expect(branch.stdout).toBe(expectedHead);
    });

    it("removes branch-specific Git config after deleting a branch", async () => {
        const { root } = await createTestRepository();
        const expectedHead = (
            await run("git", ["rev-parse", "HEAD"], { cwd: root })
        ).stdout;
        await run("git", ["branch", "candidate", expectedHead], { cwd: root });
        await run("git", ["config", "branch.candidate.remote", "origin"], {
            cwd: root,
        });
        await run(
            "git",
            ["config", "branch.candidate.merge", "refs/heads/candidate"],
            { cwd: root }
        );

        const deletion = await gitBranchDeleteIfMatches(
            root,
            "candidate",
            expectedHead,
            "main"
        );

        expect(deletion).toBe("deleted");
        const config = await run(
            "git",
            ["config", "--get", "branch.candidate.remote"],
            { cwd: root }
        );
        expect(config.exitCode).toBe(1);
    });

    it("does not confuse another branch's config with the deleted branch", async () => {
        const { root } = await createTestRepository();
        const expectedHead = (
            await run("git", ["rev-parse", "HEAD"], { cwd: root })
        ).stdout;
        await run("git", ["branch", "candidate", expectedHead], { cwd: root });
        await run(
            "git",
            ["config", "branch.candidate.extra.remote", "origin"],
            {
                cwd: root,
            }
        );

        const deletion = await gitBranchDeleteIfMatches(
            root,
            "candidate",
            expectedHead,
            "main"
        );

        expect(deletion).toBe("deleted");
        const config = await run(
            "git",
            ["config", "--get", "branch.candidate.extra.remote"],
            { cwd: root }
        );
        expect(config.stdout).toBe("origin");
    });
});
