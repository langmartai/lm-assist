#!/bin/bash
# install.sh — One-command installer for lm-assist Claude Code plugin
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash
#
# What it does:
#   1. Adds langmartai marketplace to Claude Code
#   2. Installs the lm-assist plugin (MCP server, hooks, slash commands)
#   3. Clones the repo and builds (for the API + Web services)
#   4. Prints next steps
#
# Requirements: git, node >= 18, npm, claude (Claude Code CLI)

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[lm-assist]${NC} $*"; }
ok()    { echo -e "${GREEN}[lm-assist]${NC} $*"; }
warn()  { echo -e "${YELLOW}[lm-assist]${NC} $*"; }
fail()  { echo -e "${RED}[lm-assist]${NC} $*"; exit 1; }

INSTALL_DIR="${LM_ASSIST_DIR:-$HOME/lm-assist}"

# ─── Prerequisites ───

info "Checking prerequisites..."

command -v git   >/dev/null 2>&1 || fail "git is required but not installed"
command -v node  >/dev/null 2>&1 || fail "node is required (>= 18). Install from https://nodejs.org"
command -v npm   >/dev/null 2>&1 || fail "npm is required but not installed"
command -v claude >/dev/null 2>&1 || fail "claude (Claude Code CLI) is required. Install from https://docs.anthropic.com/en/docs/claude-code"

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  fail "Node.js >= 18 is required (found v$(node -v))"
fi

ok "Prerequisites OK (node $(node -v), claude $(claude --version 2>/dev/null | head -1 || echo 'installed'))"

# ─── Step 1: Add marketplace ───

info "Adding langmartai marketplace..."
if claude plugin marketplace add langmartai/lm-assist 2>/dev/null; then
  ok "Marketplace added"
else
  warn "Marketplace may already be added (continuing)"
fi

# ─── Step 2: Install plugin ───

info "Installing lm-assist plugin..."
if claude plugin install lm-assist 2>&1; then
  ok "Plugin installed (MCP server, hooks, slash commands)"
else
  warn "Plugin install returned non-zero (may already be installed)"
fi

# ─── Step 3: Clone and build (for API + Web services) ───

if [ -d "$INSTALL_DIR" ]; then
  info "Found existing install at $INSTALL_DIR — pulling latest..."
  cd "$INSTALL_DIR"
  git pull --ff-only 2>/dev/null || warn "Could not pull (may have local changes)"
else
  info "Cloning lm-assist to $INSTALL_DIR..."
  git clone https://github.com/langmartai/lm-assist.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

info "Installing dependencies..."
npm install --no-audit --no-fund 2>&1 | tail -1

info "Building..."
npm run build 2>&1 | tail -3

ok "Build complete"

# ─── Step 4: Create .env if missing ───

if [ ! -f "$INSTALL_DIR/.env" ] && [ -f "$INSTALL_DIR/.env.example" ]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  warn "Created .env from .env.example — edit to add your ANTHROPIC_API_KEY"
fi

# ─── Done ───

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          lm-assist installed successfully        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Plugin:  MCP server + hooks + slash commands registered"
echo "  Source:  $INSTALL_DIR"
echo ""
echo "  Next steps:"
echo "    1. Add your API key:  echo 'ANTHROPIC_API_KEY=sk-...' >> $INSTALL_DIR/.env"
echo "    2. Start services:    cd $INSTALL_DIR && ./core.sh start"
echo "    3. In Claude Code:    /assist-status"
echo ""
echo "  Or use the slash command to do it all:"
echo "    /assist-setup"
echo ""
