#!/bin/bash
# context-inject-hook.sh - Inject relevant context into Claude Code via UserPromptSubmit
#
# Called by Claude Code's UserPromptSubmit hook. Reads the prompt from stdin,
# calls the tier-agent API for context suggestions, and returns additionalContext
# that Claude sees before processing the prompt.
#
# Requirements:
#   - tier-agent API server running on localhost:3100 (or TIER_AGENT_PORT)
#   - jq installed
#   - curl installed
#
# Fail-safe: exits silently on any error (API down, timeout, etc.)

set -uo pipefail

# Log file
LOG_FILE="${HOME}/.lm-assist/logs/context-inject-hook.log"
mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

# Read hook input from stdin
INPUT=$(cat)

# Extract prompt and session ID (exit cleanly if jq fails)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // .user_prompt // empty' 2>/dev/null) || exit 0
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || true

# Skip empty prompts
if [ -z "$PROMPT" ]; then
  log "SKIP session=${SESSION_ID:-unknown} reason=empty_prompt"
  exit 0
fi

# Skip system/internal prompts (task notifications, subagent messages)
if echo "$PROMPT" | grep -qE '^<task-notification>|^<subagent-|^<system-'; then
  log "SKIP session=${SESSION_ID:-unknown} reason=system_prompt"
  exit 0
fi

# Full prompt for logging
PROMPT_PREVIEW="$PROMPT"

# Determine API port (supports worktree offsets)
API_PORT="${TIER_AGENT_PORT:-3100}"

log "START session=${SESSION_ID:-unknown} port=${API_PORT} prompt=\"${PROMPT_PREVIEW}\""

# --- Mode: "mcp" | "suggest" | "off" ---
# Reads from ~/.claude-code-config.json (contextInjectMode), falls back to
# CONTEXT_INJECT_MODE env var, then defaults to "mcp"
CONFIG_FILE="${HOME}/.claude-code-config.json"
INJECT_MODE="mcp"
if [ -f "$CONFIG_FILE" ] && command -v jq &>/dev/null; then
  CONFIG_VAL=$(jq -r '.contextInjectMode // empty' "$CONFIG_FILE" 2>/dev/null)
  if [ -n "$CONFIG_VAL" ]; then
    INJECT_MODE="$CONFIG_VAL"
  fi
fi
INJECT_MODE="${CONTEXT_INJECT_MODE:-$INJECT_MODE}"

# Off mode: skip all injection
if [ "$INJECT_MODE" = "off" ]; then
  log "SKIP session=${SESSION_ID:-unknown} reason=mode_off"
  exit 0
fi

# Read which sources to include (knowledge, milestones)
INCLUDE_KNOWLEDGE="true"
INCLUDE_MILESTONES="false"
EXPERIMENT_ENABLED="false"

# Check milestone settings file for experiment (enabled) flag — default OFF if file absent
MILESTONE_SETTINGS_FILE="${HOME}/.lm-assist/milestone/settings.json"
if [ -f "$MILESTONE_SETTINGS_FILE" ] && command -v jq &>/dev/null; then
  EXP_VAL=$(jq -r '.enabled // "false"' "$MILESTONE_SETTINGS_FILE" 2>/dev/null)
  [ "$EXP_VAL" = "true" ] && EXPERIMENT_ENABLED="true"
fi

if [ -f "$CONFIG_FILE" ] && command -v jq &>/dev/null; then
  K_VAL=$(jq -r '.contextInjectKnowledge // empty' "$CONFIG_FILE" 2>/dev/null)
  M_VAL=$(jq -r '.contextInjectMilestones // empty' "$CONFIG_FILE" 2>/dev/null)
  [ "$K_VAL" = "false" ] && INCLUDE_KNOWLEDGE="false"
  # Milestones only included when both the setting is on AND experiment is enabled
  [ "$M_VAL" = "true" ] && [ "$EXPERIMENT_ENABLED" = "true" ] && INCLUDE_MILESTONES="true"
fi

# Build MCP search type filter based on enabled sources
MCP_TYPES=""
[ "$INCLUDE_KNOWLEDGE" = "true" ] && MCP_TYPES="${MCP_TYPES}knowledge, "
[ "$INCLUDE_MILESTONES" = "true" ] && MCP_TYPES="${MCP_TYPES}milestones, "
[ "$EXPERIMENT_ENABLED" = "true" ] && MCP_TYPES="${MCP_TYPES}architecture, "
# Strip trailing comma+space
MCP_TYPES="${MCP_TYPES%, }"
# Fallback if nothing enabled
[ -z "$MCP_TYPES" ] && MCP_TYPES="knowledge"

