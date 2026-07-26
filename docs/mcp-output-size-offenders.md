# MCP output-size offenders — EARLY HANDOFF to mission_f4055461

**Status:** interim, empirical. Published early and deliberately, so the guardrail
in `mission_f4055461` targets the right tools instead of finalising against the six
tools the original incident happened to name. The full ranked audit of all 244 tools
lands in [`mcp-tool-output-audit.md`](./mcp-tool-output-audit.md).

**Measured:** 2026-07-26, node 117 (`linux-117`), prod Core `:3100`, live fleet data.
Sizes are `textBytes` — the concatenated text of the MCP `content` blocks, i.e. what
actually lands in a conversation's context. Token estimates use ~3.6 bytes/token,
which is realistic for the JSON-shaped payloads these tools emit.

---

## 1. The headline: three tools are WORSE than the one that caused the incident

The incident that started this work was `mission_list` at 1,757 KB. Measuring every
read-only tool on this fleet found **three tools nobody was tracking that are in the
same class or worse**, and one of them is the largest single result on the surface:

| rank | tool | measured | ≈ tokens | why it was missed |
|---|---|---|---|---|
| 1 | `claudeai_list_plugins` | **1,129 KB** | ~321k | never suspected — reads claude.ai's plugin catalogue, not fleet data |
| 2 | `mission_query` | **941 KB** | ~268k | listed in the incident at 168 KB; it has since grown 5.6× |
| 3 | `data_query` | **940 KB** | ~268k | generic data service — size is whatever the named dataset holds |
| 4 | `mission_list` | **905 KB** | ~257k | the known offender |
| 5 | `memory_map` | **808 KB** | ~230k | never suspected — grows monotonically, forever |

**Every one of these exceeds a 200k-token context window in a single call.** They
cannot be "mostly fine but occasionally large" — at current fleet size they are
individually unsurvivable. A cap is not a nicety here; without one these five tools
are strictly unusable.

Note the incident's own numbers no longer reproduce (`mission_list` measured 905 KB
today vs 1,757 KB then; `mission_query` 941 KB vs 168 KB). That is not a
contradiction — it is the finding. These results track live fleet state, so they
drift both ways and a number captured once is not a bound.

## 2. Ranked offender list — what f4055461 should target

Verdicts: **NEEDS-SUMMARY** = a byte cap alone leaves the tool useless, because a
truncated dump of a registry is worse than a summary of it; it needs a compact
default projection plus pagination. **NEEDS-CAP** = the generic ceiling is a
sufficient fix.

| # | tool | measured | ≈tok | what bounds it today | verdict |
|---|---|---|---|---|---|
| 1 | `claudeai_list_plugins` | 1,129 KB | 321k | **NOTHING** | NEEDS-SUMMARY |
| 2 | `mission_query` | 941 KB | 268k | **NOTHING** | NEEDS-SUMMARY |
| 3 | `data_query` | 940 KB | 268k | **NOTHING** | NEEDS-SUMMARY |
| 4 | `mission_list` | 905 KB | 257k | **NOTHING** (no params at all) | NEEDS-SUMMARY |
| 5 | `memory_map` | 808 KB | 230k | **NOTHING** | NEEDS-SUMMARY |
| 6 | `mission_workflow_list` | 114 KB | 32k | **NOTHING** | NEEDS-SUMMARY |
| 7 | `mission_changes` | 112 KB | 32k | **NOTHING** | NEEDS-SUMMARY |
| 8 | `fs_read` | 64 KB | 18k | 64 KiB default cap | NEEDS-CAP (lower it) |
| 9 | `bootstrap` | 54 KB | 15k | fixed prose | NEEDS-CAP |
| 10 | `data_keys` | 54 KB | 15k | **NOTHING** | NEEDS-SUMMARY |
| 11 | `cc_sessions` | 51 KB | 15k | **NOTHING** | NEEDS-SUMMARY |
| 12 | `windows_terminal_list` | 51 KB | 15k | **NOTHING** | NEEDS-SUMMARY |
| 13 | `ccr_cloud_list` | 41 KB | 12k | **NOTHING** | NEEDS-SUMMARY |
| 14 | `mission_graph` | 42 KB | 12k | **NOTHING** | NEEDS-CAP |
| 15 | `mission_neighbors` | 26 KB | 7k | depth arg | NEEDS-CAP |
| 16 | `backlog_list` | 19 KB | 5k | **NOTHING** | NEEDS-CAP |
| 17 | `session_footprints` | 18 KB | 5k | **NOTHING** | NEEDS-CAP |
| 18 | `memory_file` | 16 KB | 5k | file size only | NEEDS-CAP |
| 19 | `mission_history` | 13 KB | 4k | `limit` arg | SAFE-ish |

