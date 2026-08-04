# Endpoint contract registry + validator — design

> Backlog: `bl_83145dea`. Date: 2026-07-29. Branch: `feat/endpoint-contract-registry`.

## The incident this exists to prevent

`list_claudeai_conversations` failed on **100% of calls** for **8 days** with a bare
`Unexpected response shape from claude.ai.` claude.ai's conversation list had moved to
`chat_conversations_v2`, which answers a paginated envelope `{data, has_more}` — itself
wrapped in our own `claudeaiGet` HTTP envelope `{status, statusText, headers, body}`.

The REST route was updated for this on 2026-07-21. **The MCP tool was not** — it read
`resp.data` where the rows live at `resp.body.data`. Fixed 2026-07-29 (`7c7e631`:
`extractConversationRows` + 6 regression tests).

Two facts about that outage drive every decision below.

### 🔴 Constraint 1 — HTTP 200 is not proof of a working contract

The upstream returned **200 continuously** throughout the outage, confirmed independently by
lm-proxy capture on node 123 and by live calls. **A liveness/ping checker would have passed
every single day the feature was 100% dead.** Any design that reports endpoints up/down
reproduces the exact blind spot that hid this bug.

Therefore: validate the **parsed schema**. The status code is an input to classification,
never the verdict.

### 🔴 Constraint 2 — the break was *between* surfaces

Upstream was fine. The route was fine. The MCP tool was broken. A raw-upstream-URL checker
would also have passed. Therefore the validator must exercise the **consumer path** — the
route handler and the MCP tool — and treat *disagreement between them* as a first-class
failure.

## What investigation added

Two findings that widen the problem beyond "claude.ai drifted."

**Our own wrapper layer is inconsistent.** Of ~50 outbound functions in
`core/src/utils/claudeai-session.ts`, most return the full `{status,statusText,headers,body}`
envelope, but ~12 do not. The most dangerous is `approveToolUse` (`:3099`), which returns
`{status, statusText, body}` with `headers` **dropped** — a 3-field near-envelope that
defeats any `'headers' in r` sniff. `cleanupTestConversations` (`:2093`) contains
`const body = resp.body ?? resp;` — an in-repo admission that call sites cannot tell which
shape they were handed. So `producerShape` is a real, load-bearing axis of the registry, not
documentation garnish.

**One endpoint already has three parse sites and four output shapes.** For the conversation
list alone:

| site | behaviour |
|---|---|
| `claude-ai.routes.ts:381` (prefix-list route) | handles both `body.data` and a legacy bare array |
| `claude-ai.routes.ts:400+` (`GET /claude-ai/conversations`) | **bare array** on cache hit; raw `{data, has_more}` on cache miss — *the route disagrees with itself depending on cache state* |
| `list-claudeai-conversations.ts` (MCP tool) | fixed 2026-07-29; was broken |

The cache-state variance is still live and is why the validator must force `?refresh=true`.

## Approach

A **live-probe MCP tool**, scheduled. Chosen over a two-tier design (offline differential in
`npm test` + live probe) that was also considered.

*Terminology, since two similar words carry opposite meanings here:* a **liveness check** asks
"did it answer?" and is explicitly rejected — it answers 200 and tells you nothing. A **live
probe** makes a real call and then asserts the **parsed shape** of what came back. The word
"live" describes where the data comes from, never what is asserted.

The consequence, stated plainly: with no build-path tier, a developer who edits one surface
and not the other learns at the **next scheduled run** rather than at commit. Scheduling is
therefore **load-bearing, not optional** — it is what converts "8 days" into "one tick."

Constraint 2 is preserved: the tool exercises both consumer surfaces and diffs them. That
comparison simply happens live rather than against a fixture.

## 1. Registry — `core/src/endpoints/registry.ts`

**The code registry is the source of truth.** A prose doc is *generated* from it. The backlog
notes that the `{data, has_more}` envelope, the 30-item default, and the unfollowed
pagination were recorded nowhere but a code comment — and a comment is exactly what the MCP
tool drifted away from unnoticed. A hand-maintained doc alongside a code registry would
reintroduce that drift; generation cannot disagree with what the validator asserts, because
both read one declaration.

