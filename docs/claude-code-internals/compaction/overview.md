# Compaction Architecture — Overview

Source: `services/compact/` (11 files)

## The 5-Layer Context Management System

From least to most aggressive:

### Layer 0: API Context Management (server-side)
- `context_management: { edits: [...] }` in request body
- Requires `context-management-2025-06-27` beta
- Clears old thinking blocks + tool results server-side
- Zero client-side cost
- Thinking: `clear_thinking_20251015` — keep 'all' or last N turns
- Tools (ant-only): `clear_tool_uses_20250919` — trigger at 180K tokens, keep last N, clear at least 40K

### Layer 1: Time-Based Microcompact (client-side)
- Between turns, replaces old tool results with `"[Old tool result content cleared]"`
- Compactable tools: Read, Bash, PowerShell, Grep, Glob, WebSearch, WebFetch, Edit, Write
- Keeps configurable number of recent results
- **Cached MC** (ant-only): generates `cache_edits` blocks instead, preserving prompt cache

### Layer 2: Session Memory Compact (experimental)
- Uses pre-computed `summary.md` as substitute for LLM summarization
- Drops old messages, keeps configurable tail (10K-40K tokens, min 5 text-block messages)
- Zero API calls — instant
- Tried BEFORE full compact in `autoCompactIfNeeded()`

### Layer 3: Full Compact (proactive auto or manual /compact)
- Summarizes ALL messages via LLM call
- Writes `compact_boundary` marker to JSONL
- See `full-compact.md` for details

### Layer 4: Reactive Compact (on API 413)
- Triggered by `prompt_too_long` error during normal query
- Peels messages from oldest end until token gap is covered
- Falls back to dropping 20% of API-round groups if gap unparseable
- Runs full compact on reduced set, retries original query

### Layer 5: Context Collapse ("marble-origami", ant-only)
- Feature-gated behind `CONTEXT_COLLAPSE`
- Granular archiving of conversation segments with summaries
- 90% context → commit starts; 95% → blocking spawn
- Replaces auto-compact entirely when active
- Persisted via `marble-origami-commit` and `marble-origami-snapshot` JSONL entries

## Trigger Thresholds

```
effectiveContextWindow = contextWindow - min(maxOutputTokens, 20_000)
autoCompactThreshold = effectiveContextWindow - 13_000
warningThreshold = threshold - 20_000
errorThreshold = threshold - 20_000
blockingLimit = effectiveContextWindow - 3_000
```

Override: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (percentage), `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (absolute tokens).

## Circuit Breaker

After 3 consecutive auto-compact failures → skip for rest of session. Prevents hammering API with doomed attempts (observed: up to 3,272 consecutive failures in production, ~250K wasted API calls/day).
