# MCP tool output-size audit — all 244 tools

**Measured 2026-07-26** on node 117 (`linux-117`), prod Core `:3100`, against live
fleet data: 50 missions, 1,313 memory records, 92 claude.ai plugins, 55 sessions,
59 workflow docs, 245 change revs, 22 backlog items, 13,628 session JSONL files.

Companion to `mission_f4055461`, which builds the per-result byte ceiling. That
mission builds the guardrail; this one finds every tool that would hit it. The
early offender handoff is [`mcp-output-size-offenders.md`](./mcp-output-size-offenders.md).

## Why this exists

On 2026-07-25 a single `mission_list` call returned 1,757 KB and consumed 58% of a
live 110-message conversation, leaving it permanently unable to accept input. The
user-visible text in that entire conversation was ~44,123 chars (~12k tokens) — the
conversation was killed almost entirely by one tool result. Nobody knew that tool
could do that until it happened.

So the question this audit answers is not "is `mission_list` too big" but **"which
tool is the next one, and how would we know before a conversation dies?"**

---

## 1. Headline findings

**Three tools are larger than the one that caused the incident, and none of them
were on anyone's list.**

| tool | measured | ≈tokens | status before this audit |
|---|---|---|---|
| `claudeai_list_plugins` | 1,129 KB | ~321k | never suspected |
| `mission_query` | 941 KB | ~268k | listed at 168 KB; grew 5.6× |
| `data_query` | 940 KB | ~268k | never suspected |
| `mission_list` | 905 KB | ~257k | the known offender |
| `memory_map` | 808 KB | ~230k | never suspected |

Each of these **exceeds a 200k-token context window in a single call.** They are
not "usually fine, occasionally large" — at current fleet size they are
individually unsurvivable.

**43 of the 70 measured tools have no output bound whatsoever.** Exactly one tool
on the entire native surface is paginated (`detail`); two have hard limits. The
distribution:

| what bounds it | tools | share |
|---|---|---|
| **NOTHING** — serialises a whole collection | **43** | 61% |
| `SMALL_BY_CONSTRUCTION` — returns a scalar/ack | 16 | 23% |
| `CALLER_LIMIT_SANE_DEFAULT` | 8 | 11% |
| `HARD_LIMIT` | 2 | 3% |
| `PAGINATED` | **1** | 1% |

Most of the 43 are small today only because the fleet is small. That is the real
finding: the surface has essentially no bounding *discipline*, and 52 tools are
marked SAFE on the strength of today's data rather than any structural guarantee.

**The incident's own numbers no longer reproduce**, and that is a finding rather
than a contradiction: `mission_list` measured 905 KB today against 1,757 KB then,
while `mission_query` went the other way, 168 KB → 941 KB. These results track
live fleet state, so a number captured once is not a bound. `mission_list` grew
~6 KB *during this audit session* as missions accumulated.

**The third-party plugin surface is the best-protected one, not the worst.** The
intuition going in was that `ext__<plugin>__<tool>` was the least-controlled
surface because the tool bodies live outside this repo. The opposite is true: the
aggregator hard-caps every plugin result at 1 MiB and replaces an over-cap result
with a 4 KiB excerpt plus an explicit notice. It is the only surface on the
server with a universal cap. See §5.

---

## 2. Ranked table — 70 empirically measured read-only tools

`measured` is result **text bytes** — the concatenated text of the MCP `content`
blocks, i.e. what actually lands in a conversation's context. Token estimates use
~3.6 bytes/token, realistic for these JSON-shaped payloads.

