# Microcompact & API Context Management

Source: `services/compact/microCompact.ts`, `services/compact/apiMicrocompact.ts`, `services/compact/timeBasedMCConfig.ts`

## Time-Based Microcompact (Client-Side)

Runs between turns. Replaces old tool results in the in-memory message array with `"[Old tool result content cleared]"`.

**Compactable tools**: Read, Bash, PowerShell, Grep, Glob, WebSearch, WebFetch, Edit, Write

**Algorithm**:
1. Walk messages from oldest to newest
2. For each tool result from a compactable tool older than the keep threshold:
   - Replace content with cleared message
   - For images: estimate ~2000 tokens each
3. Keep the N most recent results untouched

This modifies messages in-place — the JSONL on disk is unchanged. The API never sees the cleared content.

## API Context Management (Server-Side)

Sent in the request body as `context_management` field (requires `context-management-2025-06-27` beta):

```typescript
context_management: {
  edits: [
    // Thinking block management
    {
      type: "clear_thinking_20251015",
      keep: "all"                    // preserve all thinking
      // or: { type: "thinking_turns", value: 1 }  // keep last N
    },
    // Tool result clearing (ant-only, env-gated)
    {
      type: "clear_tool_uses_20250919",
      trigger: {
        type: "input_tokens",
        value: 180_000               // only activate above this
      },
      keep: {
        type: "tool_uses",
        value: N                     // keep last N results
      },
      clear_tool_inputs: ["Edit", "Write", "NotebookEdit"],  // clear inputs too
      exclude_tools: [...],          // don't clear these
      clear_at_least: {
        type: "input_tokens",
        value: 40_000               // minimum tokens to free
      }
    }
  ]
}
```

**Thinking clear logic**:
- When thinking enabled AND not redact-thinking: keep all
- When idle >1h (cache miss anyway): `{ type: "thinking_turns", value: 1 }` — clear all but last
- When redact-thinking active: skip entirely (redacted blocks are empty)

## Cached Microcompact (ant-only, `CACHED_MICROCOMPACT` feature)

Instead of clearing content client-side (which busts the prompt cache), generates `cache_edits` blocks in the request body. These tell the API to delete content at specific cached positions without changing the cache key.

**States**:
- `pendingCacheEdits` — new edits to include in next request
- `pinnedCacheEdits` — previously-sent edits that must be re-sent at original positions for cache hits
- `consumePendingCacheEdits()` — consumes and clears pending state
- `getPinnedCacheEdits()` — returns all pinned edits

Requires the cache editing beta header (dynamically assigned, latched per-session).

## Configuration

Time-based MC config from GrowthBook (`tengu_time_mc_config`):
```typescript
{
  enabled: boolean,
  keepRecent: number,           // keep last N results
  supportedModels: string[],    // model patterns to apply to
  systemPromptSuggestSummaries: boolean  // add FRC section to prompt
}
```

System prompt section when enabled:
```
# Function Result Clearing
Old tool results will be automatically cleared from context to free up space.
The {keepRecent} most recent results are always kept.
```

## Compact Warning State

Separate from actual compaction — manages the UI warning indicator:
- `suppressCompactWarning()` — hide after user sees it
- `clearCompactWarningSuppression()` — re-show on next threshold cross
- Tied to prompt cache break detection for analytics
