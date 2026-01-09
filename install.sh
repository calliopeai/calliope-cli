#!/bin/bash
#
# Calliope CLI Installer
# https://calliope.ai
#
# Usage:
#   curl -fsSL https://calliope.ai/install.sh | bash
#

set -e

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo ""
echo -e "${CYAN}${BOLD}  ██████╗ █████╗ ██╗     ██╗     ██╗ ██████╗ ██████╗ ███████╗${NC}"
echo -e "${CYAN} ██╔════╝██╔══██╗██║     ██║     ██║██╔═══██╗██╔══██╗██╔════╝${NC}"
echo -e "${CYAN} ██║     ███████║██║     ██║     ██║██║   ██║██████╔╝█████╗  ${NC}"
echo -e "${CYAN} ██║     ██╔══██║██║     ██║     ██║██║   ██║██╔═══╝ ██╔══╝  ${NC}"
echo -e "${CYAN} ╚██████╗██║  ██║███████╗███████╗██║╚██████╔╝██║     ███████╗${NC}"
echo -e "${CYAN}  ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝ ╚═════╝ ╚═╝     ╚══════╝${NC}"
echo ""
echo -e "${DIM}  The Muse of Digital Eloquence${NC}"
echo ""

# Check for Node.js
check_node() {
    if ! command -v node &> /dev/null; then
        echo -e "${RED}Error: Node.js is not installed.${NC}"
        echo ""
        echo "Please install Node.js 18+ first:"
        echo "  - macOS: brew install node"
        echo "  - Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
        echo "  - Or visit: https://nodejs.org/"
        echo ""
        exit 1
    fi

    # Check Node.js version
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        echo -e "${RED}Error: Node.js 18+ is required (found v$(node -v))${NC}"
        echo "Please upgrade Node.js: https://nodejs.org/"
        exit 1
    fi

    echo -e "${GREEN}✓${NC} Node.js $(node -v) detected"
}

# Check for npm
check_npm() {
    if ! command -v npm &> /dev/null; then
        echo -e "${RED}Error: npm is not installed.${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓${NC} npm $(npm -v) detected"
}

# Install Calliope CLI
install_calliope() {
    echo ""
    echo -e "${CYAN}Installing @calliopelabs/cli...${NC}"
    echo ""

    npm install -g @calliopelabs/cli

    if [ $? -eq 0 ]; then
        echo ""
        echo -e "${GREEN}✓ Calliope CLI installed successfully!${NC}"
        echo ""
        echo -e "Run ${CYAN}calliope${NC} to start."
        echo ""
        echo -e "${DIM}Quick start:${NC}"
        echo -e "  ${CYAN}calliope${NC}              # Start interactive session"
        echo -e "  ${CYAN}calliope --setup${NC}      # Configure API keys"
        echo -e "  ${CYAN}calliope -g${NC}           # God mode (no prompts)"
        echo ""
        echo -e "${DIM}Set your API key:${NC}"
        echo -e "  export ANTHROPIC_API_KEY=sk-ant-..."
        echo ""
        echo -e "Documentation: ${CYAN}https://docs.calliope.ai/cli/${NC}"
        echo ""
    else
        echo -e "${RED}Installation failed.${NC}"
        echo "Please try: npm install -g @calliopelabs/cli"
        exit 1
    fi
}

# Main
echo -e "${CYAN}Installing Calliope CLI...${NC}"
echo ""

check_node
check_npm
install_calliope
