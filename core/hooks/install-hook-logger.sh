#!/bin/bash
# install-hook-logger.sh - Install/remove hook event logger
#
# Supports both user-level and project-level installation.
# Only ONE level can be active at a time to avoid duplicate events.
#
# Usage:
#   ./install-hook-logger.sh install [--user|--project]  # Install hooks
#   ./install-hook-logger.sh remove [--user|--project]   # Remove hooks
#   ./install-hook-logger.sh status                      # Check status
#   ./install-hook-logger.sh --help                      # Show help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }
blue() { echo -e "${BLUE}$1${NC}"; }

# Paths
USER_CLAUDE_DIR="$HOME/.claude"
USER_HOOKS_DIR="$USER_CLAUDE_DIR/hooks"
USER_SETTINGS="$USER_CLAUDE_DIR/settings.json"

# Find project root (look for .git or package.json)
find_project_root() {
  local dir="${1:-$(pwd)}"
  while [ "$dir" != "/" ]; do
    if [ -d "$dir/.git" ] || [ -f "$dir/package.json" ]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  echo ""
}

PROJECT_ROOT=$(find_project_root)
PROJECT_CLAUDE_DIR="${PROJECT_ROOT:+$PROJECT_ROOT/.claude}"
PROJECT_SETTINGS="${PROJECT_CLAUDE_DIR:+$PROJECT_CLAUDE_DIR/settings.json}"

# ============================================================================
# Detection Functions
# ============================================================================

has_user_hooks() {
  [ -f "$USER_SETTINGS" ] && grep -q "hook-event-logger" "$USER_SETTINGS" 2>/dev/null
}

has_project_hooks() {
  [ -n "$PROJECT_SETTINGS" ] && [ -f "$PROJECT_SETTINGS" ] && grep -q "hook-event-logger" "$PROJECT_SETTINGS" 2>/dev/null
}

check_jq() {
  if ! command -v jq &>/dev/null; then
    error "jq is required but not installed"
    echo "Install with:"
    echo "  macOS:  brew install jq"
    echo "  Ubuntu: sudo apt install jq"
    exit 1
  fi
}

# ============================================================================
# Status Command
# ============================================================================

show_status() {
  echo ""
  blue "=== Hook Event Logger Status ==="
  echo ""

  # User-level
  echo "User-level (~/.claude):"
  if has_user_hooks; then
    info "  Hooks: INSTALLED"
  else
    echo "  Hooks: not installed"
  fi
  if [ -f "$USER_HOOKS_DIR/hook-event-logger.sh" ]; then
    info "  Scripts: present"
  else
    echo "  Scripts: not present"
  fi

  echo ""

  # Project-level
  if [ -n "$PROJECT_ROOT" ]; then
    echo "Project-level ($PROJECT_ROOT):"
    if has_project_hooks; then
      info "  Hooks: INSTALLED"
    else
      echo "  Hooks: not installed"
    fi
  else
    echo "Project-level: (no project detected)"
  fi

  echo ""

  # Event log
  echo "Event log:"
  if [ -f "$USER_CLAUDE_DIR/hook-events.jsonl" ]; then
    local count
    count=$(wc -l < "$USER_CLAUDE_DIR/hook-events.jsonl" | tr -d ' ')
    info "  $count events in ~/.claude/hook-events.jsonl"
  else
    echo "  No events logged yet"
  fi

  echo ""
}

# ============================================================================
# Install Functions
# ============================================================================

generate_hooks_json() {
  local hook_command="$1"
  cat << EOF
{
  "\$schema": "https://json.schemastore.org/claude-code-settings.json",
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": $hook_command, "timeout": 5}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": $hook_command, "timeout": 5}]}],
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": $hook_command, "timeout": 5}]}],
    "PermissionRequest": [{"hooks": [{"type": "command", "command": $hook_command, "timeout": 5}]}],
    "PreToolUse": [{"hooks": [{"type": "command", "command": $hook_command, "timeout": 5}]}],
    "PostToolUse": [{"hooks": [{"type": "command", "command": $hook_command, "timeout": 5}]}],
    "PostToolUseFailure": [{"hooks": [{"type": "command", "command": $hook_command, "timeout": 5}]}],
    "Notification": [{"hooks": [{"type": "command", "command": $hook_command, "timeout": 5}]}],
    "SubagentStart": [{"hooks": [{"type": "command", "command": $hook_command, "timeout": 5}]}],
    "SubagentStop": [{"hooks": [{"type": "command", "command": $hook_command, "timeout": 5}]}],
    "Stop": [{"hooks": [{"type": "command", "command": $hook_command, "timeout": 5}]}],
    "PreCompact": [{"hooks": [{"type": "command", "command": $hook_command, "timeout": 5}]}]
  }
}
EOF
}

