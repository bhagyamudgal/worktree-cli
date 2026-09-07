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
        try {
            await runBackgroundUpdateCheck();
        } catch (error) {
            appendBackgroundCheckPanic(error);
            process.exit(1);
        }
    },
});
