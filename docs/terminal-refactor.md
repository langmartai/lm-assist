# Terminal subsystem — refactor record

What was changed in `core/src/terminal/` across the
`feat/terminal-refactor` branch, why, what's verified, and what's still
open. See [terminal-api.md](./terminal-api.md) for the user-facing API
reference.

## TL;DR

Replaced a 536-line `terminal-manager.ts` (with 22 reviewed bugs and 0
tests) with a 10-module layered package, added 64 tests (38 integration +
26 unit, 13 against a live Claude Code), and added a dialog/mode/auth API
surface for handling CC's interactive prompts.

| Metric | Before | After |
|---|---|---|
| Source LOC (`core/src/terminal*`) | 536 | ~1,940 |
| Test LOC | 0 | ~1,250 |
| Test count | 0 | 72 |
| Test pass rate | n/a | 72 / 72 |
| Live-CC integration | none | 13 tests |
| Live-GUI integration (gnome tabs) | none | 5 tests |
| Bug classes structurally prevented | n/a | 6 (see §3) |
| API endpoints | 13 | 18 (5 new) |
| Typed error codes | 1 (string) | 11 (discriminated union) |

The original refactor (§1–§8) is on `main`. A later body of work built
the **`/agent/execute` tmux runner** on top of this subsystem and closed
its parity gaps with the SDK runner — see **§9** for the runner
comparison and closed-gap record.

## 1. What was done

### 1.1 Layered module structure under `core/src/terminal/`

| Module | Purpose | LOC |
|---|---|---|
| `types.ts` | Domain model: `TmuxSessionState`, `CCPhase`, `CCSessionState`, DTOs | 131 |
| `errors.ts` | Typed `TerminalError` union (11 codes), HTTP status map | 53 |
| `validate.ts` | Per-DTO schema parsers with regex allowlists | 266 |
| `mutex.ts` | Per-session async mutex (promise chain per name) | 38 |
| `audit.ts` | Append-only JSONL log of every mutation | 87 |
| `tmux.ts` | tmux primitives — every mutation has a post-condition check | 259 |
| `inspector.ts` | Read-only phase / dialog / mode / context / auth detection | 223 |
| `registry.ts` | Atomic tab registry (tmp+rename, flock, mtime reload, reconciliation) | 196 |
| `cc.ts` | Claude Code state-machine adapter | 238 |
| `spawn-tabs.ts` | Gnome + Windows-Terminal-over-SSH tab spawning | 217 |
| `manager.ts` | Orchestrator over the above | 128 |

### 1.2 New API endpoints (Phase 8)

| Endpoint | Purpose |
|---|---|
| `POST /terminal/cc/:name/interrupt` | Ctrl-C |
| `POST /terminal/cc/:name/slash` | `/cmd args` (clear, agents, logout, config, export, compact, init, …) |
| `POST /terminal/cc/:name/accept-dialog` | Enter on trust/permission/compact/choice |
| `POST /terminal/cc/:name/reject-dialog` | Esc |
| `POST /terminal/cc/:name/select-choice` | Press digit 1–9 |
| `POST /terminal/tabs/prune-dead` | Remove tab records whose tmux session is gone |

### 1.3 Enriched `GET /terminal/cc/:name/status`

Previously: `{ phase, model, lastSnapshot }`.
Now adds:

| Field | Source | Values |
|---|---|---|
| `currentMode` | screen scan | `'normal' \| 'plan' \| 'bash' \| 'unknown'` |
| `pendingDialog` | screen scan | `'trust' \| 'permission' \| 'compact' \| 'choice' \| null` |
| `authState` | `~/.claude.json` (primary) + screen fallback | `'authenticated' \| 'unauthenticated' \| 'unknown'` |
| `contextPct` | screen footer regex | 0–100 \| null |
| `authEmail` | `~/.claude.json oauthAccount.emailAddress` | string \| null |

### 1.4 Test suite