install_user() {
  check_jq

  # Check for conflict
  if has_project_hooks; then
    error "Project-level hooks are already installed!"
    echo "Only one level can be active at a time to avoid duplicate events."
    echo ""
    echo "Options:"
    echo "  1. Remove project hooks first: $0 remove --project"
    echo "  2. Keep using project-level hooks"
    exit 1
  fi

  info "Installing user-level hooks..."

  # Create directories
  mkdir -p "$USER_HOOKS_DIR"

  # Copy scripts
  info "Copying hook scripts to ~/.claude/hooks/"
  cp "$SCRIPT_DIR/hook-lib.sh" "$USER_HOOKS_DIR/"
  cp "$SCRIPT_DIR/hook-event-logger.sh" "$USER_HOOKS_DIR/"
  chmod +x "$USER_HOOKS_DIR/hook-lib.sh" "$USER_HOOKS_DIR/hook-event-logger.sh"

  # Generate hooks config
  local hook_command='"$HOME/.claude/hooks/hook-event-logger.sh"'
  local hooks_json
  hooks_json=$(generate_hooks_json "$hook_command")

  # Merge into settings
  if [ -f "$USER_SETTINGS" ]; then
    info "Merging hooks into existing settings.json..."
    local merged
    merged=$(jq -s '.[0] * .[1]' "$USER_SETTINGS" <(echo "$hooks_json"))
    echo "$merged" > "$USER_SETTINGS"
  else
    info "Creating settings.json..."
    echo "$hooks_json" > "$USER_SETTINGS"
  fi

  info "User-level hooks installed!"
  echo ""
  echo "Events will be logged to: ~/.claude/hook-events.jsonl"
  echo "Test with: claude -p 'test' && cat ~/.claude/hook-events.jsonl"
}

install_project() {
  check_jq

  if [ -z "$PROJECT_ROOT" ]; then
    error "No project detected (no .git or package.json found)"
    echo "Run from within a project directory, or use --user for user-level installation."
    exit 1
  fi

  # Check for conflict
  if has_user_hooks; then
    error "User-level hooks are already installed!"
    echo "Only one level can be active at a time to avoid duplicate events."
    echo ""
    echo "Options:"
    echo "  1. Remove user hooks first: $0 remove --user"
    echo "  2. Keep using user-level hooks"
    exit 1
  fi

  info "Installing project-level hooks to: $PROJECT_ROOT"

  # Check for hook scripts
  local project_hooks_dir="$PROJECT_ROOT/tier-agent-core/hooks"
  if [ ! -f "$project_hooks_dir/hook-event-logger.sh" ]; then
    warn "Hook scripts not found at $project_hooks_dir"
    echo "Copying scripts to project..."
    mkdir -p "$project_hooks_dir"
    cp "$SCRIPT_DIR/hook-lib.sh" "$project_hooks_dir/"
    cp "$SCRIPT_DIR/hook-event-logger.sh" "$project_hooks_dir/"
    chmod +x "$project_hooks_dir/hook-lib.sh" "$project_hooks_dir/hook-event-logger.sh"
  fi

  # Create .claude directory
  mkdir -p "$PROJECT_CLAUDE_DIR"

  # Generate hooks config with $CLAUDE_PROJECT_DIR
  local hook_command='"\"$CLAUDE_PROJECT_DIR\"/tier-agent-core/hooks/hook-event-logger.sh"'
  local hooks_json
  hooks_json=$(generate_hooks_json "$hook_command")

  # Merge into settings
  if [ -f "$PROJECT_SETTINGS" ]; then
    info "Merging hooks into existing .claude/settings.json..."
    local merged
    merged=$(jq -s '.[0] * .[1]' "$PROJECT_SETTINGS" <(echo "$hooks_json"))
    echo "$merged" > "$PROJECT_SETTINGS"
  else
    info "Creating .claude/settings.json..."
    echo "$hooks_json" > "$PROJECT_SETTINGS"
  fi

  info "Project-level hooks installed!"
  echo ""
  echo "Events will be logged to: ~/.claude/hook-events.jsonl"
  echo "Test with: cd $PROJECT_ROOT && claude -p 'test' && cat ~/.claude/hook-events.jsonl"
}

