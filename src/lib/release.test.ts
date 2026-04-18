import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    compareVersions,
    parseSha256Sums,
    verifyAssetAgainstSums,
    type ReleaseAsset,
} from "./release";

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

    it("treats prerelease tags as less than the base version (SemVer 2.0)", () => {
        expect(compareVersions("1.2.3-beta", "1.2.3")).toBeLessThan(0);
        expect(compareVersions("1.2.3", "1.2.3-beta")).toBeGreaterThan(0);
        expect(compareVersions("1.2.3-rc.1", "1.2.4")).toBeLessThan(0);
    });

    it("orders prerelease tags lexicographically (NOT strict SemVer)", () => {
        expect(compareVersions("1.2.3-beta.1", "1.2.3-beta.2")).toBeLessThan(0);
        expect(compareVersions("1.2.3-rc.1", "1.2.3-beta.1")).toBeGreaterThan(
            0
        );
        expect(compareVersions("1.2.3-alpha", "1.2.3-alpha")).toBe(0);
    });

    it("compares numeric prerelease segments as strings (rc.10 < rc.2)", () => {
        // Intentional non-strict-SemVer: "rc.10" sorts before "rc.2" by
        // lexicographic string compare. Strict SemVer 2.0 §11 would order
        // numeric segments numerically (rc.2 < rc.10). If prereleases ever
        // start shipping from this repo, revisit.
        expect(compareVersions("1.2.3-rc.10", "1.2.3-rc.2")).toBeLessThan(0);
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

    it("parses BSD-style asterisk prefix (shasum -b)", () => {
        const text = "c".repeat(64) + " *worktree-darwin-x64";
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

    it("rejects duplicate filename entries with different hashes", () => {
        const dupe = [
            "a".repeat(64) + "  worktree-darwin-arm64",
            "b".repeat(64) + "  worktree-darwin-arm64",
        ].join("\n");
        expect(() => parseSha256Sums(dupe)).toThrow(/Duplicate/);
    });
});

describe("verifyAssetAgainstSums", () => {
    const ASSET_BYTES = new Uint8Array([
        0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64,
    ]);
    // Precomputed SHA256 of "hello world" (ASSET_BYTES) — avoids runtime
    // dependence on Bun.CryptoHasher in test setup.
    const ASSET_SHA =
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    const ASSET_NAME = "worktree-darwin-arm64";

    let tmpFile: string;
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        tmpFile = path.join(
            os.tmpdir(),
            `verify-test-${process.pid}-${Date.now()}`
        );
        fs.writeFileSync(tmpFile, ASSET_BYTES);
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        try {
            fs.unlinkSync(tmpFile);
        } catch {
            // best-effort cleanup
        }
    });

    function makeAsset(name: string): ReleaseAsset {
        return {
            name,
            browser_download_url: `https://example.invalid/${name}`,
        };
    }

    function resolveFetchUrl(input: RequestInfo | URL): string {
        if (typeof input === "string") return input;
        if (input instanceof URL) return input.toString();
        return input.url;
    }

    function stubFetch(handler: (url: string) => Response): void {
        globalThis.fetch = async function (
            input: RequestInfo | URL
        ): Promise<Response> {
            return handler(resolveFetchUrl(input));
        } as typeof globalThis.fetch;
    }

    it("returns ok with null hash when SHA256SUMS is not published (legacy)", async () => {
        const result = await verifyAssetAgainstSums(tmpFile, ASSET_NAME, [
            makeAsset(ASSET_NAME),
        ]);
        expect(result).toEqual({ ok: true, hash: null });
    });

    it("returns ok with lowercase hex when SHA256SUMS contains the entry", async () => {
        const sumsBody = `${ASSET_SHA}  ${ASSET_NAME}\n`;
        stubFetch(function () {
            return new Response(sumsBody, { status: 200 });
        });
        const result = await verifyAssetAgainstSums(tmpFile, ASSET_NAME, [
            makeAsset(ASSET_NAME),
            makeAsset("SHA256SUMS"),
        ]);
        expect(result).toEqual({ ok: true, hash: ASSET_SHA });
    });

    it("returns sums-error with retryable flag when SHA256SUMS fetch fails 5xx", async () => {
        stubFetch(function () {
            return new Response("bad gateway", {
                status: 502,
                statusText: "Bad Gateway",
            });
        });
        const result = await verifyAssetAgainstSums(tmpFile, ASSET_NAME, [
            makeAsset(ASSET_NAME),
            makeAsset("SHA256SUMS"),
        ]);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.kind).toBe("sums-error");
        if (result.kind !== "sums-error") return;
        expect(result.retryable).toBe(true);
        expect(result.reason).toContain("502");
    });

    it("returns sums-error marked non-retryable on 4xx (permanent)", async () => {
        stubFetch(function () {
            return new Response("not found", {
                status: 404,
                statusText: "Not Found",
            });
        });
        const result = await verifyAssetAgainstSums(tmpFile, ASSET_NAME, [
            makeAsset(ASSET_NAME),
            makeAsset("SHA256SUMS"),
        ]);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.kind).toBe("sums-error");
        if (result.kind !== "sums-error") return;
        expect(result.retryable).toBe(false);
    });

    it("returns missing-entry when SHA256SUMS exists but has no row for asset", async () => {
        const sumsBody = `${ASSET_SHA}  some-other-asset\n`;
        stubFetch(function () {
            return new Response(sumsBody, { status: 200 });
        });
        const result = await verifyAssetAgainstSums(tmpFile, ASSET_NAME, [
            makeAsset(ASSET_NAME),
            makeAsset("SHA256SUMS"),
        ]);
        expect(result).toEqual({ ok: false, kind: "missing-entry" });
    });

    it("returns hash-mismatch when entry exists but content differs", async () => {
        const wrongHash = "0".repeat(64);
        const sumsBody = `${wrongHash}  ${ASSET_NAME}\n`;
        stubFetch(function () {
            return new Response(sumsBody, { status: 200 });
        });
        const result = await verifyAssetAgainstSums(tmpFile, ASSET_NAME, [
            makeAsset(ASSET_NAME),
            makeAsset("SHA256SUMS"),
        ]);
        expect(result).toEqual({ ok: false, kind: "hash-mismatch" });
    });

    it("returns hash-io-error when the binary file is unreadable", async () => {
        const sumsBody = `${ASSET_SHA}  ${ASSET_NAME}\n`;
        stubFetch(function () {
            return new Response(sumsBody, { status: 200 });
        });
        const result = await verifyAssetAgainstSums(
            "/nonexistent/path/file.bin",
            ASSET_NAME,
            [makeAsset(ASSET_NAME), makeAsset("SHA256SUMS")]
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.kind).toBe("hash-io-error");
    });
});
