import { describe, expect, it } from "bun:test";
import { parsePorcelainOutput } from "./git";

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
            { path: "/Users/dev/project", branch: "main" },
            {
                path: "/Users/dev/project/.worktrees/feat-auth",
                branch: "feat-auth",
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
            { path: "/Users/dev/project/.worktrees/detached", branch: "" },
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
            { path: "/Users/dev/project", branch: "main" },
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
            },
        ]);
    });
});
