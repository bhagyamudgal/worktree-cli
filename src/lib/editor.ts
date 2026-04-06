import * as p from "@clack/prompts";
import {
    SUPPORTED_EDITORS,
    EDITOR_LABELS,
    type EditorChoice,
} from "./constants";
import { printSuccess, printWarn, printError } from "./logger";
import { EXIT_CODES } from "./constants";

function isEditorAvailable(editor: string): boolean {
    return Bun.which(editor) !== null;
}

async function resolveEditor(preferred?: string): Promise<string | null> {
    if (preferred) {
        if (!isEditorAvailable(preferred)) {
            printError(`'${preferred}' is not installed or not in PATH.`);
            process.exit(EXIT_CODES.ERROR);
        }
        return preferred;
    }

    const available = SUPPORTED_EDITORS.filter(isEditorAvailable);

    if (available.length === 0) return null;
    if (available.length === 1) return available[0];

    const choice = await p.select({
        message: "Multiple editors detected. Choose one:",
        options: available.map((editor) => ({
            value: editor,
            label: EDITOR_LABELS[editor],
        })),
    });

    if (p.isCancel(choice)) {
        p.cancel("Cancelled.");
        process.exit(EXIT_CODES.ERROR);
    }

    // clack's select returns string | symbol, but isCancel narrows the symbol case above
    return choice as EditorChoice;
}

function openInEditor(editor: string | null, editorPath: string): void {
    if (!editor) {
        printWarn(
            `  No editor (code/cursor) found. Open manually: ${editorPath}`
        );
        return;
    }

    const label =
        editor in EDITOR_LABELS
            ? EDITOR_LABELS[editor as EditorChoice]
            : editor;
    Bun.spawn([editor, editorPath], { stdout: "inherit", stderr: "inherit" });
    printSuccess(`  Opened in ${label}.`);
}

export { resolveEditor, openInEditor };
