import fs from "node:fs";
import fsPromises from "node:fs/promises";

async function safeUnlink(filePath: string): Promise<void> {
    await fsPromises.unlink(filePath).catch(function () {});
}

function safeUnlinkSync(filePath: string): void {
    try {
        fs.unlinkSync(filePath);
    } catch {
        // best-effort
    }
}

export { safeUnlink, safeUnlinkSync };
