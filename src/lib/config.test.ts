import { describe, expect, it } from "bun:test";
import { parseConfigContent, validateConfig } from "./config";
import { DEFAULT_WORKTREE_DIR } from "./constants";

describe("parseConfigContent", () => {
    it("parses key=value pairs", () => {
        const result = parseConfigContent(
            "DEFAULT_BASE=origin/dev\nWORKTREE_DIR=.wt"
        );
        expect(result).toEqual({
            DEFAULT_BASE: "origin/dev",
            WORKTREE_DIR: ".wt",
        });
    });

    it("strips double quotes from values", () => {
        const result = parseConfigContent('DEFAULT_BASE="origin/dev"');
        expect(result).toEqual({ DEFAULT_BASE: "origin/dev" });
    });

    it("strips single quotes from values", () => {
        const result = parseConfigContent("DEFAULT_BASE='origin/dev'");
        expect(result).toEqual({ DEFAULT_BASE: "origin/dev" });
    });

    it("skips empty lines", () => {
        const result = parseConfigContent("\n\nDEFAULT_BASE=origin/dev\n\n");
        expect(result).toEqual({ DEFAULT_BASE: "origin/dev" });
    });

    it("skips comment lines", () => {
        const result = parseConfigContent(
            "# this is a comment\nDEFAULT_BASE=origin/dev"
        );
        expect(result).toEqual({ DEFAULT_BASE: "origin/dev" });
    });

    it("skips lines without equals sign", () => {
        const result = parseConfigContent(
            "no-equals-here\nDEFAULT_BASE=origin/dev"
        );
        expect(result).toEqual({ DEFAULT_BASE: "origin/dev" });
    });

    it("handles values containing equals signs", () => {
        const result = parseConfigContent("KEY=value=with=equals");
        expect(result).toEqual({ KEY: "value=with=equals" });
    });

    it("returns empty object for empty content", () => {
        const result = parseConfigContent("");
        expect(result).toEqual({});
    });

    it("trims whitespace around keys and values", () => {
        const result = parseConfigContent("  DEFAULT_BASE  =  origin/dev  ");
        expect(result).toEqual({ DEFAULT_BASE: "origin/dev" });
    });

    it("skips lines with empty keys", () => {
        const result = parseConfigContent("=value\nDEFAULT_BASE=origin/dev");
        expect(result).toEqual({ DEFAULT_BASE: "origin/dev" });
    });
});

describe("validateConfig", () => {
    it("applies defaults for empty input", () => {
        const config = validateConfig({});
        expect(config.DEFAULT_BASE).toBeUndefined();
        expect(config.WORKTREE_DIR).toBe(DEFAULT_WORKTREE_DIR);
    });

    it("uses provided values", () => {
        const config = validateConfig({
            DEFAULT_BASE: "origin/main",
            WORKTREE_DIR: ".wt",
        });
        expect(config.DEFAULT_BASE).toBe("origin/main");
        expect(config.WORKTREE_DIR).toBe(".wt");
    });

    it("strips unknown keys", () => {
        const config = validateConfig({
            DEFAULT_BASE: "origin/dev",
            UNKNOWN_KEY: "value",
        });
        expect(config.DEFAULT_BASE).toBe("origin/dev");
        expect("UNKNOWN_KEY" in config).toBe(false);
    });

    it("applies WORKTREE_DIR default when only DEFAULT_BASE is provided", () => {
        const config = validateConfig({ DEFAULT_BASE: "origin/dev" });
        expect(config.WORKTREE_DIR).toBe(DEFAULT_WORKTREE_DIR);
    });
});
