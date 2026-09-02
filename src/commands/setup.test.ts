import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
        path.join(os.tmpdir(), "worktree-setup-test-")
    );
    cleanupDirectories.push(directory);

    const remote = path.join(directory, "remote.git");
    const root = path.join(directory, "repository");
    await fs.mkdir(root);

    await run("git", ["init", "--bare", "-b", "main", remote]);
    await run("git", ["init", "-b", "main"], { cwd: root });
    await run("git", ["config", "user.name", "Test User"], { cwd: root });
    await run("git", ["config", "user.email", "test@example.com"], {
        cwd: root,
    });

    await fs.writeFile(path.join(root, "app.ts"), "export const value = 1;\n");
    await run("git", ["add", "."], { cwd: root });
    await run("git", ["commit", "-m", "initial"], { cwd: root });
    await run("git", ["remote", "add", "origin", remote], { cwd: root });
    await run("git", ["push", "-u", "origin", "main"], { cwd: root });
    await run("git", ["remote", "set-head", "origin", "-a"], { cwd: root });

    return { directory, root };
}

async function runSetup(
    root: string,
    args: string[]
): Promise<{ stderr: string; exitCode: number }> {
    const cliProcess = Bun.spawn(
        [process.execPath, "run", cliPath, "setup", ...args],
        {
            cwd: root,
            env: { ...Bun.env, WORKTREE_NO_UPDATE: "1", NO_COLOR: "1" },
            stdin: "ignore",
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

async function readFile(root: string, name: string): Promise<string | null> {
    return fs.readFile(path.join(root, name), "utf8").catch(() => null);
}

afterEach(async () => {
    await Promise.all(
        cleanupDirectories.splice(0).map(function (directory) {
            return fs.rm(directory, { recursive: true, force: true });
        })
    );
});

describe("setup command", () => {
    it("writes .worktreerc and wires up gitignores on first run", async () => {
        const { root } = await createTestRepository();

        const result = await runSetup(root, ["--base", "main", "--yes"]);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain("Setup complete.");
        const rc = await readFile(root, ".worktreerc");
        expect(rc).toContain("DEFAULT_BASE=origin/main");
        expect(rc).toContain("WORKTREE_DIR=.worktrees");
        expect(await readFile(root, ".worktrees/.gitignore")).toBe("*\n");
        expect(await readFile(root, ".gitignore")).toContain(".worktrees/\n");
    });

    it("resolves origin/HEAD when --yes has no configured base", async () => {
        const { root } = await createTestRepository();

        const result = await runSetup(root, ["--yes"]);

        expect(result.exitCode).toBe(0);
        expect(await readFile(root, ".worktreerc")).toContain(
            "DEFAULT_BASE=origin/main"
        );
    });

    it("rejects an unknown base without writing config", async () => {
        const { root } = await createTestRepository();

        const result = await runSetup(root, ["--base", "nope", "--yes"]);

        expect(result.exitCode).toBe(1);
        expect(await readFile(root, ".worktreerc")).toBeNull();
        expect(
            await fs.stat(path.join(root, ".worktrees")).catch(() => null)
        ).toBeNull();
    });

    it("rejects a stale configured base in --yes mode", async () => {
        const { root } = await createTestRepository();
        await fs.writeFile(
            path.join(root, ".worktreerc"),
            "DEFAULT_BASE=origin/stale\n"
        );

        const result = await runSetup(root, ["--yes"]);

        expect(result.exitCode).toBe(1);
        expect(await readFile(root, ".worktreerc")).toBe(
            "DEFAULT_BASE=origin/stale\n"
        );
    });

    it("preserves unknown keys and comments when rewriting", async () => {
        const { root } = await createTestRepository();
        await fs.writeFile(
            path.join(root, ".worktreerc"),
            "# team defaults\nCUSTOM=keepme\nDEFAULT_BASE=origin/main\n"
        );

        const result = await runSetup(root, ["--yes"]);

        expect(result.exitCode).toBe(0);
        const rc = await readFile(root, ".worktreerc");
        expect(rc).toContain("# team defaults");
        expect(rc).toContain("CUSTOM=keepme");
        expect(rc).toContain("DEFAULT_BASE=origin/main");
    });

    it("rejects a directory that escapes the repository", async () => {
        const { directory, root } = await createTestRepository();

        const result = await runSetup(root, [
            "--base",
            "main",
            "--worktree-dir",
            "../evil",
            "--yes",
        ]);

        expect(result.exitCode).toBe(1);
        expect(await readFile(root, ".worktreerc")).toBeNull();
        expect(
            await fs.stat(path.join(directory, "evil")).catch(() => null)
        ).toBeNull();
    });

    it("rejects the repository root as the worktree directory", async () => {
        const { root } = await createTestRepository();

        const result = await runSetup(root, [
            "--base",
            "main",
            "--worktree-dir",
            ".",
            "--yes",
        ]);

        expect(result.exitCode).toBe(1);
        expect(await readFile(root, ".worktreerc")).toBeNull();
    });

    it("fails before writing config when the directory cannot be created", async () => {
        const { root } = await createTestRepository();
        await fs.writeFile(path.join(root, ".worktrees"), "in the way\n");

        const result = await runSetup(root, ["--base", "main", "--yes"]);

        expect(result.exitCode).toBe(1);
        expect(await readFile(root, ".worktreerc")).toBeNull();
    });

    it("honors a custom directory and stays idempotent on rerun", async () => {
        const { root } = await createTestRepository();

        const first = await runSetup(root, [
            "--base",
            "main",
            "--worktree-dir",
            ".wt",
            "--yes",
        ]);
        expect(first.exitCode).toBe(0);
        expect(await readFile(root, ".wt/.gitignore")).toBe("*\n");

        const second = await runSetup(root, ["--yes"]);
        expect(second.exitCode).toBe(0);

        const gitignore = await readFile(root, ".gitignore");
        expect(
            gitignore?.split("\n").filter((line) => line === ".wt/")
        ).toHaveLength(1);
        expect(await readFile(root, ".worktreerc")).toContain(
            "WORKTREE_DIR=.wt"
        );
    });
});
