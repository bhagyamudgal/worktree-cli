import { describe, expect, it } from "bun:test";
import { parsePorcelainOutput, parseStatusPaths } from "./git";

describe("parsePorcelainOutput", () => {
    it("parses multiple worktree entries", () => {
        const output = [
            "worktree /Users/dev/project",
            "HEAD abc123",
            "branch refs/heads/main",
            "",
            "worktree /Users/dev/project/.worktrees/feat-auth",
            "HEAD def456",
            "branch refs/heads/feat-auth",
            "",
        ].join("\n");

        const entries = parsePorcelainOutput(output);
        expect(entries).toEqual([
            {
                path: "/Users/dev/project",
                branch: "main",
                isLocked: false,
                isPrunable: false,
            },
            {
                path: "/Users/dev/project/.worktrees/feat-auth",
                branch: "feat-auth",
                isLocked: false,
                isPrunable: false,
            },
        ]);
    });

    it("handles detached HEAD (no branch line)", () => {
        const output = [
            "worktree /Users/dev/project/.worktrees/detached",
            "HEAD abc123",
            "detached",
            "",
        ].join("\n");

        const entries = parsePorcelainOutput(output);
        expect(entries).toEqual([
            {
                path: "/Users/dev/project/.worktrees/detached",
                branch: "",
                isLocked: false,
                isPrunable: false,
            },
        ]);
    });

    it("returns empty array for empty output", () => {
        const entries = parsePorcelainOutput("");
        expect(entries).toEqual([]);
    });

    it("handles single worktree entry", () => {
        const output = [
            "worktree /Users/dev/project",
            "HEAD abc123",
            "branch refs/heads/main",
        ].join("\n");

        const entries = parsePorcelainOutput(output);
        expect(entries).toEqual([
            {
                path: "/Users/dev/project",
                branch: "main",
                isLocked: false,
                isPrunable: false,
            },
        ]);
    });

    it("handles branch names with slashes", () => {
        const output = [
            "worktree /Users/dev/project/.worktrees/feature",
            "HEAD abc123",
            "branch refs/heads/feature/deep/nested",
        ].join("\n");

        const entries = parsePorcelainOutput(output);
        expect(entries).toEqual([
            {
                path: "/Users/dev/project/.worktrees/feature",
                branch: "feature/deep/nested",
                isLocked: false,
                isPrunable: false,
            },
        ]);
    });

    it("marks locked and prunable worktrees", () => {
        const output = [
            "worktree /Users/dev/project/.worktrees/locked",
            "HEAD abc123",
            "branch refs/heads/locked",
            "locked in use",
            "",
            "worktree /Users/dev/project/.worktrees/broken",
            "HEAD 0000000",
            "prunable gitdir file points to non-existent location",
        ].join("\n");

        const entries = parsePorcelainOutput(output);
        expect(entries).toEqual([
            {
                path: "/Users/dev/project/.worktrees/locked",
                branch: "locked",
                isLocked: true,
                isPrunable: false,
            },
            {
                path: "/Users/dev/project/.worktrees/broken",
                branch: "",
                isLocked: false,
                isPrunable: true,
            },
        ]);
    });

    it("preserves newlines in NUL-delimited worktree paths", () => {
        const output = [
            "worktree /Users/dev/project",
            "HEAD abc123",
            "branch refs/heads/main",
            "",
            "worktree /Users/dev/line\nbreak",
            "HEAD def456",
            "detached",
            "",
            "",
        ].join("\0");

        expect(parsePorcelainOutput(output)).toEqual([
            {
                path: "/Users/dev/project",
                branch: "main",
                isLocked: false,
                isPrunable: false,
            },
            {
                path: "/Users/dev/line\nbreak",
                branch: "",
                isLocked: false,
                isPrunable: false,
            },
        ]);
    });
});

describe("parseStatusPaths", () => {
    it("extracts tracked, untracked, and renamed paths", () => {
        const output = [
            "1 .M N... 100644 100644 100644 abc123 abc123 src/app.ts",
            "? notes.txt",
            "2 R. N... 100644 100644 100644 abc123 def456 R100 src/new name.ts",
            "src/old name.ts",
            "",
        ].join("\0");

        expect(parseStatusPaths(output)).toEqual([
            "src/app.ts",
            "notes.txt",
            "src/new name.ts",
            "src/old name.ts",
        ]);
    });

    it("fails closed on malformed status output", () => {
        expect(parseStatusPaths("unexpected record\0")).toBeNull();
    });
});