64 tests across two files (see [§4 — Test catalog](#4-test-catalog)):
- `core/src/__tests__/terminal/cc-integration.test.ts` (38 tests)
- `core/src/__tests__/terminal/inspector.test.ts` (26 unit tests)

Run via:
```bash
cd core
npm test            # fast suite, ~10s, no Claude API credits
npm run test:live   # full suite incl. real CC, ~47s, uses credits
```

`tsconfig.test.json` extends the main tsconfig to include `src/**/__tests__`
(excluded from the production build) and outputs to `dist-test/`.

## 2. What's NOT done (explicit limitations)

### 2.1 API surface — known gaps

| Gap | Why deferred | Workaround |
|---|---|---|
| `cc.enterPlanMode()` / `exitPlanMode()` | Plan mode is entered via the `Esc + Shift+Tab` key chord, not a slash command. Would need a generic key-chord endpoint. Not yet wired. | Caller can `POST /terminal/tmux/:name/send-keys` with `keys: "Escape"` then `keys: "BTab"` (tmux's name for Shift-Tab). |
| `cc.compactNow()` | `/compact` is exposed via the generic `/slash` endpoint already. No dedicated wrapper. | `POST /terminal/cc/:name/slash { cmd: "compact" }` |
| `cc.bashMode()` | CC's bash mode is entered with `!` prefix; would need ergonomic API. | Use `cc.prompt` with leading `!` in text (CC parses inline). |
| Subscribe-to-output (streaming) | All current reads are pull-based via `capture` / `wait-for`. No SSE / WebSocket. | Poll `capture` or use `wait-for` with longer timeouts. |
| Get full CC response text | `capture-pane` returns the *visible* screen plus ANSI; reconstructing the literal CC response text (without TUI scaffolding) requires more work. | Use `capture?start=-200` to get scrollback, then strip ANSI client-side. |
| Multi-pane tmux layouts | Tab API creates one window per session. Splits / multi-pane not exposed. | Caller can issue `tmux split-window` via raw `send-keys`. Not a documented feature. |

### 2.2 Tests — known gaps (live CC scenarios not covered)

| Scenario | Why not tested | Risk |
|---|---|---|
| Permission prompt acceptance live | Hard to deterministically trigger (depends on what CC asks permission for; behavior varies by tool). | LOW — `accept-dialog` handler is exercised by T4a/T4b precondition checks + static `deriveDialog` unit test verifies detection. |
| Compact prompt acceptance live | Only triggered near context limit; can't artificially induce. | LOW — same coverage as permission. |
| Plan mode entry/exit live | No API for entering plan mode (see 2.1). | MEDIUM — phase detection covered by `inspector.test.ts`, but the round-trip isn't exercised. |
| `/agents` content shape | Depends on installed plugins. | LOW — `/slash` mechanism covered by T3c (`/clear`). |
| Long-running CC (10+ min) session health | Excluded as a fast-feedback test (would inflate `npm test:live` runtime); covered indirectly by D3+F3 timing. | LOW — no known leak path. |
| Multi-instance concurrent CC sessions | Each session has its own mutex; no cross-session interaction. Test would be O(N) launches. | LOW — tested at primitive level via A5 + E1. |
| `wt-ssh` Windows path | No Windows test runner. W1–W3 verify platform gating + sshTarget regex; the actual schtasks + bat orchestration is untested in CI. | MEDIUM — code reviewed, validation covered; lack of live test means a Windows-specific regression could slip through. |
| Auth state during real logout/login flow | Would require modifying `~/.claude.json` mid-run. | LOW — config-file read path covered by `getAuthInfo` shape test; screen-fallback path covered by unit. |

### 2.3 Trust prompt behavior (CC v2.1.x)

**Behavioral observation, not a bug:** Claude Code v2.1.141 (current at
writing) does NOT show the workspace trust prompt when launched with
`--dangerously-skip-permissions`, even on a fresh never-trusted cwd. The
`autoAcceptTrust: true` default in `cc.launch` is therefore mostly a no-op
on this version. The detection + dialog-answering machinery still works
(verified by F5 conditional test and the static `deriveDialog` unit test);
it just doesn't get exercised in practice unless someone runs an older CC
or uses `skipPermissions: false`.

If a future CC release re-introduces a trust prompt under
`--dangerously-skip-permissions`, the test suite will catch it (F5 has both
branches).

### 2.4 Cross-machine orchestration

The docs claim Hub-relayed cross-machine control. **What works:** any
single endpoint can be called against any host through the relay (the
relay forwards request bodies + headers unchanged). **What's still
missing:** there's no orchestrator that knows "tab X lives on host Y";
the local `DELETE /terminal/tabs/:id` on a Windows host doesn't auto-kill
the remote tmux session that the tab points at. The caller has to issue
the kill on the remote host separately.

This was Bug 20 in the original review and remains open. Marked LOW
because the use case is niche (mixed Windows+Linux fleet); design notes
in this doc § 5.4.

### 2.5 Process management edge cases

- **Resource limits at scale.** No tested upper bound on concurrent
  sessions. tmux server can typically handle hundreds; we haven't probed
  beyond ~10. If a caller creates thousands of sessions, behavior is
  undefined.
- **File descriptor leaks.** Not observed in 47-second test suite, but
  not stress-tested.
- **Long-lived registry growth.** The tab registry has no size cap.
  Pathological caller could fill it. `prune-dead` helps but is opt-in.

## 3. Design issues addressed (the WHY)

Six anti-patterns produced the original 22+ bugs. Each is now blocked
structurally:

| # | Anti-pattern | How it manifested | Resolved by |
|---|---|---|---|
| A | `\|\|` instead of `??` for defaults — empty array / string / 0 silently substituted | `flags \|\| [default]` replaced caller-provided `[]`; empty pattern matched anything | Typed DTOs with explicit `extraFlags` semantics; validation rejects empty strings and out-of-range integers |
| B | Fire-and-forget: send command, assume success | `tmuxCreate` succeeded on `-c /bad/cwd` (tmux exit 0 ≠ session usable); `ccPivot` matched the OLD `❯` before `/resume` took effect | Every mutation has a post-condition check. `cwd` pre-checked via `fs.statSync`. `ccPivot` waits for screen delta before re-checking idle. |
| C | tmux exit code 0 ≠ semantic success | Same as B — manifests on creation, kill, send-keys | `tmux.ts` wraps each `execFileSync` with a verify step |
| D | Silent idempotency hides drift | Second `create` with different cwd returned `success` while keeping original | `create` now returns `{ existed: boolean }` so callers know they no-op'd |
| E | Wrapper assumes context but doesn't enforce it | `ccPrompt` to a dead session blasted text into bash | Every cc.* method asserts a phase precondition via `inspector.assertPhase()` |
| F | Routes do no validation beyond type checks | `target` body field redirected to any session; `sshTarget` allowed `&` injection | Centralized `validate.ts` with regex allowlists at the boundary; URL `:name` is the session, body `paneQualifier` is window.pane only |

## 4. Test catalog

### 4.1 `cc-integration.test.ts` (38 tests)

| § | Tests | Coverage |
|---|---|---|
| A — tmux primitives | A1–A6 (6) | Create / send-keys / capture / wait-for / kill / target-body-rejection |
| B — registry lifecycle | B1–B3 (3) | CRUD, liveness reconciliation, atomic write integrity |
| C — input validation | C1–C7 (7) | Session-name colon, cwd metachars, empty pattern, bad regex, lines=0, prompt newline, sshTarget injection |
| D — CC lifecycle | D1–D6 (6, 2 live) | Flag merge, opt-out, full launch→prompt→response (live), non-CC pane rejection, status=dead, kill-cleans-process-tree (live) |
| E — concurrency | E1 (1, live) | Two parallel prompts both succeed, both seen by CC |
| F — gap coverage | F1, F3–F5 (4, all live) | Pivot race regression, multi-turn, capture-during-busy, trust-prompt conditional |
| T — new API | T1a, T1b, T2, T2b, T3a–T3c, T4a, T4b, T5a, T5b (11, 3 live) | Status enrichment, interrupt (incl. cancel), slash (validate+precondition+`/clear`), dialog accept/reject preconditions, select-choice validation |

### 4.1b GUI tab tests (in `cc-integration.test.ts`)

| Test | Coverage |
|---|---|
| G1 | gnome tab opens, `meta.tabPid` tracks the new bash, count increments by 1, DELETE drops it back |
| G2 | DELETE on non-tmux gnome tab sends SIGHUP (interactive bash ignores SIGTERM) and the window actually closes |
| G3 | tmux-linked gnome tab: DELETE kills tmux session, bash exits when `tmux attach` returns, gnome closes the pane |
| G4 | `command` field runs via `bash -c 'eval "$1"; exec bash'` so shell operators like `&&` and `>` work as users expect |
| G5 | non-existent cwd rejected with INVALID_INPUT at validation boundary; no tab spawned |
| W1 | wt-ssh kind from non-Windows host → PLATFORM_UNSUPPORTED |
| W2 | sshTarget with `&`/`;`/`\|`/backticks rejected at validate layer |
| W3 | wt-ssh without sshTarget rejected (PLATFORM_UNSUPPORTED on Linux; INVALID_INPUT on Windows) |

GUI tests auto-skip when no `gnome-terminal-server` is reachable (CI,
headless runners). W tests are pure unit-style — no Windows host required.

### 4.2 `inspector.test.ts` (26 unit tests)

All against canned screen text — no tmux, no CC, fast.

| Function | Tests |
|---|---|
| `derivePhase` | 9 (dead/launching/idle/busy/trust/permission/plan-mode/edge cases) |
| `deriveDialog` | 7 (trust/permission/compact/choice + 3 negative) |
| `deriveMode` | 3 (normal/plan/unknown) |
| `parseContextPct` | 5 (formats + out-of-range) |
| `getAuthInfo` | 2 (shape + sanity) |

## 5. Architecture notes

### 5.1 Why a per-session mutex, not a global one

Different tmux sessions are independent. Serializing across all sessions
would block unrelated operations. Per-name mutex (single-process scope) is
the smallest unit that prevents send-keys interleave within a session
while allowing parallel work across sessions. Implementation: a
`Map<name, Promise<void>>` chain.

### 5.2 Why post-condition checks instead of trusting tmux

Two failure modes proved this necessary:
1. `tmux new-session -d -c /bad/cwd` exits 0 (cwd is silently ignored,
   pane inherits server cwd).
2. `tmux send-keys -t name "text" Enter` exits 0 even after the pane has
   been destroyed mid-call.

`tmuxCmd` is now wrapped: each mutation is followed by either
`exists(name)` or a state read that confirms the intended transition.

### 5.3 Why the registry is reloaded on mtime

Without it, two concurrent lm-assist processes (rare but possible — dev
+ prod side-by-side, or a tooling script) silently clobbered each other.
`load()` now stats first; if mtime hasn't changed it returns the cached
copy (fast path), otherwise re-reads from disk. Combined with atomic
writes (tmp + rename + fsync) and a flock-style sentinel file, the
multi-writer case becomes safe.

### 5.4 Why dialog-answering is its own endpoint group

Originally I considered overloading `cc.prompt` to handle dialogs by
inspecting the screen and dispatching. Rejected because:
- Implicit dispatch hides intent — caller can't tell if their "send"
  became an Enter or a literal keystroke.
- Audit log loses the semantic op name (everything becomes "send").
- Hard to add per-dialog preconditions (e.g. only allow numbered
  selection from a `choice` dialog).

Explicit endpoints (`accept-dialog`, `reject-dialog`, `select-choice`)
are visible in audit, each has a tight precondition, and callers
self-document the intent.

### 5.5 Layered auth detection

Per user preference, config file first (`~/.claude.json
oauthAccount.accountUuid`), screen-text fallback second. The config
file is authoritative — CC writes it on login/logout and reads it on
launch — so it changes deterministically with user actions. The screen
fallback only kicks in when the config file is unreadable (e.g. CI
environment with a fresh home dir).

## 6. How to extend

### Adding a new CC action

1. Add the action to `cc.ts` as an async function. Pattern:
   ```ts
   export async function myAction(session: string, opts: MyActionInput) {
     assertPosix();
     return await withSessionLock(session, async () => {
       inspector.assertPhase(session, ['idle']);            // precondition
       tmux.sendKeysUnlocked(session, { ... });             // mutate
       // optional: await inspector.awaitPhase(...)         // postcondition
     });
   }
   ```
2. Add `MyActionInput` to `types.ts`.
3. Add `parseMyAction` to `validate.ts`.
4. Add a route in `routes/core/terminal.routes.ts` using `envelope` + `withAudit`.
5. Add tests to `cc-integration.test.ts` (precondition + happy path; live test if necessary).

### Adding a new dialog type

1. Add indicator strings to `inspector.ts` (e.g. `MYDIALOG_INDICATORS`).
2. Extend `CCDialog` in `types.ts` with the new variant.
3. Extend `deriveDialog` to return the new variant.
4. Add a unit test to `inspector.test.ts` against canned screen text.
5. The existing `accept-dialog` / `reject-dialog` endpoints will handle
   it for free; no API changes needed unless the dialog needs a
   non-default response (in which case add a dedicated endpoint).

## 7. Files changed (vs main)

```
.gitignore                                         |    1 +
core/package.json                                  |    7 +-
core/src/__tests__/terminal/cc-integration.test.ts |  733 +++++++++++++++++++
core/src/__tests__/terminal/inspector.test.ts      |  162 ++++
core/src/routes/core/annotation.routes.ts          |    9 +-
core/src/routes/core/terminal.routes.ts            |  349 ++++++++--
core/src/terminal-manager.ts                       |  536 --------------- (deleted)
core/src/terminal/audit.ts                         |   87 +++
core/src/terminal/cc.ts                            |  238 +++++++
core/src/terminal/errors.ts                        |   53 ++
core/src/terminal/inspector.ts                     |  223 ++++++
core/src/terminal/manager.ts                       |  128 ++++
core/src/terminal/mutex.ts                         |   38 +
core/src/terminal/registry.ts                      |  196 +++++
core/src/terminal/spawn-tabs.ts                    |  217 ++++++
core/src/terminal/tmux.ts                          |  273 ++++++++
core/src/terminal/types.ts                         |  162 ++++
core/src/terminal/validate.ts                      |  266 ++++++++
core/tsconfig.test.json                            |   11 +
```

## 8. Commits on the branch

```
1843d9d feat(terminal): dialog/mode/auth API surface + 26 unit + 13 live CC tests
7664672 test(terminal): integration test suite for tmux + Claude Code control
47ecf9b refactor(terminal): layered architecture with verification + validation
```

Later, on `main` — the `/agent/execute` tmux runner and its SDK-parity
closures (see §9):

```
7472ce3 feat(agent-api): close SDK-parity gaps in tmux runner (background+abort, tools/effort)
f79539e fix(tmux-runner): read CC's structured transcript as authoritative output
867d924 fix(tmux-runner): freshness gate for warm sessions + blocked-state surfacing
249a306 feat(tmux-runner): systemPrompt/context + settingSources passthrough; relaunch on config change
```

## 9. Agent runner — SDK vs tmux parity (closed gaps)

`POST /agent/execute` can run on either runner:

- **SDK runner** (`sdk-runner.ts`, default) — drives
  `@anthropic-ai/claude-agent-sdk`. One typed, self-delimited message
  stream with an explicit terminal `result` message. Stateless per call.
- **tmux runner** (`runners/tmux-runner.ts`, `runner:'tmux'`) — drives a
  long-lived Claude Code TUI in a tmux session. Reuses a warm CC across
  calls (2 h idle TTL) and exposes the interactive surface.

### The two-signal model

The SDK has one source of truth (its stream). The tmux runner has to
reconstruct that from **two lossy proxies**, and both must be handled:

| SDK (native) | tmux equivalent |
|---|---|
| `init.session_id` | TUI footer `sid:` scrape |
| permission callback / "stream open" | **screen** phase machine + dialogs (only place this state exists) |
| `assistant`/`result` content + usage | **JSONL transcript** (`~/.claude/projects/{cwd-key}/{sid}.jsonl`) |
| explicit `result` message = "done, canonical" | screen-stability **+ transcript freshness gate** (hand-built) |

Division of responsibility: **screen** = state / liveness / dialogs /
sessionId + the human-watchable gnome tab; **JSONL** = authoritative
content + token usage; the freshness gate + `classifyNoTurn` are the
coordination layer.

### Closed gaps

| # | Gap (tmux was…) | Fix | Commit | Tests |
|---|---|---|---|---|
| 1 | no `background`/`abort` | in-process bg via synthetic handle; abort = cooperative Ctrl+C, session survives | `7472ce3` | R7, R8 |
| 2 | dropped `allowedTools`/`disallowedTools`/`model` | `--allowedTools`/`--disallowedTools` launch flags; model via `cc.launch` | `7472ce3` | R9 |
| 3 | dropped `extendedThinking`/effort | `outputConfig.effort` → `--effort`; enabled thinking ⇒ `--effort high` | `7472ce3` | R10 |
| 4 | screen-scrape truncated multi-paragraph output | read CC's structured JSONL transcript as authoritative output | `f79539e` | R11, R12, R13 |
| 5 | token usage hard-zero | usage summed from the transcript's assistant records | `f79539e` | R2 |
| 6 | warm session returned the **previous** answer | freshness gate: require the prompt-count to grow past a pre-prompt baseline before trusting a turn | `867d924` | R14, R15 |
| 7 | a dialog was scraped and returned as the answer | `classifyNoTurn` surfaces blocked/dead distinctly instead of scraping | `867d924` | R16, R6 |
| 8 | dropped `systemPrompt`/`context` | collapsed into one append → `--append-system-prompt-file` (temp file) | `249a306` | R17, R19 |
| 9 | no `settingSources` control (always loaded project CLAUDE.md) | `--setting-sources` passthrough | `249a306` | R18 |
| 10 | warm session pinned call #1's launch config | `launchKeyOf()` fingerprint → relaunch fresh CC when it changes | `249a306` | R20 |

Tests R1–R20 live in `cc-integration.test.ts` (pure ones ungated; live
ones gated by `RUN_LIVE_CC=1`). Full suite at the time of §9: **102
tests, 0 fail** (24 skipped = live-CC/GUI gated).

### Remaining intentional non-parity

- **System-prompt *replace*** — unsupported. `--system-prompt-file` was
  empirically tested and breaks the interactive TUI (strips CC's agent
  scaffolding → no answers). A custom/string `systemPrompt` is therefore
  **appended**, not replaced. The SDK itself defaults to preset+append,
  so the common path is faithful; only full-replace differs, by design.
- **USD cost** — `totalCostUsd` is `0` on the tmux path (no pricing
  calculation). Token *usage* is populated from the transcript.
- **Completion signal** — the SDK has an explicit `result` message; the
  tmux runner reconstructs that boundary from screen-stability + the
  transcript freshness gate. Residual edge: a >3 s mid-turn pause with
  no screen redraw is rare but not provably impossible.
- **`--bare`** is deliberately **not** used to gate CLAUDE.md — it
  disables OAuth/keychain auth, which breaks this deployment (no
  `ANTHROPIC_API_KEY`; "Not logged in"). `--setting-sources` is the
  auth-safe lever.

### Validation discipline

Every CLI-flag mechanism was empirically validated against the actual
interactive `claude` (2.1.143) via the real `cc.launch` path **before**
implementation. This caught two footguns that the naïve design would
have shipped: `--system-prompt-file` (replace) not working in the TUI,
and `--bare` breaking OAuth auth.