| tool | measured | ~tokens | bound | verdict |
|---|---|---|---|---|
| `claudeai_list_plugins` | 1128.9 KB | ~321k | **NOTHING** | NEEDS-SUMMARY |
| `mission_query` | 938.5 KB | ~267k | **NOTHING** | NEEDS-SUMMARY |
| `data_query` | 937.9 KB | ~267k | **NOTHING** | NEEDS-SUMMARY |
| `mission_list` | 902.3 KB | ~257k | **NOTHING** | NEEDS-SUMMARY |
| `memory_map` | 806.6 KB | ~229k | **NOTHING** | NEEDS-SUMMARY |
| `mission_workflow_list` | 113.8 KB | ~32k | **NOTHING** | NEEDS-SUMMARY |
| `mission_changes` | 112.3 KB | ~32k | **NOTHING** | NEEDS-SUMMARY |
| `fs_read` | 64.5 KB | ~18k | CALLER_LIMIT_SANE_DEFAULT | NEEDS-CAP |
| `bootstrap` | 54.3 KB | ~15k | **NOTHING** | NEEDS-CAP |
| `data_keys` | 53.9 KB | ~15k | **NOTHING** | NEEDS-SUMMARY |
| `cc_sessions` | 51.1 KB | ~15k | **NOTHING** | NEEDS-SUMMARY |
| `windows_terminal_list` | 51.1 KB | ~15k | **NOTHING** | NEEDS-SUMMARY |
| `mission_graph` | 41.8 KB | ~12k | **NOTHING** | NEEDS-CAP |
| `ccr_cloud_list` | 40.5 KB | ~12k | **NOTHING** | NEEDS-CAP |
| `mission_neighbors` | 25.7 KB | ~7k | CALLER_LIMIT_SANE_DEFAULT | NEEDS-CAP |
| `backlog_list` | 19.2 KB | ~5k | **NOTHING** | NEEDS-CAP |
| `session_footprints` | 17.7 KB | ~5k | **NOTHING** | NEEDS-CAP |
| `memory_file` | 16.1 KB | ~5k | **NOTHING** | NEEDS-CAP |
| `mission_history` | 13.4 KB | ~4k | CALLER_LIMIT_SANE_DEFAULT | SAFE |
| `backlog_graph` | 10.4 KB | ~3k | **NOTHING** | SAFE |
| `list_session_messages` | 9.3 KB | ~3k | **NOTHING** | SAFE |
| `terminal_list` | 8.8 KB | ~3k | **NOTHING** | SAFE |
| `machine_access` | 6.2 KB | ~2k | **NOTHING** | SAFE |
| `terminal_capture` | 6.2 KB | ~2k | HARD_LIMIT | SAFE |
| `backlog_get` | 5.7 KB | ~2k | **NOTHING** | SAFE |
| `mission_control_status` | 5.4 KB | ~2k | SMALL_BY_CONSTRUCTION | SAFE |
| `mission_workflow_get` | 5.1 KB | ~1k | **NOTHING** | SAFE |
| `memory_projects` | 5.0 KB | ~1k | **NOTHING** | SAFE |
| `guide` | 5.0 KB | ~1k | HARD_LIMIT | SAFE |
| `data_catalog` | 4.5 KB | ~1k | **NOTHING** | SAFE |
| `search_memory` | 4.2 KB | ~1k | CALLER_LIMIT_SANE_DEFAULT | SAFE |
| `list_projects` | 4.0 KB | ~1k | **NOTHING** | SAFE |
| `rule_sync_status` | 3.8 KB | ~1k | **NOTHING** | SAFE |
| `ccr_remote_list` | 3.3 KB | ~1k | **NOTHING** | SAFE |
| `memory_sync_status` | 3.1 KB | ~1k | **NOTHING** | SAFE |
| `scheduler_jobs` | 2.9 KB | ~1k | SMALL_BY_CONSTRUCTION | SAFE |
| `rule_map` | 2.3 KB | ~1k | **NOTHING** | SAFE |
| `mission_sessions` | 2.1 KB | ~1k | **NOTHING** | SAFE |
| `list_recent_sessions` | 2.1 KB | ~1k | CALLER_LIMIT_SANE_DEFAULT | SAFE |
| `session_status` | 2.1 KB | ~1k | SMALL_BY_CONSTRUCTION | SAFE |
| `search` | 1.8 KB | ~1k | CALLER_LIMIT_SANE_DEFAULT | SAFE |
| `cluster_list` | 1.2 KB | <1k | SMALL_BY_CONSTRUCTION | SAFE |
| `list_claudeai_connectors` | 1.2 KB | <1k | **NOTHING** | SAFE |
| `bus_topics` | 1.1 KB | <1k | **NOTHING** | SAFE |
| `claudeai_list_marketplaces` | 1.1 KB | <1k | **NOTHING** | SAFE |
| `detail` | 1.1 KB | <1k | PAGINATED | SAFE |
| `claudeai_active_sessions` | 1000 B | <1k | **NOTHING** | SAFE |
| `list_nodes` | 800 B | <1k | **NOTHING** | SAFE |
| `mission_workflow_history` | 800 B | <1k | CALLER_LIMIT_SANE_DEFAULT | SAFE |
| `stall_status` | 600 B | <1k | SMALL_BY_CONSTRUCTION | SAFE |
| `claudeai_account` | 600 B | <1k | SMALL_BY_CONSTRUCTION | SAFE |
| `session_dag` | 600 B | <1k | **NOTHING** | SAFE |
| `list_port_forwards` | 500 B | <1k | **NOTHING** | SAFE |
| `rule_projects` | 500 B | <1k | **NOTHING** | SAFE |
| `auth_status` | 500 B | <1k | SMALL_BY_CONSTRUCTION | SAFE |
| `claude_code_account` | 500 B | <1k | SMALL_BY_CONSTRUCTION | SAFE |
| `whatsapp_status` | 400 B | <1k | SMALL_BY_CONSTRUCTION | SAFE |
| `claude_code_usage` | 400 B | <1k | SMALL_BY_CONSTRUCTION | SAFE |
| `node_status` | 400 B | <1k | SMALL_BY_CONSTRUCTION | SAFE |
| `data_sync_status` | 300 B | <1k | SMALL_BY_CONSTRUCTION | SAFE |
| `fs_drives` | 300 B | <1k | SMALL_BY_CONSTRUCTION | SAFE |
| `elevated_status` | 300 B | <1k | SMALL_BY_CONSTRUCTION | SAFE |
| `transfer_stats` | 200 B | <1k | SMALL_BY_CONSTRUCTION | SAFE |
| `node_builds` | 200 B | <1k | **NOTHING** | SAFE |
| `port_forward_stats` | 200 B | <1k | SMALL_BY_CONSTRUCTION | SAFE |
| `rule_import_candidates` | 200 B | <1k | **NOTHING** | SAFE |
| `list_executions` | 200 B | <1k | **NOTHING** | SAFE |
| `list_workers` | 200 B | <1k | **NOTHING** | SAFE |
| `mission_view_list` | 200 B | <1k | **NOTHING** | SAFE |
| `data_search` | 200 B | <1k | CALLER_LIMIT_SANE_DEFAULT | SAFE |