MCP_INSTRUCTION="Before responding, use MCP tools to retrieve relevant context:
1. search(\"${PROMPT:0:100}\") — find top 5 matching ${MCP_TYPES} entries
2. For any highly relevant results, use detail(id) to expand the full content
3. Use this retrieved context to inform your response
4. If any retrieved context is outdated or wrong, use feedback(id, type, content) to flag it"

if [ "$INJECT_MODE" = "mcp" ]; then
  log "INJECT-MCP session=${SESSION_ID:-unknown}"
  echo "$MCP_INSTRUCTION" >> "$LOG_FILE"
  jq -n --arg ctx "$MCP_INSTRUCTION" '{
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: $ctx
    }
  }'
  exit 0
fi

# --- "suggest" mode: call API for context suggestions (original behavior) ---

# Escape the prompt for JSON embedding — use jq for safe escaping
JSON_BODY=$(jq -n \
  --arg prompt "$PROMPT" \
  --arg sessionId "$SESSION_ID" \
  '{prompt: $prompt, sessionId: $sessionId}')

# Call tier-agent API for context suggestions (5 second timeout)
HTTP_CODE=$(curl -s --max-time 5 -o /tmp/context-inject-response.json -w '%{http_code}' \
  -X POST "http://localhost:${API_PORT}/context/suggest" \
  -H "Content-Type: application/json" \
  -d "$JSON_BODY" 2>/dev/null) || {
  log "FAIL session=${SESSION_ID:-unknown} reason=connection_error (curl exit=$?)"
  exit 0
}

if [ "$HTTP_CODE" != "200" ]; then
  BODY=$(cat /tmp/context-inject-response.json 2>/dev/null | head -c 200)
  log "FAIL session=${SESSION_ID:-unknown} reason=http_${HTTP_CODE} body=${BODY}"
  exit 0
fi

RESPONSE=$(cat /tmp/context-inject-response.json)

# Extract context from response
CONTEXT=$(echo "$RESPONSE" | jq -r '.context // empty' 2>/dev/null)
SOURCES=$(echo "$RESPONSE" | jq -r '.sources // [] | join(", ")' 2>/dev/null)
TOKENS=$(echo "$RESPONSE" | jq -r '.tokens // 0' 2>/dev/null)

# Output mode: "stdout" shows context visibly in transcript, "quiet" injects silently
# Reads from ~/.claude-code-config.json (contextInjectDisplay), falls back to
# CONTEXT_INJECT_MODE env var, then defaults to "stdout"
DISPLAY_MODE="stdout"
if [ -f "$CONFIG_FILE" ] && command -v jq &>/dev/null; then
  DISPLAY_VAL=$(jq -r '.contextInjectDisplay // empty' "$CONFIG_FILE" 2>/dev/null)
  if [ "$DISPLAY_VAL" = "false" ]; then
    DISPLAY_MODE="quiet"
  fi
fi

# Only inject if we got meaningful context
if [ -n "$CONTEXT" ] && [ "$CONTEXT" != "null" ]; then
  log "INJECT session=${SESSION_ID:-unknown} tokens=${TOKENS} sources=[${SOURCES}] mode=${DISPLAY_MODE}"
  echo "$CONTEXT" >> "$LOG_FILE"

  # In "both" mode, append MCP instruction after suggested context
  if [ "$INJECT_MODE" = "both" ]; then
    CONTEXT="${CONTEXT}
${MCP_INSTRUCTION}"
    log "INJECT-BOTH session=${SESSION_ID:-unknown} tokens=${TOKENS} sources=[${SOURCES}]"
  fi

  if [ "$DISPLAY_MODE" = "stdout" ]; then
    log "display=stdout sources=[${SOURCES}] tokens=${TOKENS}"
  fi
  jq -n --arg ctx "$CONTEXT" '{
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: $ctx
    }
  }'
else
  # No suggestion context, but in "both" mode still inject MCP instruction
  if [ "$INJECT_MODE" = "both" ]; then
    log "INJECT-MCP session=${SESSION_ID:-unknown} (no suggest context)"
    jq -n --arg ctx "$MCP_INSTRUCTION" '{
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: $ctx
      }
    }'
  else
    log "EMPTY session=${SESSION_ID:-unknown} reason=no_matching_context"
  fi
fi
