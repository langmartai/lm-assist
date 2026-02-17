#!/bin/bash
# hook-event-logger.sh - High-performance hook event logger
#
# Optimized version that minimizes external command invocations:
# - Single jq call for all field extraction
# - Inline event type derivation (no function calls)
# - Minimal subshell usage
#
# Environment variables:
#   CLAUDE_HOOK_EVENTS_FILE - Override log file path (default: ~/.claude/hook-events.jsonl)
#   CLAUDE_HOOK_DEBUG=true  - Enable debug output

set -euo pipefail

# Source the shared library
SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
source "$SCRIPT_DIR/hook-lib.sh"

require_jq
init_hook

# ============================================================================
# Inline Event Type Derivation (avoids function call overhead)
# ============================================================================

case "$HOOK_EVENT_NAME" in
  SessionStart)
    # Need to extract source - single jq call only if needed
    _src=$(printf '%s' "$HOOK_INPUT" | jq -r '.source // "startup"' 2>/dev/null)
    EVENT_TYPE="session_start_${_src}"
    TARGET="session"
    ;;
  SessionEnd)
    _reason=$(printf '%s' "$HOOK_INPUT" | jq -r '.reason // "other"' 2>/dev/null)
    EVENT_TYPE="session_end_${_reason}"
    TARGET="session"
    ;;
  UserPromptSubmit)
    EVENT_TYPE="prompt_submit"
    TARGET="prompt"
    ;;
  PermissionRequest)
    EVENT_TYPE="perm_request"
    TARGET="${HOOK_TOOL_NAME:+$(_get_target_type_fast "$HOOK_TOOL_NAME")}"
    TARGET="${TARGET:-session}"
    ;;
  PreToolUse)
    EVENT_TYPE="tool_pre"
    TARGET="$(_get_target_type_fast "$HOOK_TOOL_NAME")"
    ;;
  PostToolUse)
    EVENT_TYPE="tool_success"
    TARGET="$(_get_target_type_fast "$HOOK_TOOL_NAME")"
    ;;
  PostToolUseFailure)
    EVENT_TYPE="tool_failure"
    TARGET="$(_get_target_type_fast "$HOOK_TOOL_NAME")"
    ERROR=$(printf '%s' "$HOOK_INPUT" | jq -r '.error // ""' 2>/dev/null)
    ;;
  Notification)
    _ntype=$(printf '%s' "$HOOK_INPUT" | jq -r '.notification_type // "unknown"' 2>/dev/null)
    EVENT_TYPE="notify_${_ntype}"
    TARGET="notification"
    ;;
  SubagentStart)
    EVENT_TYPE="agent_start"
    TARGET="agent"
    ;;
  SubagentStop)
    EVENT_TYPE="agent_stop"
    TARGET="agent"
    ;;
  Stop)
    EVENT_TYPE="stop"
    TARGET="session"
    ;;
  PreCompact)
    _trigger=$(printf '%s' "$HOOK_INPUT" | jq -r '.trigger // "auto"' 2>/dev/null)
    EVENT_TYPE="compact_${_trigger}"
    TARGET="session"
    ;;
  *)
    EVENT_TYPE="unknown"
    TARGET="session"
    ;;
esac

# Log the event
log_event "$EVENT_TYPE" "$TARGET" "$HOOK_TOOL_NAME" "" "${ERROR:-}"

# Debug output
if [[ "${CLAUDE_HOOK_DEBUG:-false}" == "true" ]]; then
  echo "[hook-event-logger] $EVENT_TYPE ($HOOK_EVENT_NAME)" >&2
fi

exit 0
