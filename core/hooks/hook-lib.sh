#!/bin/bash
# hook-lib.sh - High-performance shared library for Claude Code hooks
# Optimized for minimal startup time by:
# - Single jq call to extract all fields
# - Cached platform detection
# - Direct /proc access on Linux
# - Minimal external command invocations
#
# Usage: source this file in your hook scripts
#   source "$(dirname "$0")/hook-lib.sh"
#   init_hook  # reads stdin, sets up variables
#   log_event "tool_allow" "bash" "Bash"
#   exit 0

set -euo pipefail

# ============================================================================
# Configuration
# ============================================================================

HOOK_EVENTS_FILE="${CLAUDE_HOOK_EVENTS_FILE:-$HOME/.claude/hook-events.jsonl}"
HOOK_DEBUG="${CLAUDE_HOOK_DEBUG:-false}"

# ============================================================================
# Platform Detection (cached via simple check)
# ============================================================================

# Detect platform once - use cached /proc check for Linux vs uname fallback
_detect_platform_fast() {
  if [[ -d /proc/self ]]; then
    echo "linux"
  elif [[ "$(uname -s 2>/dev/null)" == "Darwin" ]]; then
    echo "macos"
  else
    echo "unknown"
  fi
}

PLATFORM="${HOOK_PLATFORM_CACHE:-$(_detect_platform_fast)}"

# ============================================================================
# Timestamp (optimized per-platform)
# ============================================================================

_get_timestamp_ms_fast() {
  if [[ "$PLATFORM" == "linux" ]]; then
    # Linux: date +%s%3N gives milliseconds directly
    date +%s%3N 2>/dev/null || echo "$(($(date +%s) * 1000))"
  elif [[ "$PLATFORM" == "macos" ]]; then
    # macOS: use date -j for seconds, gdate if available for ms
    if command -v gdate &>/dev/null; then
      gdate +%s%3N
    else
      echo "$(($(date +%s) * 1000))"
    fi
  else
    echo "$(($(date +%s) * 1000))"
  fi
}

# ============================================================================
# JSON Helpers (optimized)
# ============================================================================

# Fast JSON string escape using bash builtins only
_json_escape_fast() {
  local s="$1"
  s="${s//\\/\\\\}"  # backslash
  s="${s//\"/\\\"}"  # quotes
  s="${s//$'\t'/\\t}"  # tab
  s="${s//$'\r'/\\r}"  # carriage return
  s="${s//$'\n'/\\n}"  # newline
  printf '%s' "$s"
}

# ============================================================================
# Hook Input/Output
# ============================================================================

# Global variables set by init_hook
HOOK_INPUT=""
HOOK_SESSION_ID=""
HOOK_EVENT_NAME=""
HOOK_TOOL_NAME=""
HOOK_TOOL_USE_ID=""
HOOK_AGENT_ID=""
HOOK_AGENT_TYPE=""
HOOK_CLAUDE_PID=""
HOOK_TIMESTAMP=""

# Initialize hook - reads stdin and extracts all fields in ONE jq call
init_hook() {
  # Read entire stdin
  HOOK_INPUT=$(cat)

  # Get timestamp early (before jq call)
  HOOK_TIMESTAMP=$(_get_timestamp_ms_fast)

  # Extract ALL fields in a single jq invocation - outputs tab-separated values
  local extracted
  extracted=$(printf '%s' "$HOOK_INPUT" | jq -r '
    [
      (.session_id // ""),
      (.hook_event_name // ""),
      (.tool_name // ""),
      (.tool_use_id // ""),
      (.agent_id // ""),
      (.agent_type // "")
    ] | @tsv
  ' 2>/dev/null) || extracted=""

  # Parse tab-separated values using read (no subshells)
  IFS=$'\t' read -r HOOK_SESSION_ID HOOK_EVENT_NAME HOOK_TOOL_NAME HOOK_TOOL_USE_ID HOOK_AGENT_ID HOOK_AGENT_TYPE <<< "$extracted"

  # Get Claude PID - use PPID directly (most reliable for hooks)
  HOOK_CLAUDE_PID="${PPID:-$$}"

  # Debug output
  if [[ "$HOOK_DEBUG" == "true" ]]; then
    echo "[hook-lib] Session: $HOOK_SESSION_ID, Event: $HOOK_EVENT_NAME, Tool: $HOOK_TOOL_NAME" >&2
  fi
}

# ============================================================================
# Event Logging
# ============================================================================

# Derive target type from tool name - inline case for speed
_get_target_type_fast() {
  case "$1" in
    Bash) echo "bash" ;;
    Read|Write|Edit|Glob) echo "file" ;;
    Grep|WebSearch) echo "search" ;;
    WebFetch) echo "web" ;;
    NotebookEdit) echo "notebook" ;;
    Task) echo "agent" ;;
    TaskCreate|TaskUpdate|TaskList|TaskGet) echo "task" ;;
    mcp__*) echo "mcp" ;;
    "") echo "session" ;;
    *) echo "other" ;;
  esac
}