The machine-readable version of this table, with per-tool budgets and notes, is
`core/src/mcp-server/tool-output-budget.ts` — it is what the standing guard reads.

---

## 3. Growth projection

Per-record cost, obtained by dividing each payload by the records in it. This is
the number that matters, because today's byte count is an accident of today's
fleet:

| tool | B/record | records now | now | at 5× | at 10× |
|---|---|---|---|---|---|
| `mission_query` | 19,216 | 50 missions | 941 KB | 4.6 MB | 9.2 MB |
| `mission_list` | 18,483 | 50 missions | 905 KB | 4.4 MB | 8.8 MB |
| `claudeai_list_plugins` | 12,558 | 92 plugins | 1,129 KB | 5.5 MB | 11 MB |
| `mission_workflow_list` | 1,974 | 59 docs | 114 KB | 557 KB | 1.1 MB |
| `cc_sessions` | 950 | 55 sessions | 51 KB | 255 KB | 510 KB |
| `windows_terminal_list` | 950 | 55 terminals | 51 KB | 255 KB | 510 KB |
| `backlog_list` | 895 | 22 items | 19 KB | 96 KB | 192 KB |
| `ccr_cloud_list` | 829 | 50 sessions | 41 KB | 203 KB | 405 KB |
| `memory_map` | 629 | 1,313 records | 808 KB | 3.9 MB | 7.9 MB |
| `mission_changes` | 469 | 245 revs | 112 KB | 549 KB | 1.1 MB |
| `data_keys` | 402 | 137 keys | 54 KB | 269 KB | 538 KB |

**A single mission record costs 18.5 KB.** That explains the incident better than
the 1,757 KB total does: the registry needs only a handful more rows to break a
conversation again, and no caller can currently ask for fewer fields.

Two of these grow along axes we do not control:
- `claudeai_list_plugins` scales with claude.ai's marketplace, not our fleet.
- `memory_map` grows monotonically — memory records are never pruned, so this one
  only ever moves in one direction.

### 3.1 Where the 905 KB actually is — a list view returning revision history

