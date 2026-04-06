#!/usr/bin/env bash
set -euo pipefail

REPO="bhagyamudgal/worktree-cli"
INSTALL_DIR="${HOME}/.local/bin"
BINARY_NAME="worktree"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

main() {
    echo ""
    echo -e "${BOLD}Installing worktree CLI...${NC}"
    echo ""

    mkdir -p "$INSTALL_DIR"

    echo -e "  Downloading from ${DIM}github.com/${REPO}${NC}..."
    curl -fsSL "https://raw.githubusercontent.com/${REPO}/main/bin/worktree" -o "${INSTALL_DIR}/${BINARY_NAME}"
    chmod +x "${INSTALL_DIR}/${BINARY_NAME}"

    echo -e "  ${GREEN}Installed to ${INSTALL_DIR}/${BINARY_NAME}${NC}"

    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
        echo ""
        echo -e "  ${YELLOW}Warning:${NC} ${INSTALL_DIR} is not in your PATH."
        echo -e "  Add this to your shell profile (~/.zshrc or ~/.bashrc):"
        echo ""
        echo -e "    ${DIM}export PATH=\"\${HOME}/.local/bin:\${PATH}\"${NC}"
        echo ""
    fi

    echo ""
    echo -e "${GREEN}${BOLD}Done!${NC} Run ${BOLD}worktree help${NC} to get started."
    echo ""
    echo -e "  ${DIM}Tip: Add a .worktreerc to your repo root:${NC}"
    echo -e "  ${DIM}  DEFAULT_BASE=origin/dev${NC}"
    echo ""
}

main
