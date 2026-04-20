import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    compareVersions,
    fetchLatestRelease,
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

    it("orders prerelease tags per SemVer 2.0 §11", () => {
        // Numeric within-identifier comparison.
        expect(compareVersions("1.2.3-beta.1", "1.2.3-beta.2")).toBeLessThan(0);
        // Lex on string identifiers.
        expect(compareVersions("1.2.3-rc.1", "1.2.3-beta.1")).toBeGreaterThan(
            0
        );
        // Equal prereleases.
        expect(compareVersions("1.2.3-alpha", "1.2.3-alpha")).toBe(0);
    });

    it("compares numeric prerelease identifiers numerically (SemVer 2.0)", () => {
        // SemVer 2.0 §11.4.1: numeric identifiers compare numerically — rc.10 > rc.2.
        expect(compareVersions("1.2.3-rc.10", "1.2.3-rc.2")).toBeGreaterThan(0);
        expect(compareVersions("1.2.3-rc.2", "1.2.3-rc.10")).toBeLessThan(0);
        expect(compareVersions("1.2.3-alpha.9", "1.2.3-alpha.11")).toBeLessThan(
            0
        );
    });

    it("treats numeric identifiers as lower precedence than string identifiers", () => {
        // SemVer 2.0 §11.4.3: numeric identifiers always have lower precedence than
        // alphanumeric identifiers within the same prerelease position.
        expect(
            compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")
        ).toBeLessThan(0);
    });

    it("longer prerelease wins when all preceding identifiers equal", () => {
        // SemVer 2.0 §11.4.4: a larger set of fields has higher precedence than
        // a smaller set, when all preceding identifiers are equal.
        expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
        expect(
            compareVersions("1.0.0-alpha.beta", "1.0.0-alpha.beta.1")
        ).toBeLessThan(0);
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

    it("handles CRLF line endings", () => {
        const text =
            "a".repeat(64) +
            "  worktree-darwin-arm64\r\n" +
            "b".repeat(64) +
            "  worktree-linux-x64\r\n";
        const result = parseSha256Sums(text);
        expect(result["worktree-darwin-arm64"]).toBe("a".repeat(64));
        expect(result["worktree-linux-x64"]).toBe("b".repeat(64));
    });

    it("handles missing trailing newline", () => {
        const text = "a".repeat(64) + "  worktree-darwin-arm64";
        const result = parseSha256Sums(text);
        expect(result["worktree-darwin-arm64"]).toBe("a".repeat(64));
    });

    it("rejects BSD-tagged-format `SHA256 (file) = hex` (not the format we publish)", () => {
        const text = `SHA256 (worktree-darwin-arm64) = ${"a".repeat(64)}`;
        const result = parseSha256Sums(text);
        // Pins the parser to reject unknown formats — guards against accepting unverified hashes.
        expect(Object.keys(result)).toEqual([]);
    });
});

describe("fetchLatestRelease — JSON-shape boundary", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function stubFetch(handler: () => Response): void {
        globalThis.fetch = async function (
            _input: RequestInfo | URL
        ): Promise<Response> {
            return handler();
        } as typeof globalThis.fetch;
    }

    it("returns parsed release on a valid payload", async () => {
        stubFetch(function () {
            return new Response(
                JSON.stringify({
                    tag_name: "v1.2.3",
                    assets: [
                        {
                            name: "worktree-darwin-arm64",
                            browser_download_url:
                                "https://objects.githubusercontent.com/worktree-darwin-arm64",
                        },
                    ],
                }),
                { status: 200 }
            );
        });
        const result = await fetchLatestRelease();
        expect(result.tag).toBe("v1.2.3");
        expect(result.version).toBe("1.2.3");
        expect(result.assets).toHaveLength(1);
    });

    it("throws on missing tag_name", async () => {
        stubFetch(function () {
            return new Response(JSON.stringify({ assets: [] }), {
                status: 200,
            });
        });
        await expect(fetchLatestRelease()).rejects.toThrow(/tag_name|assets/);
    });

    it("throws on missing assets array", async () => {
        stubFetch(function () {
            return new Response(JSON.stringify({ tag_name: "v1.0.0" }), {
                status: 200,
            });
        });
        await expect(fetchLatestRelease()).rejects.toThrow(/tag_name|assets/);
    });

    it("throws on assets being a non-array", async () => {
        stubFetch(function () {
            return new Response(
                JSON.stringify({ tag_name: "v1.0.0", assets: "x" }),
                { status: 200 }
            );
        });
        await expect(fetchLatestRelease()).rejects.toThrow(/tag_name|assets/);
    });

    it("throws on malformed tag_name (path-traversal-shaped)", async () => {
        stubFetch(function () {
            return new Response(
                JSON.stringify({
                    tag_name: "v1.2.3/../evil",
                    assets: [],
                }),
                { status: 200 }
            );
        });
        await expect(fetchLatestRelease()).rejects.toThrow(
            /Release tag malformed/
        );
    });

    it("throws on non-2xx HTTP", async () => {
        stubFetch(function () {
            return new Response("server error", {
                status: 500,
                statusText: "Internal Server Error",
            });
        });
        await expect(fetchLatestRelease()).rejects.toThrow(/500/);
    });
});

describe("verifyAssetAgainstSums", () => {
    const ASSET_BYTES = new Uint8Array([
        0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64,
    ]);
    // Precomputed SHA256 of ASSET_BYTES.
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
            // ignore
        }
    });

    function makeAsset(name: string): ReleaseAsset {
        // Allowlisted host so the withTimeout host-pin doesn't reject pre-stub.
        return {
            name,
            browser_download_url: `https://objects.githubusercontent.com/${name}`,
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

    it("returns sums-error marked retryable on 403 (rate limit)", async () => {
        stubFetch(function () {
            return new Response("forbidden", {
                status: 403,
                statusText: "Forbidden",
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
        // 403/429 are GitHub rate-limit signals — transient, NOT permanent.
        expect(result.retryable).toBe(true);
    });

    it("returns sums-error marked retryable on 429 (rate limit)", async () => {
        stubFetch(function () {
            return new Response("too many requests", {
                status: 429,
                statusText: "Too Many Requests",
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
    });

    it("returns sums-tamper kind when SHA256SUMS contains duplicate entry (tampering)", async () => {
        const dupeBody = [
            "a".repeat(64) + "  " + ASSET_NAME,
            "b".repeat(64) + "  " + ASSET_NAME,
        ].join("\n");
        stubFetch(function () {
            return new Response(dupeBody, { status: 200 });
        });
        const result = await verifyAssetAgainstSums(tmpFile, ASSET_NAME, [
            makeAsset(ASSET_NAME),
            makeAsset("SHA256SUMS"),
        ]);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        // Distinct kind from "sums-error" so foreground/background paths can
        // escalate (loud red error / TAMPER: log prefix) instead of treating
        // tampering the same as a transient outage.
        expect(result.kind).toBe("sums-tamper");
        if (result.kind !== "sums-tamper") return;
        expect(result.reason).toMatch(/Duplicate/);
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
