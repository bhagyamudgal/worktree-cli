const COLORS = {
    RED: "\x1b[0;31m",
    GREEN: "\x1b[0;32m",
    YELLOW: "\x1b[1;33m",
    BLUE: "\x1b[0;34m",
    CYAN: "\x1b[0;36m",
    BOLD: "\x1b[1m",
    DIM: "\x1b[2m",
    RESET: "\x1b[0m",
} as const;

const DEFAULT_WORKTREE_DIR = ".worktrees";

const SUPPORTED_EDITORS = ["code", "cursor"] as const;
type EditorChoice = (typeof SUPPORTED_EDITORS)[number];

const EDITOR_LABELS: Record<EditorChoice, string> = {
    code: "VS Code",
    cursor: "Cursor",
} as const;

const ENV_FILE_NAMES = [".env", ".env.local"] as const;
const ENV_SEARCH_MAX_DEPTH = 4;
const ENV_EXCLUDE_DIRS = ["node_modules", ".next", ".claude", "dist"] as const;

const EXIT_CODES = {
    SUCCESS: 0,
    ERROR: 1,
} as const;

export {
    COLORS,
    DEFAULT_WORKTREE_DIR,
    SUPPORTED_EDITORS,
    EDITOR_LABELS,
    ENV_FILE_NAMES,
    ENV_SEARCH_MAX_DEPTH,
    ENV_EXCLUDE_DIRS,
    EXIT_CODES,
};
export type { EditorChoice };
