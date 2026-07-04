import path from "node:path";
import { run } from "./shell";
import { printInfo, printSuccess, printWarn } from "./logger";
import { tryCatch } from "./try-catch";

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

async function hasPrepareScript(cwd: string): Promise<boolean> {
    const { data } = await tryCatch(
        Bun.file(path.join(cwd, "package.json")).json()
    );
    return typeof data?.scripts?.prepare === "string";
}

async function runPrepareScript(
    pm: PackageManager,
    cwd: string
): Promise<void> {
    if (!(await hasPrepareScript(cwd))) return;
    printInfo(`  Running ${pm} run prepare...`);
    const result = await run(pm, ["run", "prepare"], { cwd, inherit: true });
    if (result.exitCode !== 0) {
        printWarn("  prepare script failed. Git hooks may be inactive.");
        return;
    }
    printSuccess("  Prepare script complete.");
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
    await runPrepareScript(pm, cwd);
}

export { detectPackageManager, installDependencies };
export type { PackageManager };
