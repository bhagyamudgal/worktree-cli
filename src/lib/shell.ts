type RunResult = {
    stdout: string;
    stderr: string;
    exitCode: number;
};

type RunOptions = {
    cwd?: string;
    inherit?: boolean;
};

async function run(
    cmd: string,
    args: string[],
    options?: RunOptions
): Promise<RunResult> {
    const isInherit = options?.inherit === true;

    const proc = Bun.spawn([cmd, ...args], {
        cwd: options?.cwd,
        stdout: isInherit ? "inherit" : "pipe",
        stderr: isInherit ? "inherit" : "pipe",
    });

    let stdout = "";
    let stderr = "";

    if (!isInherit) {
        [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
    }

    const exitCode = await proc.exited;

    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

export { run };
export type { RunResult, RunOptions };
