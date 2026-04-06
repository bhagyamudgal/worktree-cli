# worktree-cli

Git worktree manager with automatic env file copying, dependency installation, and editor integration.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/bhagyamudgal/worktree-cli/main/install.sh | bash
```

Or download the binary directly from [Releases](https://github.com/bhagyamudgal/worktree-cli/releases) and place it in your PATH.

## Setup

Create a `.worktreerc` file at your repo root and **commit it** so teammates get the same defaults:

```
DEFAULT_BASE=origin/dev
```

Add `.worktrees/` to your `.gitignore`:

```
.worktrees/
```

## Usage

```bash
worktree create feature-auth                    # new branch from configured base
worktree create feature-auth --editor code      # open in VS Code
worktree create bugfix-123 --base main          # override base branch
worktree create colleague/feature-xyz           # tracks origin remote if exists
worktree open feature-auth                      # open existing worktree in editor
worktree list                                   # list all worktrees with status
worktree remove feature-auth                    # remove worktree + cleanup branch
```

## What it does

On `create`, the CLI:

1. Fetches latest remote refs
2. Creates a git worktree (tracks remote branch if it exists, otherwise branches from base)
3. Copies `.env` and `.env.local` files from the main repo
4. Installs dependencies (auto-detects pnpm/yarn/npm/bun)
5. Opens in your editor (VS Code / Cursor, auto-detected or prompted)

On `remove`, it:

1. Checks for uncommitted changes (prompts before force-removing)
2. Handles broken git references gracefully
3. Cleans up the local branch
4. Removes empty parent directories

## Config

The `.worktreerc` file supports:

| Key | Description | Example |
|-----|-------------|---------|
| `DEFAULT_BASE` | Default base branch for new worktrees | `origin/dev` |
| `WORKTREE_DIR` | Directory name for worktrees (default: `.worktrees`) | `.worktrees` |

## Alias

Add to your `~/.zshrc` or `~/.bashrc`:

```bash
alias gw='worktree'
```

Then use `gw create feature-auth`, `gw list`, etc.

## Update

Re-run the install command to get the latest version.

## Platforms

Pre-built binaries are available for:

- macOS (Apple Silicon / Intel)
- Linux (x64 / ARM64)

## Development

Requires [Bun](https://bun.sh).

```bash
bun install
bun run dev -- help          # run locally
bun run build                # compile standalone binary
bun run typecheck            # type-check
```

## License

MIT
