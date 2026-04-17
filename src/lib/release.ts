import { tryCatch } from "./try-catch";

const REPO = "bhagyamudgal/worktree-cli";
const API_RELEASES_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

const DEFAULT_META_TIMEOUT_MS = 30_000;
const DEFAULT_ASSET_TIMEOUT_MS = 600_000;

type ReleaseAsset = {
    name: string;
    browser_download_url: string;
};

type ReleaseInfo = {
    tag: string;
    version: string;
    assets: ReleaseAsset[];
};

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

function compareVersions(a: string, b: string): number {
    const parse = function (v: string): [number, number, number] {
        const [maj, min, patch] = v.replace(/^v/, "").split(".");
        return [
            parseNumericSegment(maj),
            parseNumericSegment(min),
            parseNumericSegment(patch),
        ];
    };
    const [aMaj, aMin, aPatch] = parse(a);
    const [bMaj, bMin, bPatch] = parse(b);
    if (aMaj !== bMaj) return aMaj - bMaj;
    if (aMin !== bMin) return aMin - bMin;
    return aPatch - bPatch;
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

async function fetchWithTimeout(
    url: string,
    timeoutMs: number
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(function () {
        controller.abort();
    }, timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function fetchLatestRelease(
    timeoutMs: number = DEFAULT_META_TIMEOUT_MS
): Promise<ReleaseInfo> {
    const { data: response, error } = await tryCatch(
        fetchWithTimeout(API_RELEASES_LATEST, timeoutMs)
    );
    if (error || !response) {
        throw new Error(
            `Failed to reach GitHub releases API: ${error?.message ?? "unknown"}`
        );
    }
    if (!response.ok) {
        throw new Error(
            `GitHub API error: ${response.status} ${response.statusText}`
        );
    }
    const { data: json, error: jsonError } = await tryCatch(response.json());
    if (jsonError)
        throw new Error(`Invalid release JSON: ${jsonError.message}`);
    if (!isReleaseInfo(json))
        throw new Error("Release payload missing tag_name or assets");
    return {
        tag: json.tag_name,
        version: json.tag_name.replace(/^v/, ""),
        assets: json.assets,
    };
}

async function downloadAsset(
    asset: ReleaseAsset,
    destPath: string,
    timeoutMs: number = DEFAULT_ASSET_TIMEOUT_MS
): Promise<void> {
    const { data: response, error } = await tryCatch(
        fetchWithTimeout(asset.browser_download_url, timeoutMs)
    );
    if (error || !response) {
        throw new Error(
            `Failed to download ${asset.name}: ${error?.message ?? "unknown"}`
        );
    }
    if (!response.ok) {
        throw new Error(
            `Download ${asset.name} failed: ${response.status} ${response.statusText}`
        );
    }
    const { data: buffer, error: bufError } = await tryCatch(
        response.arrayBuffer()
    );
    if (bufError || !buffer) {
        throw new Error(`Failed to read ${asset.name} body`);
    }
    await Bun.write(destPath, buffer);
}

async function verifyBinaryHash(
    filePath: string,
    expectedSha256: string
): Promise<boolean> {
    const hasher = new Bun.CryptoHasher("sha256");
    const file = Bun.file(filePath);
    const { data: buffer, error } = await tryCatch(file.arrayBuffer());
    if (error || !buffer) return false;
    hasher.update(buffer);
    const actual = hasher.digest("hex");
    return constantTimeEquals(
        actual.toLowerCase(),
        expectedSha256.toLowerCase()
    );
}

function constantTimeEquals(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

type Sha256SumsResult =
    | { kind: "not-published" }
    | { kind: "ok"; sums: Record<string, string> }
    | { kind: "error"; reason: string };

async function fetchSha256Sums(
    assets: ReleaseAsset[],
    timeoutMs: number = DEFAULT_META_TIMEOUT_MS
): Promise<Sha256SumsResult> {
    const sumsAsset = assets.find(function (entry) {
        return entry.name === "SHA256SUMS";
    });
    if (!sumsAsset) return { kind: "not-published" };
    const { data: response, error } = await tryCatch(
        fetchWithTimeout(sumsAsset.browser_download_url, timeoutMs)
    );
    if (error || !response) {
        return { kind: "error", reason: error?.message ?? "network error" };
    }
    if (!response.ok) {
        return {
            kind: "error",
            reason: `${response.status} ${response.statusText}`,
        };
    }
    const { data: text, error: textError } = await tryCatch(response.text());
    if (textError || !text) {
        return { kind: "error", reason: "empty SHA256SUMS body" };
    }
    return { kind: "ok", sums: parseSha256Sums(text) };
}

function parseSha256Sums(text: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
        if (!match) continue;
        const [, hash, filename] = match;
        result[filename.trim()] = hash.toLowerCase();
    }
    return result;
}

export {
    getAssetName,
    compareVersions,
    fetchLatestRelease,
    downloadAsset,
    verifyBinaryHash,
    fetchSha256Sums,
    parseSha256Sums,
};
export type { ReleaseAsset, ReleaseInfo, Sha256SumsResult };
