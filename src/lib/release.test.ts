import { describe, expect, it } from "bun:test";
import { compareVersions, parseSha256Sums } from "./release";

describe("compareVersions", () => {
    it("returns 0 for equal versions", () => {
        expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
        expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    });

    it("returns negative when a < b", () => {
        expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
        expect(compareVersions("1.2.3", "1.3.0")).toBeLessThan(0);
        expect(compareVersions("1.2.3", "2.0.0")).toBeLessThan(0);
    });

    it("returns positive when a > b", () => {
        expect(compareVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
        expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    });

    it("handles missing components as 0", () => {
        expect(compareVersions("1", "1.0.0")).toBe(0);
        expect(compareVersions("1.0", "1.0.1")).toBeLessThan(0);
    });

    it("treats prerelease tags on the patch as equal to the base patch", () => {
        expect(compareVersions("1.2.3-beta", "1.2.3")).toBe(0);
        expect(compareVersions("1.2.3-beta.1", "1.2.3-beta.2")).toBe(0);
        expect(compareVersions("1.2.3-rc.1", "1.2.4")).toBeLessThan(0);
    });

    it("never returns NaN for garbage input", () => {
        expect(Number.isFinite(compareVersions("junk", "1.2.3"))).toBe(true);
        expect(Number.isFinite(compareVersions("1.2.3", "also-junk"))).toBe(
            true
        );
    });
});

describe("parseSha256Sums", () => {
    it("parses standard shasum -a 256 output", () => {
        const text = [
            "a".repeat(64) + "  worktree-darwin-arm64",
            "b".repeat(64) + "  worktree-linux-x64",
        ].join("\n");
        const result = parseSha256Sums(text);
        expect(result["worktree-darwin-arm64"]).toBe("a".repeat(64));
        expect(result["worktree-linux-x64"]).toBe("b".repeat(64));
    });

    it("parses BSD-style asterisk prefix", () => {
        const text = "c".repeat(64) + "  *worktree-darwin-x64";
        const result = parseSha256Sums(text);
        expect(result["worktree-darwin-x64"]).toBe("c".repeat(64));
    });

    it("skips comments and blank lines", () => {
        const text = [
            "# header comment",
            "",
            "d".repeat(64) + "  worktree-linux-arm64",
        ].join("\n");
        const result = parseSha256Sums(text);
        expect(Object.keys(result)).toEqual(["worktree-linux-arm64"]);
    });

    it("lowercases the hash", () => {
        const hash = "ABCDEF" + "0".repeat(58);
        const text = hash + "  worktree-linux-x64";
        const result = parseSha256Sums(text);
        expect(result["worktree-linux-x64"]).toBe(hash.toLowerCase());
    });

    it("ignores malformed lines", () => {
        const text = [
            "not-a-hash  worktree-darwin-arm64",
            "e".repeat(64) + "  worktree-linux-x64",
        ].join("\n");
        const result = parseSha256Sums(text);
        expect(Object.keys(result)).toEqual(["worktree-linux-x64"]);
    });
});
