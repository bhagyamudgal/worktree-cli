import { z } from "zod";
import os from "node:os";
import path from "node:path";
import { DEFAULT_WORKTREE_DIR } from "./constants";
import { tryCatch, tryCatchSync } from "./try-catch";

const booleanLike = z
    .union([z.boolean(), z.string()])
    .transform(function (value) {
        if (typeof value === "boolean") return value;
        const normalized = value.trim().toLowerCase();
        if (
            normalized === "true" ||
            normalized === "1" ||
            normalized === "yes"
        ) {
            return true;
        }
        if (
            normalized === "false" ||
            normalized === "0" ||
            normalized === "no"
        ) {
            return false;
        }
        throw new Error(`Expected boolean-like value, got "${value}"`);
    });

const configSchema = z.object({
    DEFAULT_BASE: z.string().optional(),
    WORKTREE_DIR: z.string().default(DEFAULT_WORKTREE_DIR),
    AUTO_UPDATE: booleanLike.default(true),
});

type Config = z.infer<typeof configSchema>;

function parseConfigContent(content: string): Record<string, string> {
    const raw: Record<string, string> = {};
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;

        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;

        const key = trimmed.slice(0, eqIndex).trim();
        if (key === "") continue;
        let value = trimmed.slice(eqIndex + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        raw[key] = value;
    }
    return raw;
}

function validateConfig(raw: Record<string, string>): Config {
    return configSchema.parse(raw);
}

const warnedPaths = new Set<string>();

function displayPath(filePath: string): string {
    const home = os.homedir();
    if (filePath === home) return "~";
    if (filePath.startsWith(home + path.sep)) {
        return "~" + filePath.slice(home.length);
    }
    return filePath;
}

function warnOnce(filePath: string, message: string): void {
    if (warnedPaths.has(filePath)) return;
    warnedPaths.add(filePath);
    console.error(message);
}

type ConfigScope = "project" | "global";

async function readConfigFile(
    filePath: string,
    scope: ConfigScope
): Promise<Config> {
    const file = Bun.file(filePath);
    const isExists = await file.exists();
    if (!isExists) return validateConfig({});
    const display = displayPath(filePath);
    const { data: content, error: readError } = await tryCatch(file.text());
    if (readError) {
        warnOnce(
            filePath,
            `warning: could not read ${display}: ${readError.message}. Using defaults.`
        );
        return validateConfig({});
    }
    const raw = parseConfigContent(content);
    if (scope === "project" && "AUTO_UPDATE" in raw) {
        warnOnce(
            `${filePath}:AUTO_UPDATE`,
            `warning: AUTO_UPDATE in project ${display} is ignored — set it in ~/.worktreerc instead.`
        );
        // Strip pre-validate so `AUTO_UPDATE=junk` doesn't discard valid sibling keys.
        delete raw.AUTO_UPDATE;
    }
    const { data: parsed, error: parseError } = tryCatchSync(function () {
        return validateConfig(raw);
    });
    if (parseError) {
        warnOnce(
            filePath,
            `warning: ${display} is invalid: ${parseError.message}. Using defaults.`
        );
        return validateConfig({});
    }
    return parsed;
}

async function loadConfig(root: string): Promise<Config> {
    return readConfigFile(path.join(root, ".worktreerc"), "project");
}

// Fail CLOSED on parse/read errors so a typo can't silently override opt-out.
// `onError` threads diagnostics so users discover *why* auto-update is disabled.
async function shouldAutoUpdate(
    onError?: (message: string) => void
): Promise<boolean> {
    const filePath = path.join(os.homedir(), ".worktreerc");
    const file = Bun.file(filePath);
    // `file.exists()` can throw EACCES; guard to avoid crashing the scheduler.
    const { data: isExists, error: existsError } = await tryCatch(
        file.exists()
    );
    if (existsError) {
        onError?.(`shouldAutoUpdate exists: ${existsError.message}`);
        return false;
    }
    if (!isExists) return true;
    const { data: content, error: readError } = await tryCatch(file.text());
    if (readError) {
        onError?.(
            `~/.worktreerc read failed; auto-update disabled until fixed: ${readError.message}`
        );
        return false;
    }
    const raw = parseConfigContent(content);
    const { data: parsed, error: parseError } = tryCatchSync(function () {
        return validateConfig(raw);
    });
    if (parseError) {
        onError?.(
            `~/.worktreerc invalid; auto-update disabled until fixed: ${parseError.message}`
        );
        return false;
    }
    return parsed.AUTO_UPDATE;
}

export { loadConfig, parseConfigContent, shouldAutoUpdate, validateConfig };
export type { Config };
