import fs from "node:fs";
import { once } from "node:events";
import { timingSafeEqual } from "node:crypto";
import { isEnoent } from "./fs-utils";
import { tryCatch, tryCatchSync } from "./try-catch";
import pkg from "../../package.json";

const REPO = "bhagyamudgal/worktree-cli";
const API_RELEASES_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

// Host-pin fetches to GitHub origins; defense-in-depth against CDN/release-asset compromise.
const ALLOWED_RELEASE_HOSTS = new Set([
    "api.github.com",
    "github.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
]);

function isAllowedReleaseHost(urlString: string): boolean {
    const { data: parsed } = tryCatchSync(function () {
        return new URL(urlString);
    });
    if (!parsed) return false;
    return ALLOWED_RELEASE_HOSTS.has(parsed.host);
}

const RELEASE_TAG_PATTERN = /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

// Identify as worktree-cli; GITHUB_TOKEN bumps rate limit from 60/hr to 5000/hr.
function buildGitHubHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        "User-Agent": `worktree-cli/${pkg.version}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    };
    const token = process.env.GITHUB_TOKEN;
    if (token && token.length > 0) {
        headers.Authorization = `Bearer ${token}`;
    }
    return headers;
}

const DEFAULT_META_TIMEOUT_MS = 30_000;
const DEFAULT_ASSET_TIMEOUT_MS = 600_000;
// 4× headroom over current ~50 MB binary; rejects oversized CDN responses pre-verification.
const MAX_ASSET_BYTES = 200 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 5;

type ReleaseAsset = {
    name: string;
    browser_download_url: string;
};

type ReleaseInfo = {
    tag: string;
    version: string;
    assets: ReleaseAsset[];
};

function isStandalone(): boolean {
    return (
        Bun.main.startsWith("/$bunfs/") || import.meta.url.includes("$bunfs/")
    );
}

function getAssetName(): string | null {
    const platform = process.platform;
    const arch = process.arch;
    if (platform !== "darwin" && platform !== "linux") return null;
    if (arch !== "arm64" && arch !== "x64") return null;
    return `worktree-${platform}-${arch}`;
}

function parseNumericSegment(raw: string | undefined): number {
    if (raw === undefined) return 0;
    const leadingInt = /^(\d+)/.exec(raw);
    if (!leadingInt) return 0;
    const n = Number(leadingInt[1]);
    return Number.isFinite(n) ? n : 0;
}

type ParsedVersion = {
    major: number;
    minor: number;
    patch: number;
    prerelease: string | null;
};

function parseVersion(v: string): ParsedVersion {
    const stripped = v.replace(/^v/, "");
    const dashIndex = stripped.indexOf("-");
    const core = dashIndex === -1 ? stripped : stripped.slice(0, dashIndex);
    const prerelease =
        dashIndex === -1 ? null : stripped.slice(dashIndex + 1) || null;
    const [maj, min, patch] = core.split(".");
    return {
        major: parseNumericSegment(maj),
        minor: parseNumericSegment(min),
        patch: parseNumericSegment(patch),
        prerelease,
    };
}

// SemVer 2.0 §11: dot-separated identifiers compared pairwise.
// Numeric identifiers compare numerically; string identifiers compare lexically;
// numeric identifiers always have lower precedence than strings; longer field
// wins iff all preceding identifiers are equal.
function comparePrereleaseIdentifier(a: string, b: string): number {
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
        const an = Number(a);
        const bn = Number(b);
        if (an < bn) return -1;
        if (an > bn) return 1;
        return 0;
    }
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

function comparePrerelease(a: string | null, b: string | null): number {
    if (a === b) return 0;
    // A version with a prerelease has lower precedence than one without.
    if (a === null) return 1;
    if (b === null) return -1;
    const aParts = a.split(".");
    const bParts = b.split(".");
    const len = Math.min(aParts.length, bParts.length);
    for (let i = 0; i < len; i++) {
        const cmp = comparePrereleaseIdentifier(aParts[i], bParts[i]);
        if (cmp !== 0) return cmp;
    }
    if (aParts.length < bParts.length) return -1;
    if (aParts.length > bParts.length) return 1;
    return 0;
}

function compareVersions(a: string, b: string): number {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (pa.major !== pb.major) return pa.major - pb.major;
    if (pa.minor !== pb.minor) return pa.minor - pb.minor;
    if (pa.patch !== pb.patch) return pa.patch - pb.patch;
    return comparePrerelease(pa.prerelease, pb.prerelease);
}

function isReleaseInfo(value: unknown): value is {
    tag_name: string;
    assets: ReleaseAsset[];
} {
    if (!value || typeof value !== "object") return false;
    const rec = value as Record<string, unknown>;
    if (typeof rec.tag_name !== "string") return false;
    if (!Array.isArray(rec.assets)) return false;
    return rec.assets.every(function (entry: unknown) {
        if (!entry || typeof entry !== "object") return false;
        const asset = entry as Record<string, unknown>;
        return (
            typeof asset.name === "string" &&
            typeof asset.browser_download_url === "string"
        );
    });
}

async function withTimeout<T>(
    url: string,
    timeoutMs: number,
    handler: (response: Response) => Promise<T>
): Promise<T> {
    if (!isAllowedReleaseHost(url)) {
        throw new Error(
            `Refused to fetch URL with disallowed host: ${JSON.stringify(url.slice(0, 120))}`
        );
    }
    const controller = new AbortController();
    const timer = setTimeout(function () {
        controller.abort();
    }, timeoutMs);
    try {
        // Follow redirects manually so each hop's host is validated BEFORE we connect to it —
        // default `redirect: "follow"` connects to intermediate hosts and only exposes the final URL.
        const originHost = new URL(url).host;
        let currentUrl = url;
        // Once Authorization has been stripped on any cross-origin hop, never re-add —
        // prevents a redirect chain that bounces back to the origin host from re-attaching the token.
        let authStripped = false;
        for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
            const headers = buildGitHubHeaders();
            if (authStripped || new URL(currentUrl).host !== originHost) {
                delete headers.Authorization;
                authStripped = true;
            }
            const response = await fetch(currentUrl, {
                signal: controller.signal,
                headers,
                redirect: "manual",
            });
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get("location");
                // Drain the redirect body so keep-alive sockets don't pin across hops.
                // Body-cancel failures here are non-fatal; controller.abort() in the
                // outer timer will close the socket anyway. Caller-supplied onError
                // (when available — only downloadAsset threads one) gets the diagnostic.
                await tryCatch(response.body?.cancel() ?? Promise.resolve());
                if (!location) {
                    throw new Error(
                        `Redirect ${response.status} without Location header from ${new URL(currentUrl).host}`
                    );
                }
                const next = new URL(location, currentUrl).toString();
                if (!isAllowedReleaseHost(next)) {
                    // Log host only, not the full URL — signed CDN URLs can carry tokens in the query string.
                    throw new Error(
                        `Refused redirect to disallowed host: ${new URL(next).host}`
                    );
                }
                currentUrl = next;
                continue;
            }
            return await handler(response);
        }
        throw new Error(
            `Exceeded ${MAX_REDIRECT_HOPS} redirects from ${new URL(url).host}`
        );
    } finally {
        clearTimeout(timer);
    }
}

async function fetchLatestRelease(
    timeoutMs: number = DEFAULT_META_TIMEOUT_MS
): Promise<ReleaseInfo> {
    const { data: result, error } = await tryCatch(
        withTimeout(API_RELEASES_LATEST, timeoutMs, async function (response) {
            if (!response.ok) {
                throw new Error(
                    `GitHub API error: ${response.status} ${response.statusText}`
                );
            }
            const json = await response.json();
            if (!isReleaseInfo(json)) {
                throw new Error("Release payload missing tag_name or assets");
            }
            // Reject malformed tags at the boundary so they can't propagate into paths/logs.
            if (!RELEASE_TAG_PATTERN.test(json.tag_name)) {
                throw new Error(
                    `Release tag malformed: ${JSON.stringify(json.tag_name.slice(0, 40))}`
                );
            }
            return {
                tag: json.tag_name,
                version: json.tag_name.replace(/^v/, ""),
                assets: json.assets,
            };
        })
    );
    if (error || !result) {
        throw new Error(
            `Failed to reach GitHub releases API: ${error?.message ?? "unknown"}`,
            { cause: error ?? undefined }
        );
    }
    return result;
}

type DownloadOnError = (
    op: "body-cancel" | "release-lock" | "cleanup-unlink",
    error: Error
) => void;

async function downloadAsset(
    asset: ReleaseAsset,
    destPath: string,
    timeoutMs: number = DEFAULT_ASSET_TIMEOUT_MS,
    onError?: DownloadOnError
): Promise<void> {
    const { error } = await tryCatch(
        withTimeout(
            asset.browser_download_url,
            timeoutMs,
            async function (response) {
                if (!response.ok) {
                    throw new Error(
                        `Download ${asset.name} failed: ${response.status} ${response.statusText}`
                    );
                }
                const contentLength = response.headers.get("content-length");
                if (contentLength !== null) {
                    const declared = Number(contentLength);
                    if (
                        Number.isFinite(declared) &&
                        declared > MAX_ASSET_BYTES
                    ) {
                        throw new Error(
                            `Download ${asset.name} refused: declared size ${declared} bytes exceeds cap ${MAX_ASSET_BYTES} bytes`
                        );
                    }
                }
                if (!response.body) {
                    throw new Error(
                        `Download ${asset.name} refused: empty response body`
                    );
                }
                // Stream chunks directly to disk, enforcing the cap as bytes arrive.
                // Avoids the ~2× memory peak of buffering all chunks then copying into one final Uint8Array.
                const reader = response.body.getReader();
                const writer = fs.createWriteStream(destPath, { flags: "w" });
                let bytesReceived = 0;
                let writerClosed = false;
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (!value) continue;
                        bytesReceived += value.byteLength;
                        if (bytesReceived > MAX_ASSET_BYTES) {
                            throw new Error(
                                `Download ${asset.name} exceeded cap: ${bytesReceived} bytes > ${MAX_ASSET_BYTES} bytes`
                            );
                        }
                        if (!writer.write(value)) {
                            await once(writer, "drain");
                        }
                    }
                    if (bytesReceived === 0) {
                        // Explicit empty-body error; else SHA verify later reports a misleading mismatch.
                        throw new Error(
                            `Download ${asset.name} refused: empty response body`
                        );
                    }
                    await new Promise<void>(function (resolve, reject) {
                        writer.end(function (
                            err: NodeJS.ErrnoException | null | undefined
                        ) {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                    writerClosed = true;
                } finally {
                    const { error: releaseError } = tryCatchSync(function () {
                        reader.releaseLock();
                    });
                    if (releaseError) {
                        onError?.("release-lock", releaseError);
                    }
                    if (!writerClosed) {
                        writer.destroy();
                    }
                }
            }
        )
    );
    if (error) {
        // Clean up our own partial write so callers don't have to do it defensively.
        const { error: cleanupError } = tryCatchSync(function () {
            fs.unlinkSync(destPath);
        });
        if (cleanupError && !isEnoent(cleanupError)) {
            onError?.("cleanup-unlink", cleanupError);
        }
        throw new Error(`Failed to download ${asset.name}: ${error.message}`, {
            cause: error,
        });
    }
}

type HashResult =
    | { ok: true }
    | { ok: false; kind: "mismatch" }
    | { ok: false; kind: "io-error"; cause: Error };

const HASH_CHUNK_BYTES = 64 * 1024;

async function computeSha256Async(filePath: string): Promise<string> {
    const hasher = new Bun.CryptoHasher("sha256");
    const file = Bun.file(filePath);
    for await (const chunk of file.stream()) {
        hasher.update(chunk);
    }
    return hasher.digest("hex").toLowerCase();
}

function computeSha256Sync(filePath: string): string {
    const hasher = new Bun.CryptoHasher("sha256");
    const fd = fs.openSync(filePath, "r");
    try {
        const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
        while (true) {
            const bytesRead = fs.readSync(
                fd,
                buffer,
                0,
                HASH_CHUNK_BYTES,
                null
            );
            if (bytesRead === 0) break;
            hasher.update(buffer.subarray(0, bytesRead));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hasher.digest("hex").toLowerCase();
}

async function verifyBinaryHash(
    filePath: string,
    expectedSha256: string
): Promise<HashResult> {
    const { data: actual, error } = await tryCatch(
        computeSha256Async(filePath)
    );
    if (error) return { ok: false, kind: "io-error", cause: error };
    if (constantTimeEquals(actual, expectedSha256.toLowerCase())) {
        return { ok: true };
    }
    return { ok: false, kind: "mismatch" };
}

function verifyBinaryHashSync(
    filePath: string,
    expectedSha256: string
): HashResult {
    const { data: actual, error } = tryCatchSync(function () {
        return computeSha256Sync(filePath);
    });
    if (error) return { ok: false, kind: "io-error", cause: error };
    if (constantTimeEquals(actual, expectedSha256.toLowerCase())) {
        return { ok: true };
    }
    return { ok: false, kind: "mismatch" };
}

function constantTimeEquals(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    // Constant-time compare prevents timing side-channel on hash compare.
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

type Sha256SumsResult =
    | { kind: "not-published" }
    | { kind: "ok"; sums: Record<string, string> }
    | { kind: "error"; reason: string; retryable: boolean }
    // "tamper" = SHA256SUMS body parsed but contains evidence of tampering
    // (today: duplicate entries). Distinct from generic "error" so callers can
    // escalate (foreground: loud red error; background: TAMPER: log prefix).
    | { kind: "tamper"; reason: string };

// 5xx and 403/429 (rate-limit) retryable; other 4xx treated as permanent.
function isRetryableHttpStatus(status: number): boolean {
    if (status === 403 || status === 429) return true;
    return status >= 500 && status < 600;
}

async function fetchSha256Sums(
    assets: ReleaseAsset[],
    timeoutMs: number = DEFAULT_META_TIMEOUT_MS
): Promise<Sha256SumsResult> {
    const sumsAsset = assets.find(function (entry) {
        return entry.name === "SHA256SUMS";
    });
    if (!sumsAsset) return { kind: "not-published" };
    const { data: result, error } = await tryCatch(
        withTimeout(
            sumsAsset.browser_download_url,
            timeoutMs,
            async function (response): Promise<Sha256SumsResult> {
                if (!response.ok) {
                    return {
                        kind: "error",
                        reason: `${response.status} ${response.statusText}`,
                        retryable: isRetryableHttpStatus(response.status),
                    };
                }
                const text = await response.text();
                if (!text) {
                    return {
                        kind: "error",
                        reason: "empty SHA256SUMS body",
                        retryable: true,
                    };
                }
                // Duplicate entries are tampering, not transient — permanent failure.
                const { data: parsed, error: parseError } = tryCatchSync(
                    function () {
                        return parseSha256Sums(text);
                    }
                );
                if (parseError) {
                    // parseSha256Sums throws ONLY on duplicate entries today —
                    // which is the canonical signature of supply-chain tampering,
                    // not a transient outage. Discriminate so foreground/background
                    // can escalate appropriately.
                    return {
                        kind: "tamper",
                        reason: parseError.message,
                    };
                }
                return { kind: "ok", sums: parsed };
            }
        )
    );
    if (error || !result) {
        return {
            kind: "error",
            reason: error?.message ?? "network error",
            retryable: true,
        };
    }
    return result;
}

type VerifyAssetResult =
    | { ok: true; hash: string | null } // hash === null when SHA256SUMS isn't published
    | { ok: false; kind: "sums-error"; reason: string; retryable: boolean }
    | { ok: false; kind: "sums-tamper"; reason: string }
    | { ok: false; kind: "missing-entry" }
    | { ok: false; kind: "hash-io-error"; cause: Error }
    | { ok: false; kind: "hash-mismatch" };

async function verifyAssetAgainstSums(
    tmpPath: string,
    assetName: string,
    assets: ReleaseAsset[]
): Promise<VerifyAssetResult> {
    const sums = await fetchSha256Sums(assets);
    if (sums.kind === "tamper") {
        return { ok: false, kind: "sums-tamper", reason: sums.reason };
    }
    if (sums.kind === "error") {
        return {
            ok: false,
            kind: "sums-error",
            reason: sums.reason,
            retryable: sums.retryable,
        };
    }
    if (sums.kind === "not-published") {
        return { ok: true, hash: null };
    }
    const expected = sums.sums[assetName];
    if (!expected) {
        return { ok: false, kind: "missing-entry" };
    }
    const hashResult = await verifyBinaryHash(tmpPath, expected);
    if (!hashResult.ok) {
        if (hashResult.kind === "io-error") {
            return {
                ok: false,
                kind: "hash-io-error",
                cause: hashResult.cause,
            };
        }
        return { ok: false, kind: "hash-mismatch" };
    }
    return { ok: true, hash: expected };
}

function parseSha256Sums(text: string): Record<string, string> {
    // Null-prototype object blocks __proto__/constructor pollution from a tampered file.
    const result: Record<string, string> = Object.create(null);
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
        if (!match) continue;
        const [, hash, filename] = match;
        const name = filename.trim();
        if (Object.prototype.hasOwnProperty.call(result, name)) {
            throw new Error(`Duplicate SHA256SUMS entry for ${name}`);
        }
        result[name] = hash.toLowerCase();
    }
    return result;
}

export {
    compareVersions,
    computeSha256Sync,
    downloadAsset,
    fetchLatestRelease,
    fetchSha256Sums,
    getAssetName,
    isStandalone,
    parseSha256Sums,
    verifyAssetAgainstSums,
    verifyBinaryHash,
    verifyBinaryHashSync,
};
export type {
    HashResult,
    ReleaseAsset,
    ReleaseInfo,
    Sha256SumsResult,
    VerifyAssetResult,
};