Field-level breakdown of the live `mission_list` payload (50 missions, 927,614 B
body). This is the most actionable number in the audit, because it says what to
cut rather than just how much:

| field | total | share | B/mission |
|---|---|---|---|
| `history` | 379.9 KB | **54.6%** | 7,780 |
| `objective` | 140.2 KB | 20.1% | 2,870 |
| `results` | 68.3 KB | 9.8% | 1,399 |
| `nextSteps` | 19.3 KB | 2.8% | 395 |
| `tags` | 19.2 KB | 2.8% | 393 |
| `plan` | 15.4 KB | 2.2% | 315 |
| everything else | ~85 KB | ~7.7% | — |

**`history` alone is 54.6% of the result.** `mission_list` is a *list* view that
returns every mission's full revision history — 401 revs across 50 missions (avg
8, max 19), each a full-state change record. Revs only accumulate, so this is the
compounding term: per-mission cost rises even if the mission count never does.

`history` + `objective` + `results` = **84.5%** of the whole payload. So:

- dropping `history` from the list projection cuts it ~55% (905 KB → ~410 KB);
- dropping all three cuts it ~84.5% (→ ~140 KB), under a 200 KB ceiling with no
  pagination at all;
- `objective` averages 2,836 chars but peaks at 15,890 — one mission's objective
  is 15.9 KB by itself, so truncate it to a preview rather than dropping it if the
  list should stay readable.

The general rule this suggests: **a list or write result should never carry
per-record revision history.** That is what `mission_history` is for, and it
already takes a `limit`. The same shape explains why writes are big — a
`mission_update` returns ~11 KB because it echoes the full record including every
rev.

### 3.2 The other two mega-offenders need *different* fixes

Running the same field breakdown on them shows the top five do not share one
remedy — which matters, because applying the wrong one leaves the tool just as
broken:

**`claudeai_list_plugins` — one fat field, 82% of the payload.**

| field | total | share | B/plugin |
|---|---|---|---|
| `skills` | 663.6 KB | **82.3%** | 7,386 |
| `mcp_servers` | 40.7 KB | 5.1% | 453 |
| `description` | 16.5 KB | 2.0% | 184 |
| `hooks` / `agents` / `commands` | ~44 KB | ~5.5% | ~164 each |

Every plugin record embeds its **full skills manifest**. Dropping `skills` from
the list view takes it from 1,129 KB to roughly 200 KB — a one-field fix, and the
skills detail belongs behind a per-plugin lookup anyway.

**`memory_map` — no dominant field; it is death by record count.**

| field | share | B/record |
|---|---|---|
| `brief` | 35.6% | 143 |
| `recordId` | 21.6% | 87 |
| `title` | 9.0% | 36 |
| `project` | 6.9% | 28 |
| remainder | ~27% | ~100 |

Nothing here is fat — the widest field is a 143-byte summary. 808 KB is simply
1,313 records × ~630 B of already-minimal fields. **Field projection cannot fix
this one**; it needs pagination and a default scope narrower than "every record on
every host". Worth noting `recordId` is 21.6% of the payload on its own, because
the ids are long fully-qualified strings — a cheaper id form is free savings.

So the three fix shapes across the top five are: **projection** (`mission_list`,
`mission_query`, `claudeai_list_plugins`), **pagination + narrower default scope**
(`memory_map`), and **a row cap in the owning service** (`data_query`).

---

## 4. Structural findings — what a byte cap alone will not fix

**(a) `mission_list` accepts no parameters at all.** Its input schema is `{node}`:
no `limit`, `offset`, `status`, or field selector. A caller who knows the result
is too big has no way to ask for less. Verified empirically — calling it with
`{status:'active'}` returned byte-identical output to `{}` (905,143 B both), so
the argument is silently ignored. Capping this tool truncates a JSON array
mid-record and produces something no caller can parse or page past. It needs a
compact default projection plus pagination. `data_keys` has the same shape: schema
is `{node}` only, so its `dataset` argument is likewise ignored.

**(b) `data_query` is unbounded by design and datasets are user-extensible.** Its
size is whatever the named dataset holds — 940 KB for `knowledge` today. Because
callers can create datasets, no static per-tool number can be right; the row cap
belongs in the data service (a default page size plus a cursor).