## 3. Growth projection — the ranking changes as the fleet grows

Per-record cost, measured by dividing the payload by the records in it. This is the
number that matters for the ceiling, because today's byte count is an accident of
today's fleet:

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

**A mission record costs 18.5 KB.** That single number explains the incident better
than the 1,757 KB total does: the registry does not need many more rows to break a
conversation again, and no caller can currently ask for fewer fields.

## 4. Three structural findings that a byte cap alone will not fix

These change what the guardrail has to do, so they matter to f4055461's design:

**(a) `mission_list` accepts no parameters whatsoever.** Its input schema is
`{node}` — there is no `limit`, `offset`, `status` or field selector. A caller who
knows the result is too big has no way to ask for less. Verified: calling it with
`{status:'active'}` returned byte-identical output to `{}` (905,143 B both times) —
the argument is silently ignored. A cap on this tool truncates a JSON array
mid-record and yields something no caller can use. It needs a compact default
projection + pagination, not just a ceiling. `data_keys` has the same shape (only
`node`), so its `dataset` argument is ignored too.

**(b) `data_query` is unbounded *by design*, and the dataset set is user-extensible.**
Its size is whatever the named dataset holds — 940 KB for `knowledge` today. Because
callers can create datasets, no static per-tool limit can be right; this one needs
a row cap plus pagination enforced in the data service itself, not a per-tool number.

**(c) The tool catalogue costs ~347 KB before any tool is called.** `tools/list`
returns 244 tools totalling 347,430 bytes of names, descriptions and JSON schemas
(~96k tokens). That is a fixed tax paid by every conversation at connect time, and
it is outside the per-result ceiling f4055461 is building — worth a separate
decision, but flagging it here because it shrinks the budget every result competes
for. Largest single definitions: `scheduler_jobs` 4,497 B, `mission_update` 3,978 B,
`github_mutate` 3,802 B.

## 5. Recommended ceiling

Suggested for f4055461, from the measured distribution rather than a round number:
**~25 KB soft / 50 KB hard per result.** Rationale — of the 72 read-only tools
measured, 60 already return under 20 KB, so a 25 KB soft ceiling leaves the large
majority untouched and flags exactly the tools listed above. 50 KB hard (~14k
tokens) bounds a single call to ~7% of a 200k context, which keeps a conversation
usable after several calls. The five 800 KB+ tools need summary+pagination
regardless of where the ceiling lands.

## 6. Scope + honesty of this measurement

- **Measured empirically:** 72 read-only tool invocations against live fleet data on
  node 117, plus 24 follow-ups needing real target ids. Bodies were written to disk
  and only byte counts were read back, so auditing these tools did not reproduce the
  failure being audited.
- **Static reasoning only, never invoked:** all write/mutating tools, all lifecycle
  and destructive tools, all third-party-side-effect tools, and the 55 `ext__` plugin
  tools (they drive a real phone, a live chart UI and a trading account). These are
  covered in the full audit.
- No cookie or token values appear here or in the full audit — names and sizes only.
