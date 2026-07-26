# Capping MCP tool-result size — one call must never kill a conversation

**Backlog:** `bl_5cc4bad9` · **Date:** 2026-07-26 · **Paired audit:** `mission_8bc12731`

## The problem, measured

A 110-message conversation stopped accepting input. Its visible text was only 44,123 chars —
the user had barely typed — but the payload was 3.00 MB, 84% of it `tool_result`. ONE
`mission_list` result was 1,757 KB, 58% of the entire thread. The stream's `message_limit`
event said `within_limit` (5h 0.27 / 7d 0.49), so this was never a usage limit: the thread
simply no longer fit.

Re-measured live on node 117 prod (`POST :3100/mcp`, content bytes) **before** the fix:

| tool | bytes | ≈ tokens @4 chars |
|---|---:|---:|
| `claudeai_list_plugins` | 1,156,396 | ~321K |
| `mission_query` | 960,675 | ~240K |
| `data_query` | ~940 KB | ~268K |
| `mission_list` | 923,758 | ~231K |
| `memory_map` | 827,724 | ~230K |
| `bootstrap` | 55,572 | ~14K |
| `cc_sessions` | 52,379 | ~13K |
| `backlog_list` | 19,718 | ~5K |

**Each of the top five exceeds a 200K-token context window in a single call.** This is not a
cost problem, it is a liveness problem: the call cannot fit, and the user loses the thread.

## Design

### 1. A hard ceiling at the one seam both surfaces share

`configureMcpServer` (`core/src/mcp-server/configure.ts`) registers the `CallTool` handler for
**both** transports — stdio (`mcp-server/index.ts`) and StreamableHTTP (`routes/core/mcp.routes.ts`).
Capping there covers every built-in tool, every third-party `ext__<plugin>__<tool>`, and anything
added later, with no per-tool opt-in to forget.

`core/src/mcp-server/result-cap.ts` is a pure module: `capToolResult(result, toolName, limit)`.

Load-bearing details:

- **Ordering.** The cap runs *before* `withOriginTag`, so the footer — which carries the
  truncation warning and the size — can never itself be the thing cut off.
- **Errors are capped too.** `withOriginTag` deliberately skips error results; the cap does not.
  An error echoing a huge payload kills a conversation exactly like a success does.
- **Truncation is always explicit.** A silent cut is worse than the overflow, because a model
  reads a truncated list as a *complete* list. The marker states the original size, the bytes
  dropped, the percentage, that the cut may land mid-record, and how to get the rest.
- **UTF-8 safe.** `sliceUtf8` walks back off continuation bytes so a cut never severs a codepoint.
- **Text only.** Image/base64 blocks are measured and reported but never sliced — a truncated
  base64 payload is not a smaller image, it is a corrupt one. Oversized images need downscaling
  at the source; recorded as follow-up.

### 2. Why 64 KiB

`DEFAULT_MAX_RESULT_BYTES = 65_536`, override `MCP_RESULT_MAX_BYTES`.

- The largest **by-design** result is `bootstrap` at 55,572 bytes — it deliberately loads every
  use case in one call. 64 KiB clears it with ~15% headroom, so the default truncates nothing
  that is meant to be big.
- ~16K tokens ≈ 8% of a 200K window, so a dozen worst-case results still leave a usable
  conversation, where **one** uncapped `mission_list` did not.
- It is a 14x cut on the result that caused the incident.

**This supersedes the paired audit's proposed 50 KB hard cap.** 50 KB sits *below* `bootstrap`
(54.3 KB), so it would truncate session onboarding on every fresh connect. The audit's 25 KB
**soft** budget remains useful as an advisory target for its regression guard — a different job,
no conflict. One hard number, and it is this one.

A malformed or dangerously small `MCP_RESULT_MAX_BYTES` falls back to the default rather than
weakening the guard; below `MIN_MAX_RESULT_BYTES` (2 KiB) the marker could not fit, which would
reintroduce the silent cut.

### 3. Fixing the offenders at source

The ceiling makes an oversized result survivable; projections make it unnecessary. Applied in the
**MCP tool layer**, not the REST routes — the web UI consumes `/mission`, `/mission/query` and
`/terminal/cc-sessions` directly, so changing routes would risk the UI for no benefit. Only LLM
callers reach these tools.

The audit established the offenders need **three different remedies**:

| remedy | tools | status |
|---|---|---|
| **Projection** | `mission_list`, `mission_query`, `claudeai_list_plugins` | done |
| **Pagination + narrower default scope** | `memory_map` | done (default `limit` 80) |
| **Row cap in the owning service** | `data_query` | follow-up — datasets are user-extensible, so no per-tool number is right. Protected by the ceiling meanwhile. |

Field breakdown for `mission_list` (measured, 50 missions, 927,614 B): `history` **54.6%**,
`objective` 20.1%, `results` 9.8% — 84.5% between them. `history` is the compounding term: a
*list* view was returning every mission's full revision history (401 revs across 50 missions),
and revs only accumulate, so per-mission cost grows even if mission count does not.

**Rule:** a LIST or WRITE result never carries per-record revision history. That is what the
history endpoints are for, and they already take a limit.

`missionSummary` keeps identity, state, and everything placement needs (`dependsOn`, `binding`,
`env.host`) plus a 200-char `objectivePreview` — a list with no hint of what each mission is
*for* is barely a list — and reports what it dropped in `omitted`, so a caller never concludes a
mission has no results because none were shown.

`claudeai_list_plugins`: `skills` alone was 82.3% of 1,129 KB; capability arrays collapse to a
`provides` count map.

Writes were fat for the same reason: `backlog_create` measured 63 KB because the **idempotent**
path echoes the resolved item's whole accumulated `discussion[]`/`reviews[]` — the more an item
is discussed, the more it costs to touch. Every backlog write now returns a compact echo.

**`detail:"full"` restores whole objects everywhere.** The Mission Controller depends on reading
full missions; a guardrail that removed the capability would just be moved out of the way later.
Full mode pages smaller (5 vs 50) because a full mission is ~20 KB. An unrecognised `detail`
value fails **safe** (summary) — guessing "full" from a typo would reopen the hole.

### 4. Surfacing the size

The result footer now carries the byte count (`· 4.2KB`, or `· ⚠ 902.1KB→64.0KB TRUNCATED`).
Nothing in a result ever said how big it was, which is why the incident was only discoverable by
a human reading a dead conversation.

`mcp-calls.jsonl` records `resultBytes` / `keptBytes` / `truncated`, making offenders findable by
query instead of by autopsy. This replaces the optional per-conversation cumulative warning: there
is no reliable conversation key on this path, and `mcp-session-resolver` is documented as
latency-sensitive, so adding a store sweep there would be the wrong trade.

## Testing

`core/src/__tests__/mcp-result-cap.test.ts` (15) and `mcp-result-projections.test.ts` (15). Every
test mutation-verified: cap made a no-op → 5 fail; seam stops calling the cap → 4 fail; restored →
30/30 green. One test pins that **both** surface entry files route through `configureMcpServer`,
which is what makes the guarantee fleet-wide — without it a future surface could dispatch
uncapped while every other test still passed.

## Known follow-ups

- `data_query` row cap belongs in the data service.
- Oversized image blocks need downscaling at source, not truncation.
- `tools/list` is 347 KB for 244 definitions — a fixed connect-time tax, outside the per-result
  ceiling but competing for the same budget.
- `memory_map`'s `recordId` is 21.6% of its payload; a shorter id form is free savings.