**(c) Writes are not safe just because they are writes.** A write echoes the full
affected record *including its revision history*. Measured live during this audit:
one `mission_update` call returned ~11 KB of mission record with every revision
attached, and the original incident recorded `backlog_create` at 63 KB. Rev
history only accumulates, so this compounds. The ceiling must cover write results,
not just reads — an easy thing to miss when the mental model is "big reads are the
problem".

**(d) The tool catalogue costs ~347 KB before any tool is called.** `tools/list`
returns 244 tools totalling 347,430 bytes of names, descriptions and JSON schemas
(~96k tokens). Every conversation pays this at connect time, and it sits outside
the per-result ceiling, silently shrinking the budget every result competes for.
Largest definitions: `scheduler_jobs` 4,497 B, `mission_update` 3,978 B,
`github_mutate` 3,802 B, `data_get` 3,483 B.

**(e) Both MCP surfaces expose the same tool set, so a fix lands once.** The stdio
server (`core/src/mcp-server/index.ts`) and the HTTP `/mcp` endpoint
(`core/src/routes/core/mcp.routes.ts`) share `configureMcpServer` and the same
`EXPANDED_HANDLERS` map; stdio is a thin HTTP client to Core while `/mcp` runs
in-process. A cap applied at the handler or dispatcher layer covers both. A cap
applied in only one transport covers neither properly.

This was **verified rather than inferred** — the stdio server was driven directly
over a pipe (`initialize` + `tools/list`) and its catalogue diffed against the
HTTP one: **244 tools each, zero tools unique to either side.** Worth stating
because the two surfaces reach the tools by completely different routes, and
"they share a module" is the kind of claim that quietly stops being true.

---

## 5. The `ext__` plugin surface is capped — and it is the only one that is

Third-party plugin tools (`ext__<plugin>__<tool>`, 55 currently loaded across
`chart-context`, `mobile`, `trade-data`) cannot reproduce this failure:

- **Hard 1 MiB cap** on every result, `core/src/mcp-server/plugins/client.ts`
  (`capResult`, applied on every `tools/call`), constant
  `PLUGIN_LIMITS.maxResultBytes` in `plugins/model.ts`. It sums bytes across all
  content blocks including base64 image `data`.
- **Graceful degradation, not a crash** — over cap, the whole result is replaced
  by the first 4 KiB plus an explicit "result too large" notice.
- **Anti-OOM guard** — raw stdout past 8 MiB without a frame kills the child
  process, not Core.
- **Universal** — direct `/mcp`, stdio via `POST /mcp-plugins/call`, and
  cross-node forwarding all route through the same cap.
- The shipped plugins self-cap well below it (200 KB text, 950 KB image).

Note for anyone measuring this surface: **base64 image results are a byte concern,
not a token concern.** Claude tokenizes an image block by its dimensions
(~≤1600 tokens), so a 950 KB screenshot costs far less context than 950 KB of
text. Counting images by byte length flags the wrong tools — the standing guard
deliberately charges image blocks a flat nominal cost instead.

Residual risk, bounded: 1 MiB of *text* is ~260k tokens, so a future or hostile
plugin returning just under the cap would still hurt. Lowering the ext **text**
cap (leaving images alone) is a cheap defence-in-depth knob, not a defect.

---

## 6. Coverage and honesty of this audit

244 tools total: **189 native + 55 `ext__` plugin**.

| group | count | how covered |
|---|---|---|
| Read-only, invoked and measured | 70 | empirical bytes on live fleet data |
| Write / mutating | 43 | **static only — never invoked** |
| Destructive / lifecycle | 42 | **static only — never invoked** |
| Third-party side effect | 6 | **static only — never invoked** |
| Read-only but needs a target id or live peer | 28 | static; a subset measured with real ids |
| `ext__` plugin tools | 55 | aggregator cap analysis (§5); not invoked — they drive a real phone, a live chart UI and a trading account |

**How the measurement avoided reproducing the failure it measures:** every result
was written to disk and only its byte count read back. At no point did a 1 MB
payload enter the auditing conversation's context. Backlog items were filed via
REST rather than `backlog_create` for the same reason — that tool returned 63 KB
in the incident, and six of them would have cost ~380 KB.

