# Executor reaper — retire exhausted mission executors

*2026-07-26 · mission_9eafef1e*

## The problem, measured

On prod 117 at 2026-07-26 17:00: **32 `lmx-` executor panes, 113 claude processes**. Of the
32 panes, **30 are bound to missions that are already `done`**, 20 sit at `ctx:100%`, and idle
times run from 3h to **263h**. Of 41 done missions, **39 still hold a binding** and **17 have
`results: []`**.

Nothing in the codebase ever retires an executor. `mission-controller.ts:189` flips
`status='done'` and returns — binding intact, pane running. `mission_spawn` even says so out
loud: *"the old session is left running for you to retire"*.

The harm is not RAM. **An exhausted executor cannot write its mission results or process a
follow-up.** That is why finished missions keep showing `results=0` with stale
`ctl:readiness` — `247dc202` and `38836df5` both merged their work and then wedged before
recording it. The record lies about state, and a human has to read tmux panes to find the
truth.

## Why this is a fix, not a workaround

A fresh Opus-5 executor in lm-assist starts at **71,526 tok median** (n=19, range
68,694–79,473) — **~36% of the window consumed before its first thought**.

The MCP catalogue is *not* the cause. Claude Code **defers** MCP tool schemas: the full
catalogue is 67,194 tok but only a **1,225-tok name list** is resident. Proof by arithmetic:
schemas (67,194) + project CLAUDE.md (18,160) + MEMORY.md (4,279) = **89,633 > the entire
75,245-token startup**, so the schemas cannot be loaded. Measured across the `be823fb`
catalogue shrink (350 KB → 253 KB), executor startup went **74.7k → 75.2k — no reduction**.

The dominant controllable term is this repo's own `CLAUDE.md` (72,642 B ≈ 18,160 tok). Natural
experiment, same model (`opus-4-7`), different repos:

| repo | CLAUDE.md | startup median | n |
|---|---|---|---|
| lm-mobile | 4,622 B (~1,155 tok) | 34,581 | 36 |
| lm-assist | 72,642 B (~18,160 tok) | 47,556 | 73 |

The 12,975-token gap tracks the ~17k file-size gap. So catalogue trimming helped
connector/claude.ai clients but **cannot** extend executor life; trimming `CLAUDE.md` is the
lever that would (tracked separately). Either way, panes must be retired when missions end.

## Design

A scheduled job **`executor-reaper`**, modelled on `worktree-gc` (same decisions-array,
dry-run and `registerHandler` shape). Leader-anchored, hourly, **ships dry-run**.

### Resolution

The pane name is `lmx-<base36 launch timestamp>` and carries **no mission id**. Order:

1. `listLiveSessions()` → match `tmuxSession` → `sessionId`
2. `findMissionBySessionOrCcr(sessionId)`
3. fallback: pane cwd matching `worktrees/mission-<id>`

`binding.ccr.tmuxSession` is **never** trusted — the `mission_update` PATCH path silently drops
it, so it is stale after any rebind.

### Reap gate — every condition must hold; anything unknown keeps the pane

- mission `status ∈ {done, failed}`, `origin !== 'onboarded'`, id not reserved
- **pane not busy** (see below)
- `connectStrategy !== 'refuse'`
- this node is leader **and** the mission list is non-empty (a sync lag must not read as "orphan")
- mission went terminal ≥ `graceMinutes` ago
- `ctxPct ≥ ctxExhaustedPct` **or** `idleMinutes ≥ idleMinutes`
- an **independent re-resolve + re-check immediately before the kill** (`ccr-restart.ts` ordering)

An `lmx-` pane that resolves to **no** mission is reported as `unresolved` and **never reaped**.

### Busy detection — fail closed, never `derivePhase`

`derivePhase` returns `idle` whenever `ctx:` + `❯` are on screen, and the TUI paints `❯` *while
working*. Four places in this repo document it reading `idle` mid-turn
(`CLAUDE.md:296`, `cc.ts:280`, `tmux-runner.ts:485`, `ccr-manager.ts:543`). It is not used here.

Ordered predicate, copied from the reference implementation at `ccr-manager.ts:552-577`:

1. `press up to edit queued messages` → **busy** (queued work would be lost)
2. `esc to interrupt` → **busy**
3. `/[✻✶✽✢✳✺·]\s?\S+…\s*\(\d+s/` → **busy** (running spinner; `✻ Cogitated for 25s` has no paren, so no false match)
4. `/↓\s*\d+\s+tokens/` → **busy** (streaming counter)
5. transcript mtime < 12s → **busy** (covers submitted-but-not-yet-painted)
6. otherwise not-busy — and the idle/ctx gate still has to pass

`ctx:` is parsed **last-match** (`STATUS_MODEL_RE` discipline), not first-match like
`parseContextPct`, so a scrolled-up `ctx:` can never win.

### Harvest before reap

Merge provenance from the reflog: `merge mission/<id>` → merge sha → commit range
(`sha^1..sha` when the target has ≥2 parents, else `prevReflogSha..sha`). Verified — recovered
`b893bb8`, `1b84922`, `b168bee`, `419a9ea`, matching those missions' known ship-shas exactly.
**4 of the 17 empty records are git-recoverable.**

For the other 13 (never branched here, or merged on another node) the reaper writes a
**pointer**: the executor `sessionId` and its transcript path, plus `no git provenance`. The
account is not lost — the record points at where it lives.

**If the harvest write fails, the reap is skipped.** Losing the account is worse than leaking
a pane.

### Reap

`tmux.kill(name)` (mutex + postcondition), never a raw `execFileSync`; then clear the binding
so the record matches reality. Every decision goes to a journal
(`~/.lm-assist/executor-reaper[-dev].json`) and the job result string — no silent cleanup.
`maxReapsPerRun` bounds the blast radius and **logs when it truncates** (a silent cap reads as
"covered everything").

### Config

| key | default | meaning |
|---|---|---|
| `dryRun` | **`true`** | ships report-only; the human arms it |
| `ctxExhaustedPct` | `95` | context-exhausted threshold |
| `idleMinutes` | `120` | idle-beyond-threshold arm |
| `graceMinutes` | `30` | never reap a mission that went terminal recently |
| `maxReapsPerRun` | `10` | blast-radius bound, logged when hit |

### Never touched

Active/waiting/draft/paused/blocked missions · mid-turn panes · the controller session
(`lmcc-*`, tracked separately) · onboarded sessions · unmanaged/user sessions · any pane that
does not resolve to a mission · any pane when this node is not leader.
