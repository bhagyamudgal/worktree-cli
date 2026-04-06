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

    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)

    case "$ARCH" in
        x86_64)        ARCH="x64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *)
            echo -e "${RED}Unsupported architecture: $ARCH${NC}"
            exit 1
            ;;
    esac

    case "$OS" in
        darwin|linux) ;;
        *)
            echo -e "${RED}Unsupported OS: $OS${NC}"
            exit 1
            ;;
    esac

    ASSET_NAME="worktree-${OS}-${ARCH}"
    DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}"

    mkdir -p "$INSTALL_DIR"

    echo -e "  Downloading ${DIM}${ASSET_NAME}${NC} from ${DIM}github.com/${REPO}${NC}..."
    if ! curl -fsSL "$DOWNLOAD_URL" -o "${INSTALL_DIR}/${BINARY_NAME}"; then
        echo -e "${RED}Download failed.${NC}"
        echo -e "  Check that a release exists at: ${DIM}https://github.com/${REPO}/releases${NC}"
        exit 1
    fi
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

    SHELL_CONFIG=""
    if [ -f "${HOME}/.zshrc" ]; then
        SHELL_CONFIG="${HOME}/.zshrc"
    elif [ -f "${HOME}/.bashrc" ]; then
        SHELL_CONFIG="${HOME}/.bashrc"
    elif [ -f "${HOME}/.bash_profile" ]; then
        SHELL_CONFIG="${HOME}/.bash_profile"
    fi

    if [ -n "$SHELL_CONFIG" ]; then
        echo -e "  ${DIM}Optional: Add a short alias:${NC}"
        echo -e "    echo 'alias gw=worktree' >> ${SHELL_CONFIG}"
        echo -e "  ${DIM}Then reload: source ${SHELL_CONFIG}${NC}"
        echo ""
    fi

    echo -e "  ${DIM}Tip: Add a .worktreerc to your repo root:${NC}"
    echo -e "  ${DIM}  DEFAULT_BASE=origin/dev${NC}"
    echo ""
}

main