**What is explicitly not claimed:**
- Write and destructive tools were reasoned about from source, not measured. Their
  sizes are inferred from the record shapes they echo.
- The 28 id-requiring read-only tools were measured where an id could be sourced
  safely (`memory_file`, `fs_read`, `terminal_capture`, `detail`, `session_dag`,
  `mission_history`, `mission_neighbors`, `backlog_get`, `data_keys`,
  `data_query`, `mission_workflow_get/history`); the rest are static only.
- All numbers are one fleet at one moment. `mission_list` moved ~6 KB during the
  audit itself. Treat them as a snapshot, which is exactly why the guard in §7
  exists.
- No cookie or token values appear anywhere in this audit — names and sizes only.

---

## 7. The standing guard — why this audit cannot rot

`core/src/__tests__/mcp-tool-output-size.test.ts` + `core/src/mcp-server/tool-output-budget.ts`.

The important part is **not** the size check. A ceiling tells you a tool is too big
today; it cannot notice a tool added tomorrow. So the guard has three parts:

1. **Coverage (the anti-rot mechanism).** Every tool on the live surface must be
   either budgeted or explicitly excused in `tool-output-budget.ts`. A new tool
   with no entry **fails the test**, forcing whoever adds it to state what bounds
   its output. This check justified itself on its first run by catching two tools
   the hand-built audit list had missed (`windows_terminal_capture`,
   `mission_view_get`).
2. **Ratchet.** A budgeted tool may shrink freely but may not grow past its
   recorded budget. Mutation-verified: dropping `mission_list`'s budget to 1000 B
   fails with `mission_list: 930573B exceeds its budget of 1000B`.
3. **Cap assertion.** The ext-plugin 1 MiB cap must still exist, asserted against
   the compiled `capResult` rather than only the constant.
4. **Truncation must not be a dead end.** A tool that hits the ceiling must expose
   some way to ask for less (`limit`/`offset`/`cursor`/`since`/…), or be recorded
   in `TRUNCATING_WITHOUT_NARROWING` with a reason. Otherwise the truncation
   marker asks the caller to narrow a call it cannot narrow. This ratchets both
   ways: once a listed tool gains narrowing arguments, the test fails until the
   stale entry is deleted, so the excuse list cannot quietly accumulate.
   Mutation-verified: removing `mission_workflow_list` from the list fails with
   exactly that diagnosis.

Operational notes:
- The size sweep is **wall-clock bounded (25s default) and ordered
  biggest-budget-first**, so the tools that can actually kill a conversation are
  always the ones checked. The dropped tail is named in the output, never silently
  skipped. `LM_TOOL_SIZE_FULL=1` runs the exhaustive sweep (~97-121s) — suitable
  for a nightly or scheduled fleet check.
- Per-call timeout is 15s, not 90s, because a wedged tool otherwise dominates the
  run (see §8).
- Live checks self-skip when no Core is reachable, so a laptop without Core gets a
  clean skip while CI with Core up gets the guard.

Run it:
```bash
cd core && npm run build:test
LM_TEST_MCP_PORT=3100 node --test dist-test/__tests__/mcp-tool-output-size.test.js
```

---

## 8. Incidental finding — `bootstrap` and `session_status` hang on prod

Found while measuring, **not a size problem**, recorded here so it is not lost
(filed as its own backlog item).

On prod 117 `:3100`, `bootstrap` and `session_status` both hang past a 30s timeout,
reproducibly (3/3 attempts, 0 bytes returned). Meanwhile `/health` answers in 7 ms
and `guide` / `list_nodes` / `cluster_list` / `claudeai_account` answer in
6-875 ms, so Core is healthy and it is not general claude.ai connectivity.
**Earlier in the same session `bootstrap` answered in 922 ms with 54 KB**, so this
is a state that develops rather than a permanent condition.

Those two tools are precisely the ones that run full caller-identity resolution
(`mcp-session-resolver.ts`) — a path already documented as being on the hot path of
every connector call and previously optimised for this exact class of stall. The
host now holds **13,628 session JSONL files / 4.2 GB**, including one 164 MB file.

This matters disproportionately because the connector instructions tell **every**
session to call `bootstrap` first — a hang here stalls session startup fleet-wide.
Not chased further because it is outside this mission's scope.

---

## 8a. Post-guardrail — what the fix actually did, and what is left