Declarative and dependency-free. The repo has no schema-validation library, and adding one
for this is out of step with its explicit-assertion test style.

```ts
export interface EndpointEntry {
  id: string;                    // 'claudeai.conversations.list'
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;                  // '/api/organizations/{org}/chat_conversations_v2'
  producer: string;              // 'claudeai-session.listConversations'
  producerShape: 'envelope' | 'unwrapped' | 'custom';
  contract: {
    at: string;                  // 'body.data[]' — envelope nesting, explicit
    required: Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>;
    pagination?: string;         // 'body.has_more'
    notes?: string;              // e.g. 'limit defaults to 30; has_more is NOT followed'
  };
  surfaces: Array<
    | { kind: 'route'; invoke: string }                              // 'GET /claude-ai/conversations?refresh=true&limit=30'
    | { kind: 'mcp'; invoke: string; args?: Record<string, unknown> }
  >;
  probe: 'live' | 'write' | 'browser' | 'subprocess';
  projection?: string;           // entity key to compare across surfaces; default 'uuid'
}
```

Coverage is the **full inventory** as requested — claude.ai, hub, GitHub, LinkedIn, ext
plugins, data service. `probe` classifies what is actually reachable:

| `probe` | meaning |
|---|---|
| `live` | safe read-only GET; probed |
| `write` | mutates (completion, rename, delete) — declared, **never called** |
| `browser` | drives a real logged-in browser (LinkedIn) — declared, not probed |
| `subprocess` | third-party ext-plugin subprocess — declared, not probed |

Declaring an endpoint we cannot probe still has value: it is the durable home for its
contract, and it makes the unprobed fraction *visible* rather than absent.

### Invocation equivalence

A surface entry declares the parameters that make surfaces **comparable**, not merely
callable. Mismatched limits or filters manufacture false disagreement.

- `?refresh=true` is **mandatory** on `GET /claude-ai/conversations` — without it a cache hit
  returns the bare index array and the probe compares cache against upstream rather than
  surface against surface.
- `include_messages: false` on the MCP tool — otherwise the probe fans out one
  per-conversation read per row.

## 2. Validator — `core/src/endpoints/validator.ts`

For each `live` entry: invoke every declared surface, parse, classify.

### Status vocabulary

Ranked so the interesting case cannot be masked by a passing one:

| status | meaning |
|---|---|
| `SURFACE_DISAGREEMENT` | surfaces disagree — **the 8-day bug**; outranks `CONTRACT_OK` |
| `SCHEMA_DRIFT` | 200, but a declared required field is missing or mistyped — the case a liveness check sleeps through |
| `AUTH_EXPIRED` | 401/403, or the session probe reports expiry |
| `UNREACHABLE` | network error / fetch threw |
| `CONTRACT_OK` | parsed shape satisfies the declared contract, surfaces agree |
| `NOT_PROBED(<reason>)` | carries its reason; never silently absent |

### The differential

Comparison is on **projected entities** — the set of `uuid`s each surface yields — never on
rendered output, since the surfaces legitimately return JSON (route) and text (MCP tool).

Live data can change between two calls, so exact set equality is too strict and would produce
noise. Disagreement is declared when:

- one surface parses **≥1 entity and the other parses 0**, or
- one surface **errors while the other succeeds**.

Set differences short of that are reported as informational, not failure. This threshold is
chosen deliberately: zero-versus-many is precisely the signature the incident produced.

**Deferred refinement.** Both surfaces call the same `listConversations` fetcher, so a
probe-scoped response capture could feed both parsers byte-identical input, eliminating the
race and halving upstream load. It requires a hook in `claudeaiGet`; not in v1.

## 3. Scheduling — `core/src/scheduler/scheduled-jobs.ts`

🔴 `runJob` holds an id in `this.running` for the pass's entire duration (`:576`), and every
later call returns the stale view immediately (`:572`) while `tick()` skips it (`:553`). **An
unbounded pass does not run slow — it disables the job permanently.** This already happened
once: a 54.7s sequential scan held the job open and `stall-monitor` auto-resume stopped
running entirely.

A full-inventory live sweep will not fit in the 60s tick. Therefore the scheduled pass:

- probes a **bounded slice, round-robin** across the registry, so the whole inventory is
  covered over several ticks;
