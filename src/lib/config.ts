import { z } from "zod";
import os from "node:os";
import path from "node:path";
import { DEFAULT_WORKTREE_DIR } from "./constants";
import { tryCatch } from "./try-catch";

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

async function readConfigFile(filePath: string): Promise<Config> {
    const file = Bun.file(filePath);
    const isExists = await file.exists();
    if (!isExists) return validateConfig({});
    const display = displayPath(filePath);
    const { data: content, error } = await tryCatch(file.text());
    if (error) {
        warnOnce(
            filePath,
            `warning: could not read ${display}: ${error.message}. Using defaults.`
        );
        return validateConfig({});
    }
    const { data: parsed, error: parseError } = await tryCatch(
        Promise.resolve().then(function () {
            return validateConfig(parseConfigContent(content));
        })
    );
    if (parseError) {
        warnOnce(
            filePath,
            `warning: ${display} is invalid: ${parseError.message}.`
        );
        throw parseError;
    }
    return parsed;
}

async function loadConfig(root: string): Promise<Config> {
    const { data, error } = await tryCatch(
        readConfigFile(path.join(root, ".worktreerc"))
    );
    if (error || !data) return validateConfig({});
    return data;
}

async function loadGlobalConfig(): Promise<Config> {
    return readConfigFile(path.join(os.homedir(), ".worktreerc"));
}

export { loadConfig, loadGlobalConfig, parseConfigContent, validateConfig };
export type { Config };
