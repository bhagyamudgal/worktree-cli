import path from "node:path";
import { run } from "./shell";
import { printInfo, printSuccess, printWarn } from "./logger";

const LOCKFILE_MAP = [
    { file: "pnpm-lock.yaml", pm: "pnpm" },
    { file: "yarn.lock", pm: "yarn" },
    { file: "package-lock.json", pm: "npm" },
    { file: "bun.lockb", pm: "bun" },
    { file: "bun.lock", pm: "bun" },
] as const;

type PackageManager = "pnpm" | "yarn" | "npm" | "bun";

async function detectPackageManager(
    root: string
): Promise<PackageManager | null> {
    for (const { file, pm } of LOCKFILE_MAP) {
        const exists = await Bun.file(path.join(root, file)).exists();
        if (exists) return pm;
    }
    return null;
}

async function installDependencies(
    pm: PackageManager,
    cwd: string
): Promise<void> {
    printInfo(`  Detected ${pm}, running ${pm} install...`);
    const result = await run(pm, ["install"], { cwd, inherit: true });
    if (result.exitCode !== 0) {
        printWarn(
            "  Dependency install failed. You may need to install manually."
        );
        return;
    }
    printSuccess("  Dependencies installed.");
}

export { detectPackageManager, installDependencies };
export type { PackageManager };
