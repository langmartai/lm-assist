#!/bin/bash
# install.sh — One-command installer for lm-assist (Linux/macOS)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash -s -- --dev
#   # pin a specific build (tag / branch / commit) — prebuilt release tgz preferred; falls back to source-build:
#   curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash -s -- --ref v0.1.76
#   # (or set LM_ASSIST_REF=v0.1.76 in the environment)
#   # install a specific published npm version (or latest):
#   curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash -s -- --published
#   curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash -s -- --published 0.1.76
#   # (or set LM_ASSIST_PUBLISHED=1 or LM_ASSIST_PUBLISHED=0.1.76 in the environment)
#   # force a source-build even when a prebuilt release tgz is available:
#   curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash -s -- --source-build
#
# What it does:
#   1. Bare prereq gate (git/node/npm/claude present; node major >= 20)
#   2. Installs the lm-assist plugin (skills, commands, MCP, hooks)
#   3. Clones the repo (skipped for --published), runs PREFLIGHT (Node>=20.9, chokidar pin)
#   4. prod install (3-way resolver):
#        --published [<ver>]: npm install -g lm-assist@<ver|latest> (registry)
#        default:             prefer prebuilt GitHub-Release tgz for the ref; source-build fallback
#        --source-build:      skip prebuilt tgz, always source-build (npm pack -> npm install -g)
#      --dev:                 npm install --ignore-scripts -> build -> ./core.sh start (:3200/:3948)
#
# Requirements: git, node >= 20.9, npm, claude (Claude Code CLI)

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}[lm-assist]${NC} $*"; }
ok()    { echo -e "${GREEN}[lm-assist]${NC} $*"; }
warn()  { echo -e "${YELLOW}[lm-assist]${NC} $*"; }
fail()  { echo -e "${RED}[lm-assist]${NC} $*"; exit 1; }

INSTALL_DIR="${LM_ASSIST_DIR:-$HOME/lm-assist}"
REF="${LM_ASSIST_REF:-}"   # optional: pin to a tag / branch / commit
PUBLISHED="${LM_ASSIST_PUBLISHED:-}"   # '', '1', or a version string
FORCE_SOURCE_BUILD=""

MODE="prod"
while [ $# -gt 0 ]; do
  case "$1" in
    --dev)        MODE="dev" ;;
    --prod)       MODE="prod" ;;
    --ref)        shift; REF="${1:-}" ;;
    --ref=*)      REF="${1#--ref=}" ;;
    --published)  PUBLISHED="${LM_ASSIST_PUBLISHED:-1}"; if [ "${2:-}" ] && printf '%s' "${2:-}" | grep -qE '^[0-9]'; then PUBLISHED="$2"; shift; fi ;;
    --published=*) PUBLISHED="${1#--published=}" ;;
    --source-build) FORCE_SOURCE_BUILD=1 ;;
    *) warn "Ignoring unknown argument: $1" ;;
  esac
  shift
done

write_marker() { # $1=kind $2=source $3=version
  node -e "const fs=require('fs'),os=require('os'),path=require('path');const d=process.env.LM_ASSIST_DATA_DIR||path.join(os.homedir(),'.lm-assist');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'install-source.json'),JSON.stringify({kind:'$1',source:'$2',version:${3:-null},installedAt:new Date().toISOString()},null,2),{mode:0o600});" 2>/dev/null || true
}

# ─── Prerequisites (bare gate; the post-clone preflight is authoritative) ───
info "Checking prerequisites..."
command -v git    >/dev/null 2>&1 || fail "git is required but not installed"
command -v node   >/dev/null 2>&1 || fail "node is required (>= 20.9). Install from https://nodejs.org or via nvm: nvm install 20 && nvm use 20"
command -v npm    >/dev/null 2>&1 || fail "npm is required but not installed"
command -v claude >/dev/null 2>&1 || fail "claude (Claude Code CLI) is required: https://docs.anthropic.com/en/docs/claude-code"

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js >= 20.9 is required (found $(node -v)). Upgrade Node (e.g. nvm install 20 && nvm use 20) and re-run."
fi
ok "Prereqs present (node $(node -v), claude $(claude --version 2>/dev/null | head -1 || echo installed)) — mode: $MODE"

# ─── Step 1: Plugin ───
info "Adding langmartai marketplace + installing plugin..."
claude plugin marketplace add langmartai/lm-assist 2>/dev/null || warn "Marketplace may already be added"
claude plugin install lm-assist@langmartai 2>&1 || warn "Plugin install returned non-zero (may already be installed)"