- runs under a hard **~25s wall-clock budget**;
- **reports `timeout` rather than holding the job open.**

The on-demand MCP call accepts a filter to probe a subset directly.

## 4. Honest coverage

Top line is a single verdict, but it always reports `probed / total` with the skipped set
broken out by reason. An all-green summary that quietly skipped 40 of 60 entries is the
`bounded-is-not-honest` failure — a capped result that reads as complete.

**Staleness signal.** A live-only validator has a failure mode of its own: if the cookie
expires, every entry returns `AUTH_EXPIRED` and the tool goes dark. Darkness must not read as
health. When no entry has been successfully probed since a timestamp, the report says *the
validator is dark since T*, not *nothing is wrong*.

## 5. MCP surface — `core/src/mcp-server/tools/endpoint-contract.ts`

Tool `endpoint_contract`, read-only. Args: `{ id?, tag?, probe?: boolean, node? }` — with
`probe: false` it reports the declared registry without any network call, which is what makes
it useful on nodes with no cookie.

Wiring (neither dispatcher needs editing; both fall through to `EXPANDED_HANDLERS`):

1. New `tools/endpoint-contract.ts` exporting defs + handlers.
2. Spread defs and handlers into `tools/expanded.ts`.
3. **`TOOL_SCOPES` entry in `configure.ts:140` marked `'read'`** — omitting it makes
   `assertScopesCoverTools()` throw at configure time, which **crashes Core on the first
   `/mcp` request**. This shipped broken once (hotfix 0.1.91).
4. `registry/catalog.ts` entry — `mcp-tool-catalog.test.ts` fails on any advertised tool
   without one, and the category must come from the closed `CATEGORY_ORDER` set.
5. `tool-topics.ts` entry so results carry a governing playbook.

Result post-processing (byte cap → origin tag → log) is centralized at `configure.ts:522-567`
and comes free.

## 6. Testing

Pure tests in `core/src/__tests__/endpoints/`. Never module-local — `run-tests.js` only walks
`dist-test/__tests__`, so a `core/src/endpoints/__tests__/` file would never run. Run via
`npm test`, not `test:raw` (whose literal `**` glob degrades to one level without `globstar`).

The shape checker and the classifier are pure functions, tested against inline fixtures
including the real `{data, has_more}` payload. Following `mcp-catalog-size.test.ts`, these
read compiled declarations and never a live Core, so they cannot be skipped into uselessness.

Cases mirror `claudeai-conversations-shape.test.ts`, whose deliberate distinction is
preserved: **an empty result is `[]`, never a shape failure** — conflating those is what hid
the original bug.

**Mutation verification is required, not optional.** For the headline test, reintroduce the
`resp.data` bug and confirm the classifier reports `SURFACE_DISAGREEMENT`. A test that still
passes with the bug reintroduced is worthless — this repo has already been bitten by exactly
that (a `mcp-session-resolver` born-expired test first passed with the bug reintroduced,
because a 20ms delay never approaches an 8s TTL).

A registry-completeness test asserts every outbound function in `claudeai-session.ts` has an
entry, using the bidirectional no-orphans/no-gaps pattern from `mcp-tool-catalog.test.ts`.

## Non-goals

- No liveness/ping check, and no up/down reporting — Constraint 1.
- No raw-upstream-URL checker — Constraint 2.
- No probing of `write` endpoints. Read-only is absolute: the validator must never send a
  message, create a conversation, or mutate anything.
- No new dependency.
- Not fixing the producer-shape inconsistency itself. A typed/validated producer layer that
  makes it impossible by construction is the right long-term fix, but it is a refactor across
  ~50 functions and ~100 call sites, and being compile-time it detects no runtime drift. The
  registry is the natural place to generate such validators from later.
- Not fixing the unfollowed `has_more` pagination (`listConversations` silently truncates any
  "full list"). Recorded in the registry's `notes`; deserves its own backlog item.

## Operational note

`API_PORT=3100` / `WEB_PORT=3848` are exported in some shells on this box and `core.sh`
inherits them, so a bare `./core.sh start` would clobber the live prod service. Always pass
`API_PORT=3200 WEB_PORT=3948` explicitly.
