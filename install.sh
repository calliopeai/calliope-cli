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
YELLOW='\033[0;33m'
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

# Detect OS
detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "macos"
    elif [[ -f /etc/debian_version ]]; then
        echo "debian"
    elif [[ -f /etc/redhat-release ]]; then
        echo "redhat"
    elif [[ -f /etc/arch-release ]]; then
        echo "arch"
    elif [[ -f /etc/alpine-release ]]; then
        echo "alpine"
    else
        echo "linux"
    fi
}

# Install Node.js
install_node() {
    local os=$(detect_os)
    echo -e "${YELLOW}Node.js not found. Installing Node.js 20...${NC}"
    echo ""

    case $os in
        macos)
            if command -v brew &> /dev/null; then
                echo -e "${DIM}Installing via Homebrew...${NC}"
                brew install node@20
                brew link node@20 --force --overwrite 2>/dev/null || true
            else
                echo -e "${DIM}Installing via official installer...${NC}"
                # Download and run the official pkg installer
                curl -fsSL https://nodejs.org/dist/v20.10.0/node-v20.10.0.pkg -o /tmp/node.pkg
                sudo installer -pkg /tmp/node.pkg -target /
                rm /tmp/node.pkg
            fi
            ;;
        debian)
            echo -e "${DIM}Installing via NodeSource...${NC}"
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
            sudo apt-get install -y nodejs
            ;;
        redhat)
            echo -e "${DIM}Installing via NodeSource...${NC}"
            curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
            sudo yum install -y nodejs
            ;;
        arch)
            echo -e "${DIM}Installing via pacman...${NC}"
            sudo pacman -Sy --noconfirm nodejs npm
            ;;
        alpine)
            echo -e "${DIM}Installing via apk...${NC}"
            sudo apk add --no-cache nodejs npm
            ;;
        *)
            echo -e "${RED}Could not detect package manager.${NC}"
            echo "Please install Node.js 18+ manually: https://nodejs.org/"
            exit 1
            ;;
    esac

    # Verify installation
    if command -v node &> /dev/null; then
        echo -e "${GREEN}✓${NC} Node.js $(node -v) installed"
    else
        echo -e "${RED}Node.js installation failed.${NC}"
        echo "Please install manually: https://nodejs.org/"
        exit 1
    fi
}

# Check for Node.js
check_node() {
    if ! command -v node &> /dev/null; then
        install_node
        return
    fi

    # Check Node.js version
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        echo -e "${YELLOW}Node.js 18+ required (found v$(node -v))${NC}"
        install_node
        return
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

    # Use sudo for global install on Linux
    if [[ "$OSTYPE" == "darwin"* ]] && command -v brew &> /dev/null; then
        npm install -g @calliopelabs/cli
    else
        sudo npm install -g @calliopelabs/cli
    fi

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