# ─── Step 2: Clone / pull (skipped for --published; optionally pinned to --ref tag/branch/commit) ───
if [ -z "$PUBLISHED" ]; then
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Updating existing checkout at $INSTALL_DIR..."
    git -C "$INSTALL_DIR" fetch --tags --quiet origin 2>/dev/null || true
    if [ -n "$REF" ]; then
      info "Checking out pinned ref: $REF"
      git -C "$INSTALL_DIR" checkout --quiet "$REF" 2>/dev/null || fail "Could not checkout ref: $REF"
    else
      git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || warn "Could not fast-forward (local changes?) — continuing"
    fi
  else
    info "Cloning lm-assist to $INSTALL_DIR..."
    git clone https://github.com/langmartai/lm-assist.git "$INSTALL_DIR"
    if [ -n "$REF" ]; then
      info "Checking out pinned ref: $REF"
      git -C "$INSTALL_DIR" checkout --quiet "$REF" || fail "Could not checkout ref: $REF"
    fi
  fi
  cd "$INSTALL_DIR"

  # ─── Step 3: Install deps (--ignore-scripts: onnxruntime postinstall would die) + PREFLIGHT ───
  info "Installing dependencies (this can take a minute)..."
  npm install --ignore-scripts --no-audit --no-fund 2>&1 | tail -1

  info "Running preflight (authoritative environment check)..."
  if ! node scripts/preflight.js --phase=post-clone --repo="$INSTALL_DIR"; then
    fail "Preflight failed — resolve the issues above and re-run."
  fi
fi

# ─── Step 4: Build + start by mode ───
if [ "$MODE" = "dev" ]; then
  info "Building (dev)..."
  npm run build 2>&1 | tail -20
  ok "Build complete (dev). Start with: cd $INSTALL_DIR && ./core.sh start   (API :3200, Web :3948)"
else  # prod
  if [ -n "$PUBLISHED" ]; then
    VER=$([ "$PUBLISHED" = "1" ] && echo latest || echo "$PUBLISHED")
    info "Installing published lm-assist@$VER from npm..."
    npm install -g "lm-assist@$VER" 2>&1 | tail -3
    write_marker published "lm-assist@$VER" '"'"$([ "$VER" = latest ] && node -e "process.stdout.write(require('child_process').execSync('npm view lm-assist version').toString().trim())" 2>/dev/null || echo "$VER")"'"'
    ok "Installed published lm-assist@$VER."
  else
    # Prefer the prebuilt GitHub-Release tgz for the ref; fall back to source-build.
    TAG="${REF:-}"; ASSET_URL=""
    if [ -z "$FORCE_SOURCE_BUILD" ]; then
      if [ -n "$TAG" ]; then
        V="${TAG#v}"; ASSET_URL="https://github.com/langmartai/lm-assist/releases/download/$TAG/lm-assist-$V.tgz"
        curl -sfIL "$ASSET_URL" >/dev/null 2>&1 || ASSET_URL=""
      else
        ASSET_URL=$(curl -sfL https://api.github.com/repos/langmartai/lm-assist/releases/latest 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const a=(j.assets||[]).find(x=>/^lm-assist-.*\.tgz$/.test(x.name));process.stdout.write(a?a.browser_download_url:'')}catch(e){}})" 2>/dev/null)
      fi
    fi
    if [ -n "$ASSET_URL" ]; then
      info "Installing prebuilt release: $ASSET_URL"
      npm install -g "$ASSET_URL" 2>&1 | tail -3
      write_marker custom "$ASSET_URL" null
      ok "Installed prebuilt release build."
    else
      info "No prebuilt release for ${TAG:-latest} — source-building..."
      npm pack 2>&1 | tail -1
      TGZ=$(ls -t lm-assist-*.tgz | head -1); [ -n "$TGZ" ] || fail "npm pack did not produce a tgz"
      npm install -g "./$TGZ" 2>&1 | tail -3
      write_marker custom "github:langmartai/lm-assist#${REF:-$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}" null
      ok "Installed source build."
    fi
  fi
fi

# ─── .env ───
if [ ! -f "$INSTALL_DIR/.env" ] && [ -f "$INSTALL_DIR/.env.example" ]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  warn "Created .env from .env.example — edit to add ANTHROPIC_API_KEY"
fi

echo ""
echo -e "${GREEN}lm-assist installed (${MODE}).${NC}"
echo "  Source: $INSTALL_DIR"
echo "  Next:"
if [ "$MODE" = "dev" ]; then
  echo "    1. cd $INSTALL_DIR && ./core.sh start"
  echo "    2. ./core.sh status      # API :3200 / Web :3948"
else
  echo "    1. lm-assist status      # API :3100 / Web :3848 (auto-started)"
  echo "    2. lm-assist doctor      # re-check the environment anytime"
fi
echo "    3. Open a NEW Claude Code session (activates MCP/hooks), then run /assist-setup"
echo "    (Connecting to a hub is a separate, optional step: lm-assist setup --key <KEY>)"
