# Bug: Subagent/Sidechain Messages Not Visible in Web Session Viewer

**Created:** 2026-03-16
**Status:** Fixed (0.1.61)
**Severity:** Medium — data exists in JSONL but was invisible to users

## Problem

When viewing a session in the web UI at `http://localhost:3848/sessions?session=<id>`, messages from Claude Code subagents (spawned by the `Agent` tool with `run_in_background: true`) were not displayed.

These messages exist in separate `agent-*.jsonl` files and the parent session's JSONL contains the invocation records. The API was returning empty `agentId` values for subagent invocations, preventing the web UI from linking invocations to their agent files.

## Root Causes Found

### 1. Empty `agentId` in subagent invocations

The session parser created subagent invocations with `agentId: ''` when it encountered Agent/Task tool calls, then tried to populate agentId from `agent_progress` messages. But `agent_progress` messages are **not always present** — they depend on the Claude Code version and execution mode.

The agentId **is** available in the Agent tool_result text content:
```
Async agent launched successfully.
agentId: a14dad1 (This is an internal ID...)
```

But neither `session-cache.ts` nor `agent-session-store.ts` extracted it from there.

### 2. Agent files with long first lines not found

`getAgentParentSessionId()` read only 2048 bytes and `getAgentFirstLineData()` read only 4096 bytes of agent files. Both tried to `JSON.parse()` the first line. Agent files can have first lines exceeding 4600 bytes (when they include system prompts), causing JSON parse failure and the agent being silently skipped.

### 3. Missing `parentUuid` on invocations

The `parentUuid` field was never set on subagent invocations during parsing. This prevented the web UI from falling back to UUID-based positioning when agentId-based position mapping wasn't available.

## Fixes Applied

### `core/src/session-cache.ts`
- Extract agentId from Agent tool_result text via regex (`/agentId:\s*([a-f0-9]+)/`)
- Set `parentUuid` from assistant message uuid on subagent creation

### `core/src/agent-session-store.ts`
- Extract agentId from Agent tool_result text in `parseSessionMessages()` (same regex)
- Set `parentUuid` from assistant message uuid on subagent invocation creation
- `getAgentFirstLineData()`: Increase buffer to 16KB, add regex fallback for truncated JSON
- `getAgentParentSessionId()`: Use regex extraction instead of `JSON.parse()` — works even with truncated content

## Verification

Before fix:
- `/sessions/:id` → subagents: 3, all with `agentId=""`
- `/sessions/:id/subagents` → sessions: 4, invocations: 3 with `agentId=""`
- Web UI: no agent conversations visible

After fix:
- `/sessions/:id` → subagents: 3, all with populated agentId and parentUuid
- `/sessions/:id/subagents` → sessions: 6 (found 2 more via buffer fix), invocations: 3 with agentId populated
- Web UI: agent conversations properly linked and positioned
