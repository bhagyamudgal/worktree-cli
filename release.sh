#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

PACKAGE_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')
TAG="v${PACKAGE_VERSION}"

if [[ -z "$PACKAGE_VERSION" ]]; then
    echo -e "${RED}Could not read version from package.json${NC}"
    exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
    echo -e "${RED}Working directory is not clean. Commit or stash changes first.${NC}"
    exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
    echo -e "${RED}Tag ${BOLD}${TAG}${NC}${RED} already exists.${NC}"
    echo -e "  Update the version in ${DIM}package.json${NC} first."
    exit 1
fi

echo ""
echo -e "${BOLD}Releasing ${TAG}${NC}"
echo -e "  ${DIM}Version from package.json: ${PACKAGE_VERSION}${NC}"
echo ""

echo -e "${YELLOW}This will:${NC}"
echo "  1. Create git tag ${TAG}"
echo "  2. Push tag to origin"
echo "  3. Trigger GitHub Actions to build + release"
echo ""

read -rp "Continue? (y/N): " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo -e "${DIM}Cancelled.${NC}"
    exit 0
fi

echo ""
echo -e "  Creating tag ${BOLD}${TAG}${NC}..."
git tag "$TAG"

echo -e "  Pushing tag to origin..."
git push origin "$TAG"

echo ""
echo -e "${GREEN}${BOLD}Done!${NC} Release ${TAG} is being built."
echo -e "  ${DIM}Watch progress: https://github.com/$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/' | sed 's/.*github.com[:/]\(.*\)/\1/')/actions${NC}"
echo ""