`mission_f4055461` landed the central ceiling (`612c8b9`, `06e616b`) and deployed
it to 117 prod while this audit was running, so every number in §1-3 above is
**pre-cap**. Re-measured on the same fleet afterwards:

| tool | pre-cap | post | outcome |
|---|---|---|---|
| `claudeai_list_plugins` | 1,156,396 | 32,995 | 35× — projection |
| `mission_query` | 960,675 | 34,102 | 28× — projection |
| `mission_list` | 923,758 | 34,132 | 27× — projection |
| `memory_map` | 827,724 | 35,747 | 23× — pagination (default 60) |
| `cc_sessions` | 52,379 | 20,578 | projection |
| `bootstrap` | 55,572 | 55,654 | untouched, by design |

The enforced ceiling is **64 KiB** (`DEFAULT_MAX_RESULT_BYTES` in
`core/src/mcp-server/result-cap.ts`, env `MCP_RESULT_MAX_BYTES`). This audit
originally proposed 50 KB hard; that was **rejected on measurement** — `bootstrap`
is 55,572 B by design, so a 50 KB ceiling would have truncated session onboarding
on every fresh connect and made a truncation marker the first thing a new session
read. 64 KiB is the smallest round number that clears it. The advisory 25 KB soft
budget survives in `tool-output-budget.ts` and does a different job: it keeps
pressure on tools well before anything gets cut.

**Still truncated after the fix** — 4 of the 83 re-measured tools hit the ceiling
and return an incomplete prefix: `data_query`, `mission_workflow_list`,
`mission_changes`, `fs_read`. Truncation is explicit and the conversation
survives, which is the point of the cap. But two of them — `data_query` and
`mission_workflow_list` — **expose no argument a caller could use to narrow the
call.** The truncation marker correctly tells the model to "pass this tool's
paging/filter arguments"; for a tool whose schema is `{node}`, that is advice it
cannot follow, and repeating the call returns the same prefix forever. That is the
remaining projection/pagination work, and it is now an enforced invariant (§7).

`mission_list`'s no-parameters defect is **fixed** — it now takes
`detail/limit/offset/id`.

### The lesson from their deploy: a default page size is derived, not chosen

Worth recording because it generalises. After shipping the projections,
`mission_list` came back at 65,859 B — sitting exactly *on* the ceiling and
truncating. The projection was fine; the **default page was 50 rows and a real
summary row measured 1,333 B**, so the routine call overshot. The fix was the
default page (50 → 25), not lossier rows.

**A cap that fires on the normal path is worse than useless — it trains callers to
ignore the marker.** So a default page size has to be derived from the measured
row cost, or the ceiling silently becomes the pagination.

## 9. The ceiling

**Enforced: 64 KiB** (`DEFAULT_MAX_RESULT_BYTES`, `core/src/mcp-server/result-cap.ts`,
override `MCP_RESULT_MAX_BYTES`). **Advisory: 25 KB soft** (`TOOL_OUTPUT_SOFT_BYTES`).

This audit proposed 50 KB hard and was overruled by measurement — see §8a. The two
numbers do different jobs and both should exist: the cap is an enforcement backstop
that cuts a result, the soft budget is where a tool becomes worth looking at, well
before anything is cut. There is deliberately no hard number in
`tool-output-budget.ts` — even an alias would be a second name for the ceiling, and
a second name is how two numbers start drifting apart.

The ten NEEDS-SUMMARY tools need a compact projection plus pagination regardless of
where the ceiling lands — for them, a truncated dump is worse than a summary. Six
have been done (§8a); `data_query` and `mission_workflow_list` remain.

## 10. Backlog items filed

| id | subject |
|---|---|
| `bl_df9bb7eb` | `mission_list`/`mission_query` serialise every mission, no bound and no parameters |
| `bl_9a2c396d` | `claudeai_list_plugins` returns 1.1 MB — largest result on the surface |
| `bl_8a737823` | `memory_map` returns 808 KB and grows monotonically forever |
| `bl_47b5c8d8` | `data_query`/`data_keys` have no row cap; datasets are user-extensible |
| `bl_c6d0921b` | `bootstrap`/`session_status` hang on prod (caller-identity resolution) |
| `bl_bb31b031` | `tools/list` is 347 KB — a fixed connect-time context tax |