# Log an event to the hook events file (optimized JSON building)
# Usage: log_event <event_type> [target] [tool] [decision] [error]
log_event() {
  local event_type="${1:-unknown}"
  local target="${2:-$(_get_target_type_fast "$HOOK_TOOL_NAME")}"
  local tool="${3:-$HOOK_TOOL_NAME}"
  local decision="${4:-}"
  local error="${5:-}"

  # Ensure directory exists (cache this check)
  [[ -d "${HOOK_EVENTS_FILE%/*}" ]] || mkdir -p "${HOOK_EVENTS_FILE%/*}"

  # Build JSON using printf (faster than string concatenation)
  local json
  printf -v json '{"ts":%s,"sid":"%s","pid":%s,"hook":"%s","event":"%s"' \
    "$HOOK_TIMESTAMP" \
    "$(_json_escape_fast "$HOOK_SESSION_ID")" \
    "$HOOK_CLAUDE_PID" \
    "$(_json_escape_fast "$HOOK_EVENT_NAME")" \
    "$(_json_escape_fast "$event_type")"

  # Append optional fields only if non-empty
  [[ -n "$target" ]] && json+=",\"target\":\"$(_json_escape_fast "$target")\""
  [[ -n "$tool" ]] && json+=",\"tool\":\"$(_json_escape_fast "$tool")\""
  [[ -n "$HOOK_TOOL_USE_ID" ]] && json+=",\"tuid\":\"$(_json_escape_fast "$HOOK_TOOL_USE_ID")\""
  [[ -n "$HOOK_AGENT_ID" ]] && json+=",\"agentId\":\"$(_json_escape_fast "$HOOK_AGENT_ID")\""
  [[ -n "$HOOK_AGENT_TYPE" ]] && json+=",\"agentType\":\"$(_json_escape_fast "$HOOK_AGENT_TYPE")\""

  # Outcome
  if [[ -n "$error" ]]; then
    json+=",\"ok\":false,\"err\":\"$(_json_escape_fast "$error")\""
  else
    json+=",\"ok\":true"
  fi

  [[ -n "$decision" ]] && json+=",\"decision\":\"$(_json_escape_fast "$decision")\""
  json+="}"

  # Append to log file with lock
  {
    flock -x 200
    printf '%s\n' "$json"
  } 200>"$HOOK_EVENTS_FILE.lock" >> "$HOOK_EVENTS_FILE"

  if [[ "$HOOK_DEBUG" == "true" ]]; then
    echo "[hook-lib] Logged: $json" >&2
  fi
}

# ============================================================================
# Hook Response Helpers (simplified)
# ============================================================================

respond_allow() {
  local reason="${1:-}"
  local context="${2:-}"

  if [[ -n "$reason" || -n "$context" ]]; then
    printf '{"hookSpecificOutput":{"hookEventName":"%s","permissionDecision":"allow"' "$HOOK_EVENT_NAME"
    [[ -n "$reason" ]] && printf ',"permissionDecisionReason":"%s"' "$(_json_escape_fast "$reason")"
    [[ -n "$context" ]] && printf ',"additionalContext":"%s"' "$(_json_escape_fast "$context")"
    printf '}}\n'
  fi
  exit 0
}

respond_block() {
  printf '{"hookSpecificOutput":{"hookEventName":"%s","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' \
    "$HOOK_EVENT_NAME" "$(_json_escape_fast "${1:-Blocked by hook}")"
  exit 0
}

respond_error() {
  echo "${1:-Hook error}" >&2
  exit 2
}

# ============================================================================
# Utility Functions
# ============================================================================

command_exists() { command -v "$1" &>/dev/null; }

require_jq() {
  command -v jq &>/dev/null || respond_error "jq is required but not installed"
}

# Convenience function to extract a single field from HOOK_INPUT
# Only use this for fields not extracted by init_hook
json_get() {
  printf '%s' "$HOOK_INPUT" | jq -r "${2} // empty" 2>/dev/null || echo ""
}
