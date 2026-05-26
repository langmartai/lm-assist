---
name: llm-event-emit
description: Emit a typed event into the LLM-native event store. Use when something noteworthy happens in a session — a tool failed, a piece of context was learned, a state change occurred. Provide the event type, source kind + id (usually the current session), and optional props.
allowed-tools: Bash
---

# Emit an LLM-native event

This skill records an event into the LLM-native event store via the
`ler event llm-emit` CLI. The store keeps it as a typed, audited,
source-attached record that other agents and scripts can query.

## When to use this skill

Call this skill when something noteworthy happens in the current
session and you want it visible to other tools, agents, or dashboards.
Examples:

- A tool failed in a notable way
- A piece of context was learned that future sessions should know about
- An external system reported a state change
- A custom domain event (e.g. "user-asked-about-X", "summary-completed")

If the event is already emitted automatically by the watcher (turn
arrivals, idle/timeout monitors), you do NOT need to call this skill —
the watcher handles those. Use this skill for events the watcher does
not generate.

## Required inputs

- `type` — one of the seeded built-in event types (`session-turn`,
  `session-lifecycle`, `tool-call`, `attachment-added`, `session-idle`,
  `session-timeout`) OR any custom type you want to register on first
  use.
- `source-kind` — `claude-code-session`, `claude-ai-conversation`, or
  `claude-api-call`.
- `source-id` — the session UUID. For Claude Code agents, this is the
  value of `$CLAUDE_CODE_SESSION_ID`.
- `props` — JSON object satisfying the event-type's declared
  `field_schema`. To check the required and optional fields for a type,
  run `ler type get <type>` first.

## Optional inputs

- `turn-index` — required for turn-anchored types (`session-turn`,
  `tool-call`, `attachment-added`).
- `content` — full body text. Only include if the event should be
  self-contained (default is reference-only).
- `uid` — stable deduplication key. If you emit the same uid twice,
  the second call is a no-op and returns `was_duplicate: true`.
- `occurred-at` — ISO 8601 timestamp. Defaults to now.
- `intent` — label for this call's purpose (e.g. `llm-native:agent-emit`).
- `reason` — human-readable explanation for why this event is being
  emitted (useful for audit logs).

## Invocation

```bash
ler event llm-emit \
  --type "tool-call" \
  --source-kind "claude-code-session" \
  --source-id "$CLAUDE_CODE_SESSION_ID" \
  --turn-index 7 \
  --props '{"tool_name":"Bash","tool_use_id":"tu_abc","phase":"failed","source_kind":"claude-code-session","source_id":"'"$CLAUDE_CODE_SESSION_ID"'","turn_index":7,"is_error":true}' \
  --session-id "$CLAUDE_CODE_SESSION_ID" \
  --intent "llm-native:agent-emit"
```

On success the CLI prints JSON on stdout:

```json
{
  "event_id": 42,
  "uid": "tool:tu_abc:failed",
  "source_id": 7,
  "was_duplicate": false
}
```

`was_duplicate: true` means an event with the same uid already existed.
The CLI returns the existing record's id and treats it as a no-op
success — safe to ignore.

## Discovering the type schema

If you don't know what fields a type requires:

```bash
ler type get <type>
```

This returns the type row including the declared `field_schema` JSON.
Use that to construct your `--props` argument.

## Custom event types

If you want to emit an event of a NEW type the catalog has never seen,
just call the CLI with that type. It auto-registers on first use (the
type lands in the pending-review queue but the write succeeds). For
recurring custom types, register the type once via `ler type review`
to lock down its schema.

## Checking if ler is available

```bash
which ler || (cd /path/to/lm-event-resolution && node bin/ler.js --help)
```

If `ler` is not on PATH, invoke it directly as `node /path/to/lm-event-resolution/bin/ler.js event llm-emit ...` with the same flags.
