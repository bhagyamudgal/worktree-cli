import { z } from "zod";
import { DEFAULT_WORKTREE_DIR } from "./constants";
import { tryCatch } from "./try-catch";
import path from "node:path";

const configSchema = z.object({
    DEFAULT_BASE: z.string().optional(),
    WORKTREE_DIR: z.string().default(DEFAULT_WORKTREE_DIR),
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

async function loadConfig(root: string): Promise<Config> {
    const configPath = path.join(root, ".worktreerc");
    const file = Bun.file(configPath);
    const isExists = await file.exists();

    if (!isExists) {
        return validateConfig({});
    }

    const { data: content, error } = await tryCatch(file.text());

    if (error) {
        return validateConfig({});
    }

    const raw = parseConfigContent(content);
    return validateConfig(raw);
}

export { loadConfig, parseConfigContent, validateConfig };
export type { Config };
