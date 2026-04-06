import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { findEnvFiles } from "./env-files";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("findEnvFiles", () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-test-"));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("finds .env and .env.local in root", async () => {
        await fs.writeFile(path.join(tmpDir, ".env"), "KEY=val");
        await fs.writeFile(path.join(tmpDir, ".env.local"), "KEY=val");

        const files = await findEnvFiles(tmpDir, ".worktrees");
        const names = files.map((f) => path.basename(f));

        expect(names).toContain(".env");
        expect(names).toContain(".env.local");
    });

    it("finds .env in subdirectory", async () => {
        const subDir = path.join(tmpDir, "packages", "api");
        await fs.mkdir(subDir, { recursive: true });
        await fs.writeFile(path.join(subDir, ".env"), "KEY=val");

        const files = await findEnvFiles(tmpDir, ".worktrees");

        expect(files.length).toBe(1);
        expect(files[0]).toContain(path.join("packages", "api", ".env"));
    });

    it("excludes node_modules directory", async () => {
        const nmDir = path.join(tmpDir, "node_modules", "pkg");
        await fs.mkdir(nmDir, { recursive: true });
        await fs.writeFile(path.join(nmDir, ".env"), "KEY=val");

        const files = await findEnvFiles(tmpDir, ".worktrees");

        expect(files.length).toBe(0);
    });

    it("excludes worktree directory", async () => {
        const wtDir = path.join(tmpDir, ".worktrees", "feat");
        await fs.mkdir(wtDir, { recursive: true });
        await fs.writeFile(path.join(wtDir, ".env"), "KEY=val");

        const files = await findEnvFiles(tmpDir, ".worktrees");

        expect(files.length).toBe(0);
    });

    it("returns empty array when no env files exist", async () => {
        await fs.writeFile(path.join(tmpDir, "readme.md"), "hello");

        const files = await findEnvFiles(tmpDir, ".worktrees");

        expect(files).toEqual([]);
    });

    it("returns sorted paths", async () => {
        const subDir = path.join(tmpDir, "aaa");
        await fs.mkdir(subDir, { recursive: true });
        await fs.writeFile(path.join(tmpDir, ".env.local"), "KEY=val");
        await fs.writeFile(path.join(tmpDir, ".env"), "KEY=val");
        await fs.writeFile(path.join(subDir, ".env"), "KEY=val");

        const files = await findEnvFiles(tmpDir, ".worktrees");

        for (let i = 1; i < files.length; i++) {
            expect(files[i] >= files[i - 1]).toBe(true);
        }
    });
});
