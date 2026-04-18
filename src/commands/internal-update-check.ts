import { command } from "@drizzle-team/brocli";
import {
    appendBackgroundCheckPanic,
    INTERNAL_CHECK_SUBCOMMAND,
    runBackgroundUpdateCheck,
} from "../lib/auto-update";

export const internalUpdateCheckCommand = command({
    name: INTERNAL_CHECK_SUBCOMMAND,
    desc: "",
    hidden: true,
    handler: async () => {
        // Silent detached child has no error surface by design
        // (stdio/stderr redirected in scheduleBackgroundUpdateCheck). Wrap
        // the whole run so any unhandled throw from runBackgroundUpdateCheck
        // appends a full stack trace to last-error before exiting non-zero.
        // Without this, a programmer bug here is invisible in production.
        try {
            await runBackgroundUpdateCheck();
        } catch (error) {
            appendBackgroundCheckPanic(error);
            process.exit(1);
        }
    },
});