# ============================================================================
# Remove Functions
# ============================================================================

remove_hooks_from_settings() {
  local settings_file="$1"

  if [ ! -f "$settings_file" ]; then
    return 0
  fi

  info "Removing hooks from $settings_file..."

  # Remove all hook entries that reference hook-event-logger
  local updated
  updated=$(jq '
    if .hooks then
      .hooks |= with_entries(
        .value |= map(
          select(.hooks | all(.command | contains("hook-event-logger") | not))
        ) |
        select(length > 0)
      ) |
      if .hooks == {} then del(.hooks) else . end
    else
      .
    end
  ' "$settings_file")

  echo "$updated" > "$settings_file"
}

remove_user() {
  check_jq

  if ! has_user_hooks; then
    warn "User-level hooks are not installed"
    return 0
  fi

  info "Removing user-level hooks..."

  # Remove from settings
  remove_hooks_from_settings "$USER_SETTINGS"

  # Optionally remove scripts
  echo ""
  read -p "Also remove hook scripts from ~/.claude/hooks/? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -f "$USER_HOOKS_DIR/hook-lib.sh" "$USER_HOOKS_DIR/hook-event-logger.sh"
    info "Scripts removed"
  fi

  info "User-level hooks removed!"
}

remove_project() {
  check_jq

  if [ -z "$PROJECT_ROOT" ]; then
    error "No project detected"
    exit 1
  fi

  if ! has_project_hooks; then
    warn "Project-level hooks are not installed"
    return 0
  fi

  info "Removing project-level hooks from: $PROJECT_ROOT"

  # Remove from settings
  remove_hooks_from_settings "$PROJECT_SETTINGS"

  info "Project-level hooks removed!"
}

# ============================================================================
# Help
# ============================================================================

show_help() {
  cat << 'EOF'
Hook Event Logger - Install/Remove Script

USAGE:
  ./install-hook-logger.sh <command> [options]

COMMANDS:
  install [--user|--project]   Install hook event logger
  remove [--user|--project]    Remove hook event logger
  status                       Show installation status
  --help, -h                   Show this help

OPTIONS:
  --user      User-level installation (~/.claude/settings.json)
              - Works across all projects
              - Requires copying scripts to ~/.claude/hooks/

  --project   Project-level installation (.claude/settings.json)
              - Only works in the current project
              - Uses scripts from tier-agent-core/hooks/

IMPORTANT:
  Only ONE level can be installed at a time to avoid duplicate events.
  The script will error if you try to install both.

EXAMPLES:
  # Install to current project (recommended)
  ./install-hook-logger.sh install --project

  # Install globally for all projects
  ./install-hook-logger.sh install --user

  # Check what's installed
  ./install-hook-logger.sh status

  # Remove from project
  ./install-hook-logger.sh remove --project

  # Remove from user
  ./install-hook-logger.sh remove --user

EVENT LOG:
  Events are logged to: ~/.claude/hook-events.jsonl
  View with: tail -f ~/.claude/hook-events.jsonl
  Query with: jq '.hook' ~/.claude/hook-events.jsonl | sort | uniq -c
EOF
}

# ============================================================================
# Main
# ============================================================================

main() {
  local command="${1:-}"
  local level="${2:-}"

  case "$command" in
    install)
      case "$level" in
        --user|-u)
          install_user
          ;;
        --project|-p)
          install_project
          ;;
        "")
          error "Please specify --user or --project"
          echo ""
          echo "Usage: $0 install [--user|--project]"
          echo ""
          echo "  --user     Install to ~/.claude/ (all projects)"
          echo "  --project  Install to .claude/ (this project only)"
          exit 1
          ;;
        *)
          error "Unknown option: $level"
          exit 1
          ;;
      esac
      ;;

    remove)
      case "$level" in
        --user|-u)
          remove_user
          ;;
        --project|-p)
          remove_project
          ;;
        "")
          error "Please specify --user or --project"
          echo ""
          echo "Usage: $0 remove [--user|--project]"
          exit 1
          ;;
        *)
          error "Unknown option: $level"
          exit 1
          ;;
      esac
      ;;

    status|--status|-s)
      show_status
      ;;

    --help|-h|help)
      show_help
      ;;

    "")
      show_help
      ;;

    *)
      error "Unknown command: $command"
      echo ""
      echo "Usage: $0 <install|remove|status> [--user|--project]"
      exit 1
      ;;
  esac
}

main "$@"
