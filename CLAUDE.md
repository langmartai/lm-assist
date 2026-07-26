# lm-assist

Monorepo for the LM Assistant — a web UI for managing Claude Code sessions, with a backend API for session management, knowledge, and hub connectivity.

## Structure

```
lm-assist/
├── core/                    ← Backend API (TypeScript, dev :3200 / prod :3100)
│   ├── src/
│   │   ├── api/             ← API helper implementations (sessions, agent, tasks)
│   │   ├── checkpoint/      ← Git checkpoint management
│   │   ├── hub-client/      ← Hub WebSocket client (relay, sync)
│   │   ├── knowledge/       ← Knowledge generation pipeline
│   │   ├── mcp-server/      ← MCP server + tools (search, detail, feedback)
│   │   ├── routes/core/     ← Route files and endpoints
│   │   ├── search/          ← BM25 + text scoring
│   │   ├── types/           ← Shared TypeScript types
│   │   ├── utils/           ← Git, JSONL, path utilities
│   │   └── vector/          ← Embeddings + Vectra vector store
│   ├── hooks/               ← Hook scripts (statusline, context-inject)
│   ├── scripts/             ← tmux-autostart.sh
│   ├── package.json
│   └── tsconfig.json
├── web/                     ← Web UI (Next.js 16, dev :3948 / prod :3848)
│   ├── src/
│   │   ├── app/             ← Next.js App Router pages
│   │   ├── components/      ← React components
│   │   ├── contexts/        ← React contexts
│   │   ├── hooks/           ← Custom React hooks
│   │   ├── lib/             ← API clients, utilities
│   │   └── stores/          ← Zustand stores
│   ├── package.json
│   └── next.config.ts
├── core.sh                  ← Service manager (start/stop/restart/status)
├── package.json             ← Workspace root
├── .env.example
└── CLAUDE.md
```

## Commands

```bash
./core.sh              # Interactive menu
./core.sh start        # Start API + Web (auto-builds if needed)
./core.sh stop         # Stop all services
./core.sh restart      # Restart all services
./core.sh status       # Show service status + health check
./core.sh build        # Compile TypeScript (core)
./core.sh clean        # Clean and rebuild
./core.sh test         # Test API endpoints
./core.sh hub start    # Connect Hub Client
./core.sh hub stop     # Disconnect Hub Client
./core.sh hub status   # Hub connection info
./core.sh logs [core|web]  # View logs
```

**IMPORTANT: Always use `./core.sh` to manage services. Do not use direct npm/node commands.**

After modifying TypeScript in `core/src/`, rebuild with `./core.sh build` (or `./core.sh restart` which auto-builds if outdated).

## Dev/Prod Port Separation

Dev (repo) and prod (npm package) use **separate port spaces** so both can run simultaneously:

| Mode | Core API | Web UI | Managed by |
|------|----------|--------|------------|
| **Dev** | 3200 | 3948 | `./core.sh start/stop` (this repo) |
| **Prod** | 3100 | 3848 | `lm-assist start/stop` (npm package) |

**Use `./core.sh` for development** — build, start, test, and iterate on this repo. Use `lm-assist` CLI for managing the prod npm-installed version. Never use `lm-assist` to manage dev services or `./core.sh` to manage prod.

`./core.sh status` shows both environments side-by-side.

**Port detection methods by component:**
- `core.sh` — hardcoded dev defaults (3200/3948)
- TypeScript (cli.ts, service-manager, rest-server, hub-client, etc.) — `__dirname.includes('node_modules')` → prod (3100), else dev (3200)
- Hook + MCP + Statusline — reads `devModeEnabled` from `~/.claude-code-config.json`; when `devModeEnabled=true`, these components talk to the dev API (:3200) instead of prod (:3100)
- Web UI SSR — `NEXT_PUBLIC_LOCAL_API_PORT` env var (set by core.sh at build + start time)
- Web UI client — `NEXT_PUBLIC_LOCAL_API_PORT` baked in at `next build` time, plus `window.location.port` for self-referencing URLs

**When adding new port references:** never hardcode `3100` or `3848`. Use the appropriate detection method for the component type. For core TypeScript, use the `__dirname.includes('node_modules')` pattern.

### Opt-in HTTPS terminator (voice / secure context) — `LM_HTTPS=1`

The browser mic needs a **secure context** (getUserMedia only exists on https/localhost) and an https page can't open `ws://`/`http://` (mixed content). `LM_HTTPS=1` (or `./core.sh start --https` / `lm-assist serve --https`; persist via `.env`) makes Core add ONE `https.Server` on **WEB_PORT+1** (dev `:3949` / prod `:3849`, `LM_HTTPS_PORT` overrides): `/_coreapi/*` → Core in-process (REST+SSE), `/voice/stt/ws` + `/ttyd*` → Core upgrade router, everything else → proxied to Next. Client: `detectAppMode()` returns `baseUrl:'/_coreapi'` on non-hub https pages; `web/src/lib/voice-url.ts` `buildVoiceWsUrl()` is THE voice URL contract (wss same-origin on https, ws://127.0.0.1 on localhost, null when the mic can't work — remote/hub v1 TODO). Self-signed cert auto-managed in `~/.lm-assist/tls[-dev]/` (key 0600; SANs = localhost+hostname+LAN IPv4s; regen on expiry/IP drift); one cert-accept per device+browser. Additive: plain HTTP untouched; TLS failure never kills HTTP. The decision logic is duplicated core↔web with a byte-identity test (`voice-url.test.ts`) — edit both. **Dep pin: `selfsigned` stays `^2.4.1`** (CJS; v5 pulls ESM-leaning deps — chokidar-class `ERR_REQUIRE_ESM` hazard). Full guide: [`docs/voice-https-transport.md`](./docs/voice-https-transport.md).

### Bidirectional voice v2 — startup latency + Chrome lifecycle

Voice bridges the browser mic to claude.ai's own voice WS through ONE headless Chrome
(`core/src/voice/claude-chrome.ts`). Two independent mechanisms keep it fast; they solve
different halves and **both** are needed:

- **Condition-based readiness** — `waitForClaudeReady` polls the REAL signals (same-origin
  `GET /api/account` → 200 **and** `cf_clearance` in the jar) instead of the two hardcoded 10s
  sleeps that used to cost ~20s *per session*. `VOICE_CHROME_SETTLE_MS` is now a **CAP, not a
  floor**. On cap it PROCEEDS (a 200 without cf_clearance just means CF never challenged this
  browser) — the asset's reconnect-once still covers a transient reject.
- **Persistent primed page + CF keepalive** — ONE long-lived navigated claude.ai page holds a
  warm `cf_clearance`/`__cf_bm` in the browser-scoped jar, so the *next* session doesn't redo
  the challenge. It is NOT the voice page (that still needs its own binding + navigation).
  Cheap-validated before reuse, re-primed on any failure, recycled by age, single-flight.

🔴 **The keepalive must be a REAL same-origin `GET /api/account`** (`probeAccount`) — a no-op
`setInterval` JS ping does NOT refresh cookies; only a real request makes Cloudflare re-issue
`Set-Cookie`. This is also why the readiness poll and the keepalive share one function.

🔴 **Never regress the CF fix** (`0f33806`, lm-mobile `docs/claude-voice-implementation.md` §4):
the real-Chrome UA launch arg, and a `GET /api/account` immediately before the WS upgrade. A
headless UA draws CF's bot challenge → `up_error`. Cookie **NAMES** only in logs, never values.

🔴 **`teardownIfIdle()` had NO caller** before this pass — Chrome lived until Core restarted.
It is now driven by an internal unref'd sweeper, and gated on a **live-channel count**:
`lastOpenAt` is stamped when a channel OPENS, so a long call looks idle by timestamp alone and
a naive sweep would kill it mid-conversation.

Client (`web/src/hooks/useClaudeVoice.ts`): the mic opens at **click**, not on `{ready}` — the
socket and the audio engine come up concurrently instead of stacking. Frames captured before
the relay is ready go to a bounded ~5s ring (`web/src/lib/claude-voice-uplink.ts`) and flush on
`{ready}`. The engine's `ac.resume()` **stays non-blocking** (`await` there is the original
`up=0` hang).

| env | default | meaning |
|---|---|---|
| `VOICE_CHROME_SETTLE_MS` | `10000` | **cap** on the readiness poll |
| `VOICE_CHROME_READY_POLL_MS` | `250` | poll interval |
| `VOICE_PRIMED_PAGE` | `1` | `0` disables the persistent primed page |
| `VOICE_PRIMED_MAX_AGE_MS` | `1800000` | recycle the primed page |
| `VOICE_CF_KEEPALIVE_MS` | `480000` | CF keepalive (below `__cf_bm` lifetime); `0` = off |
| `VOICE_CHROME_IDLE_MS` | `300000` | idle teardown window |
| `VOICE_CHROME_IDLE_SWEEP_MS` | `60000` | idle sweeper tick |

**Selectable voice (who speaks back).** The voice is a WS query param **fixed at connect**, so
it applies on the NEXT start, never the live call. Catalogue = claude.ai's own five —
`buttery` (default), `airy`, `mellow`, `glassy`, `rounded` — read out of its shipped bundle,
NOT from an API (there is none; every plausible route 404s). Ids are a **closed set**: an
unknown value makes claude.ai reject the WS upgrade (`up_error`, no audio), so
`normalizeVoice()` whitelists before it reaches the wire. Kept in two places on purpose —
`core/src/voice/claude-voice-url.ts` (`CLAUDE_VOICES`, validation) and
`web/src/components/voice/VoiceSelector.tsx` (`VOICES`, labels + localStorage) — **edit both**.
Path: selector → overlay → `useClaudeVoice` → connect frame `voice` → `ConnectMsg` →
`buildClaudeVoiceUrl`. Catalogue, the rolldown asset-graph crawl that recovers it (claude.ai is
no longer Next.js — no `_buildManifest`), and the unwired extras (`tts_speed` tiers, activation
mode): [`docs/claude-ai-voice-protocol.md`](./docs/claude-ai-voice-protocol.md).

**A voice session must PROVE it owns the conversation before any audio flows.**

Investigating a report that a live voice transcript surfaced in an unrelated claude.ai
conversation (2026-07-25) produced one finding that outranks the report itself:

🔴 **claude.ai ACCEPTS any well-formed conversation uuid, existing or not.** Measured live:
a nonexistent uuid returns `up_open` + `session_server_initialized` + live interim
transcripts, then **silently discards every turn** (`message_complete` never fires, nothing
persists). Only a *malformed* id (`conv-e2e`, empty) or a bad org is rejected (1006). So
`{ready}` says nothing about WHERE speech lands — a session can be open and recording
against a conversation that isn't the caller's, looking perfectly healthy the whole time.

The guard is a same-origin `GET /api/organizations/{org}/chat_conversations/{conv}` run
**inside the voice page**, so what is verified is the exact origin, jar and identity the WS
upgrade will use (existing→200, nonexistent→404, wrong org→404). It parses `{org, conv}`
back out of the URL it is about to dial (`parseClaudeVoiceUrl`), so the pair checked and the
pair used cannot drift. It fails **closed on 404/403** and **open on inconclusive** (0/5xx) —
a transport blip is not evidence of a wrong conversation. It runs *before* the final
`GET /api/account`, so the CF ordering invariant above is untouched.

🔴 **`getBrowser()` needs its own single-flight** — `ensureLoaded`'s `primingPromise`
single-flights the PRIMING, one layer above the launch. Two concurrent cold starts both saw
`browser === null`, both launched Chrome; the second assignment orphaned the first AND
divorced the primed cookie-warm page from the browser serving voice pages → `403`, `jar=14`,
both sessions dead at `up=0`. Measured before/after: 2 launches→1, `up=0`→`up=2245`.

🔴 **A synthetic voice repro did NOT reproduce this leak — even with the fix reverted.** Real
fake-mic sessions (sequential, concurrent, and two sessions sharing ONE long-lived browser),
each speaking a unique marker word, plus an account-wide sweep: every transcript landed only
in its own conversation, in all three shapes, both with and without the `/chat/<conv>`
pinning. So that harness is **not a detector for this failure mode** and a green run from it
is not evidence the leak is gone — the real trigger lives in state it doesn't recreate
(freshly-created empty conversations, no concurrent traffic on the account, a browser whose
SPA has never rendered a conversation). The load-bearing evidence for the pinning fix is the
prod before/after in `ea489ff`, not a synthetic run. If you touch this path, verify the way
that commit did — on prod, counting messages per conversation across real sessions.

Attribution was the other gap: not one log line named the conversation a session bound to,
which is why the incident was discoverable only by a human reading a chat. Both sides of the
bridge now log `conv=` (an id, never content). Regression suite: the pinning, cross-talk,
refusal and single-flight tests in `voice-conversation-pinning.test.ts` /
`claude-voice-relay.test.ts` / `claude-chrome.test.ts` — each **mutation-verified** (bug
reintroduced ⇒ test fails).

**Verify voice with `up>0`, never `{ready}` alone.** `{ready}` proves the transport; prod once
ran `page_status up_open -> ready` with `up=0` (no audio at all). `core/src/__tests__/voice-audio-flow.test.ts`
is the regression test — real Chrome + fake mic + the real engine asset through the real relay,
asserting frames arrive; it self-skips where no Chrome resolves. Design:
[`docs/superpowers/specs/2026-07-25-voice-v2-latency-hardening-design.md`](./docs/superpowers/specs/2026-07-25-voice-v2-latency-hardening-design.md).

### Testing After Code Changes

After modifying and rebuilding (`./core.sh build`), restart **dev** services:
```bash
./core.sh restart          # Restarts on dev ports 3200/3948
./core.sh status           # Verify both dev and prod status
```

Test the dev API: `curl http://localhost:3200/health`
Test the dev web: open `http://localhost:3948`

**Prod stays untouched** — `./core.sh restart` only affects dev ports. To test prod, use `lm-assist restart`.

### Browser Testing (Remote / MCP)

The browser automation MCP (Claude in Chrome) may run on a **different machine** than the dev server. When testing the web UI via browser:

1. Get this machine's IP: `hostname -I | awk '{print $1}'`
2. Use the IP (not `localhost`) in browser URLs: `http://<IP>:3948`
3. The core API also binds to `0.0.0.0`, so `http://<IP>:3200/health` works for remote testing
4. When navigating in browser automation tools, always use the IP-based URL for cross-machine access

## Architecture

### Core API (`core/`)

The backend is a raw Node.js HTTP server (no Express/Hono runtime — Hono is a dependency but the server uses `http.createServer` directly). Routes are modular: each `*.routes.ts` file exports an array of `{ method, pattern, handler }` objects matched via regex.

**Key components:**
- `rest-server.ts` — HTTP server, SSE streaming, CORS, WebSocket upgrade for ttyd, route registration
- `control-api.ts` — Central API facade with sub-APIs: `monitor`, `sessions`, `agent`, `claudeTasks`
- `session-cache.ts` — LMDB-backed session cache with incremental JSONL parsing and file watching
- `sdk-runner.ts` — Claude Agent SDK runner for programmatic session execution
- `session-dag.ts` — Message DAG and cross-session DAG builder
- `hub-client/` — WebSocket client connecting to LangMart Hub for remote API relay

**Data sources (read from disk, not a database):**
- Claude Code sessions: `~/.claude/projects/*/sessions/*.jsonl`
- Claude Code tasks: `~/.claude/tasks/`
- Team configs: `~/.claude/teams/`

### Auto-resume stalled sessions (server / network errors)
A `scheduled-jobs` handler `stall-monitor` (5 min, on by default) resumes sessions stalled on SERVER or NETWORK errors (529/5xx/server-rate-limit, plus transient connectivity loss — `Unable to connect to API`/`Connection error` when the internet drops — NEVER user usage-limits or auth) by sending `continue`. Backoff **widens** as retries keep failing (5,5,10,10,15,15… min) but is **capped** at `autoResumeMaxIntervalMin` (default 30) so it never hammers, and by default it **never permanently gives up** (`autoResumeNeverGiveUp`, default true) — it keeps retrying at the capped interval so a long outage recovers the moment connectivity returns. Local sessions are handled per-node; remote cloud CCRs only by the single auto-elected monitor (lowest online gateway-id from the hub `/machines` list). Toggles in project-settings: `autoResumeStalledEnabled` (default true), `autoResumeIntervalMin`, `autoResumeMaxAttempts` (only bounds retries when `autoResumeNeverGiveUp` is off), `autoResumeMaxIntervalMin`, `autoResumeNeverGiveUp`, `autoResumeRemoteScan`. Status: `GET /monitor/stalls` / MCP `stall_status`. Run on demand: `POST /scheduler/jobs/stall-monitor/run`.

### Auto model-limit mitigation (`/model` fallback)

A **second, independent** class beside auto-resume. When ONE model is exhausted
(`You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.`)
the session stalls forever: `continue` cannot help — the *model* is out. The same
`stall-monitor` job runs a model-fallback pass that detects the banner and sends
`/model <fallback>` (default Opus 4.8), then verifies the status line moved off the
limited model. Local sessions per-node; cloud CCRs only on the elected monitor.

**The two classes never cross:** `model_limit` is deliberately absent from
`SERVER_STALL_STATES`, so the resume pass cannot see a model-limited session (never sends
`continue` on a usage limit) and the fallback pass only fires on a model-named
"reached your … limit" banner (never switches model on a 5xx/529/network error).

**THE invariant — you can only be blocked by the model you are actually on.** The banner
is transcript history: it scrolls, never clears, and can be on screen for reasons that
aren't a live block. So the *live status line* decides (`sid: <uuid> <Model>`, read from
the BOTTOM of the pane). This gives idempotency (post-switch the banner remains, the model
moved ⇒ no-op) and blocks false positives (a session merely displaying the text — reading
a capture, editing these tests — is never switched; observed on this feature's own dev session).

⚠️ **`/model` is not always one-shot.** A conversation already cached for the current model
raises a `Switch model?` confirm dialog (a fresh session applies it silently). The shared
`sendModelSlash()` answers only the option that both affirms AND names the target model.
Both the tick and the mission-controller guard go through it.

⚠️ **Ordering + time-box are load-bearing.** `ScheduledJobs.runJob` marks a job running for
its whole duration and skips every later tick until it returns (`scheduled-jobs.ts:543`) —
so an unbounded pass doesn't run long, it **silently disables the job forever**. The
cloud-CCR scan is sequential HTTPS per session (~55s live). Hence: auto-resume runs FIRST
and unbounded; model-fallback runs SECOND under `MODEL_FALLBACK_BUDGET_MS` (45s) with its
own `REMOTE_SCAN_BUDGET_MS` (25s), reporting `modelFallback=timeout` rather than holding
the job open. Never reorder these.

⚠️ **Never overrule an explicit human decision.** `Kept model as <limited>` (the user chose
"No, go back") more recent than the banner ⇒ `user-kept-model` no-op. A cloud CCR has no
status line, so current-model falls back to the last `/model` outcome (`Set model to X` /
`Kept model as X`) — without it the remote path runs with the invariant switched off.

Settings: `autoModelFallbackEnabled` (default true), `autoModelFallbackModel` (default
`'opus'`), `autoModelFallbackFrom` (default `['fable']`). Switches are journaled to
`~/.lm-assist/model-fallback.json` (7-day TTL) and surfaced at `GET /monitor/stalls` /
MCP `stall_status` under `modelFallback`. Modules: `core/src/monitor/model-limit.ts`
(pure detector + policy), `model-fallback.ts` (tick + actions), `model-fallback-store.ts`.
Design: [`docs/superpowers/specs/2026-07-22-auto-model-limit-mitigation-design.md`](./docs/superpowers/specs/2026-07-22-auto-model-limit-mitigation-design.md).

### Measuring + forking a claude.ai conversation (`conversation_tokens` / `conversation_fork`)

A claude.ai web conversation has a hard context ceiling and no operator-controlled
compaction, so a long working chat eventually strands its state. Two tools measure it
and carry it forward. Both take an EXPLICIT `conversation_uuid` — the web client does
not tag MCP calls with a caller id, so there is no "this conversation", ever
(`rename_conversation`'s recency guess once returned an unrelated session).

🔴 **Naive counting over-reports the live context by 3.8x.** Measured on a real
62-message / 2.0 MB conversation. Four traps, all of which a "sum the messages"
implementation walks into:

| trap | what it costs |
|---|---|
| `msg.text` (flat mirror) is **EMPTY** — content lives only in `content[]` | reports **0** for a full chat |
| `display_content` is a separate, non-identical **render** copy, not model input | 669 KB of 1.81 MB — roughly **doubles** the count |
| messages are a **TREE**; edited/retried turns sit on dead branches | 10 of 62 messages counted that aren't in context |
| **COMPACTION** — `compaction_summary` REPLACES everything before it | 1,808,999 → 892,971 → **475,302** chars |

So the estimate is **not** simply a lower bound: it over-counts (compaction, dead
branches, display_content) *and* under-counts (system prompt, tool schemas). It reports
`liveTokens` vs `totalTokens` separately with an explicit `unmeasured[]`.

chars/token is calibrated **per block class** against `/v1/messages/count_tokens` on real
sampled blocks — text 4.074, tool_use 3.584, **tool_result 2.834**. A flat 4.0 under-counts
tool_result (the dominant class in any operational chat) by ~30%. Thinking is stored with
`thinking_hidden=true` and an EMPTY body — only one-line summaries persist, so the rest is
declared in `unmeasured[]` rather than silently reported as zero.

**Credential-aware routing.** These tools are REGISTERED on every node but only FUNCTIONAL
where a claude.ai cookie lives. Each call preflights the local cookie, serves in place if
good, else forwards to a cookie-bearing node via `/mcp-call` (relay-allowed) reporting
`servedByNodeId`, else refuses with the eligible hostIds + the `claudeai_login` remedy.
A forwarded call carries `_noForward` so two nodes cannot ping-pong.

🔴 **`/claude-ai` is deliberately NOT on the hub relay's `ALLOWED_API_PREFIXES`** — it can
send messages and DELETE conversations. The consequence: `auth_status({allNodes:true})`
probes peers with `proxyGet('/claude-ai/healthz')`, the relay rejects it, and **every remote
node reports `cookie:?`** — which reads as "no cookie" but means "never asked". That is why
the fleet looked like it had exactly one cookie-bearing node when it has at least two. The
credential survey therefore lives at **`GET /fleet/credentials[/local]`** (read-only,
secret-free) and keeps `unreachable` strictly distinct from "no cookie".

🔴 **A display name is not an identity.** One live sweep returned 13 rows in which `vm`
appeared 4x, `ubuntu-Virtual-Machine` 3x and `DESKTOP-GDKLATG` 2x, and a dev-repo Core
appends `" (dev)"` to its hostname. Everything routes on **hostId** (`gw4-…`). An explicit
`node` that lacks a cookie is REFUSED, never rerouted — node choice implicitly selects an
ACCOUNT, so the resolved account is reported on every result. Account identity comes from
the **cookie** (`lastActiveOrg`/`ajs_user_id`), not the probe: `/api/account_profile`
returns a flat preferences object with no `account`/`organization` key.

⚠️ **Forking waits for the model, so it must not confuse "slow" with "failed".**
`sendMessage` drains the SSE; an 11 KB handoff ran past `workerPost`'s 30s and reported
FAILURE for a fork that had been created AND seeded — the `send_session_message`
false-negative class, where a retry would create a SECOND conversation in the real account.
The drain is now bounded (20s; returning early does not cancel the turn) and on expiry the
route **re-reads the conversation to VERIFY** a human message landed rather than guessing.
Landed-but-unanswered is `replyPending`, a state, not an error.

**The handoff is POINTERS, not prose.** This feature was scoped inside an already-compacted
conversation whose summary kept the narrative and dropped the provenance — the assistant
then re-derived the CCR taxonomy from inference instead of re-reading `guide("ccr")` and
needed two human corrections. So the seed carries verbatim human turns, ids with the command
that re-reads each, and the playbook names — and **excludes tool_result bodies** (77% of the
source). Real numbers: 2.0 MB source → 11 KB seed. Both live forks opened with the successor
saying it would *re-read the pointers rather than trust the summary*.

Modules: `core/src/claude-ai/conversation-tokens.ts` (pure estimator),
`conversation-handoff.ts` (pure handoff), `core/src/fleet/credential-fleet.ts` +
`credential-collector.ts`, `core/src/mcp-server/tools/conversation-ops.ts`.
Routes: `GET /claude-ai/conversations/:uuid/tokens`, `POST …/fork` (`dryRun` supported),
`GET /fleet/credentials[/local]`.

### Session messaging — delivery verification + idempotency

`send_session_message` injects into the TARGET's terminal via a driver chain
(`remote-control` → `cc-session` → `tmux-send-keys`). It used to report FAILURE for
messages it had already DELIVERED, and callers who retried delivered them twice.

🔴 **Claude Code QUEUES input typed while it is busy — that IS a successful submit.**
The pane says so (`❯ Press up to edit queued messages`) and the target's transcript
records `queue-operation: enqueue`. Two signals in `typeAndSubmitVerified`
(`core/src/terminal/cc.ts`) both missed it, so a delivered message threw `SUBMIT_UNVERIFIED`:
- `derivePhase` returns **`idle`** whenever `ctx:` + `❯` are on screen — and CC paints `❯`
  *while working*. A busy session therefore never trips the `phase !== 'idle'` check.
- `extractComposerBlock` anchored on `/^\s*>/`, which matches **the lm-assist STATUSLINE's
  own echo of the LAST SUBMITTED PROMPT** (a `>` line ending `<N> tokens`), not the real
  composer (`❯`, U+276F) — then swept upward through the queued block. So already-sent text
  read back as pending input. **Never anchor composer detection on `>`;** the statusline
  line is excluded by its trailing token count, and a box-drawing rule ends the block.

**Typed outcomes** mirror the backlog write path (ORIGIN_UNREACHABLE vs ORIGIN_TIMEOUT):

| status | code | meaning |
|---|---|---|
| `pending` | `TARGET_UNREACHABLE` | no driver reached the session; **nothing was typed in — retry freely** |
| `unverified` | `DELIVERY_UNVERIFIED` | body reached the composer, submit unconfirmed — **MAY have landed; retry ONLY with the same `messageId`** |
| `received` | — | delivered |

`unverified` is deliberately **not** `pending`, so `sweepPending` can never auto-redeliver a
may-have-landed message. **`messageId` is a client-supplied idempotency key AND the id** —
same key twice resolves to the stored message (`idempotent:true`) instead of injecting again;
concurrent twins are serialized by a send-lock so a retry sees the SETTLED status rather than
the transient `pending`. `TerminalError.code` is now preserved through
`terminal-std.routes.ts` instead of being flattened to `INTERNAL_ERROR`.

⚠️ **`startSweeper()` still has NO caller** — pending messages are only retried by an explicit
`POST /session-messages/sweep` (or a later send). The tool text no longer promises otherwise.

⚠️ **Pane text is not a delivery count.** A body appears in the pane multiple times (queued
block, statusline echo, the model quoting it back). Count deliveries from the target's JSONL
(`queue-operation: enqueue` / user turns), never from `grep -c` on a capture.

### Node Clusters

A **cluster** partitions a hub's fleet into independent mini-fleets so you can dev/release on one while another serves. A node belongs to exactly one cluster; unassigned ⇒ implicit `default` ⇒ today's fleet-wide behavior (zero change until you split). Membership is lm-assist-only: a local `~/.lm-assist/cluster.json` (authoritative for self) published into a **fleet-wide-synced** `node-clusters` dataset, so every node converges on the `gatewayId→cluster` map. The scoping lands in two pure filters — `listOnlineNodeIds()` (election: stall-monitor + mission controller) and the data **sync-engine** (per-dataset `scope:'cluster'|'fleet'`, default `cluster`) — plus `selectFleetNodes` (build fan-out).

| Within a cluster (isolated) | Shared fleet-wide |
|---|---|
| leader election; mission control (missions, controller, **executor placement** — `env.host` must be in-cluster, else `HOST_NOT_IN_CLUSTER` / `ctl:placement-error`); data-service datasets; `node_builds cluster:` fan-out (default self-cluster, `all`/`<name>`) | the cluster map; node identity/enrollment; `list_nodes` visibility + proxy reach; sessions/projects; claude.ai account/connector; per-node ops (terminal/transfer/port-forward); **memory**; **knowledge** |

MCP/routes: `cluster_list` (read) / `cluster_assign(node,cluster)` (write, auto-creates, proxies to the node's loopback-guarded `POST /cluster/self`) / `cluster_unassign(node)` (→`default`) / `cluster_describe(cluster?,description,status?)` (write — a cluster's advisory self-description in the fleet-wide `cluster-meta` dataset). `bootstrap`/`session_status` report this node's cluster + the other-cluster roster; `guide("clusters")` carries the full split + the **norm: respect each cluster's declared scope — don't touch another cluster's nodes/missions/data unless asked; `frozen`/`release`/`busy` = off-limits by default.** Note `node_upgrade` is single-node (no cluster arg).

### Machine Access Profiles

A **node-local** registry of how to reach OTHER machines FROM this node (SSH endpoint + user + key *path* + per-machine gotcha notes) so agents stop re-discovering access from prose memory. Storage is a plain file `~/.lm-assist/machine-access[-dev].json` (cluster.json precedent) — **not** a synced dataset; profiles never leave the node except when reported on demand. Access methods are a discriminated union on `type`: v1 implements `ssh` (reported with a derived ready-to-run `command`); unknown types (future `windows-account` remote exec, `elevated-worker`) round-trip verbatim and report `supported:false`. No secrets: `identityFile` is a path, validation rejects pasted key material, and there are no password fields.

Surfaces: `GET /machine-access` (report: node identity + machines + usage guidance; resilient — a hand-edited/malformed profile is flagged, never crashes the report) and **loopback-only** writes `PUT/DELETE /machine-access/machines/:id`, `POST /machine-access/machines/:id/check` (BatchMode ssh reachability probe → `lastCheck`; `StrictHostKeyChecking=yes` so it never mutates `known_hosts`), `POST /machine-access/import` (parse this node's `~/.ssh/config` → **dry-run** drafts by default; `{apply:true}` writes `enabled:false` `imported` drafts, never clobbering a curated id). Writes are node-owner actions — not reachable via LAN/hub relay. Injection-safe field grammar (host/user/identityFile reject a leading `-`, whitespace, metachars, key material); store file is `0600` with a one-deep `.bak`. MCP: `machine_access` (read; optional `id`/`tag`) on both stdio + `/mcp`; wired into `bootstrap` + `guide("machine-access")` so every session discovers it. Modules: `core/src/machine-access/{store,ssh-config,probe}.ts`; routes: `machine-access.routes.ts`; tool: `mcp-server/tools/machine-access.ts`.

### Web UI (`web/`)

Next.js 16 with Turbopack, React 19, Zustand for state, Tailwind CSS v4 for styling. Renders sessions, terminals, tasks, knowledge, and settings pages. Communicates with the core API (dev :3200 / prod :3100).

**Deployment + hub auth state:** see [`docs/web-deployment-and-hub-auth.md`](docs/web-deployment-and-hub-auth.md) — one build serves prod (3848→3100→langmart) and dev (3948→3200→xeenhub) but ONLY if `LM_LOCAL_API_PORT` is set at launch (else dev silently hits the prod core); plus how the nav + settings must `refreshHubConnection()` after logout and why account switch clears the gateway-id.

### MCP Server (`core/src/mcp-server/`)

Provides 3 tools via stdio transport (server name: `lm-assist`):

| Tool | Description |
|------|-------------|
| `search` | Unified search across knowledge and file history |
| `detail` | Progressive disclosure for any item by ID (K001, sessionId:index) |
| `feedback` | Quality feedback on context sources (outdated, wrong, useful, etc.) |

**Two MCP surfaces — both come up with Core, neither is a separate process or port:**

1. **stdio** (table above) — `core/src/mcp-server/index.ts`, server name `lm-assist`, loaded by a **local** Claude Code session through the plugin; it is an HTTP client to Core's `/mcp/search|detail|feedback` shims (`mcp-api.routes.ts`).
2. **HTTP `/mcp`** — the Model Context Protocol StreamableHTTP endpoint served by **Core itself** at `POST/GET/DELETE /mcp` (`core/src/rest-server.ts` → `core/src/routes/core/mcp.routes.ts`). This is the surface reached **remotely through the hub** (the `mcp__claude_ai_lm-assist_langmart__*` connector tools).

**How the remote MCP reaches Core (no extra process/port — it rides the outbound hub WebSocket):**

```
Claude Code / claude.ai connector
  -> mcp.langmart.ai                      (public MCP endpoint, OAuth)
  -> LangMart hub  (assist-api.langmart.ai)
  -> api_relay message over the worker WebSocket   (the same HubClient connection Core dialed out)
  -> Core HubClient -> ApiRelayHandler    (core/src/hub-client/api-relay-handler.ts; /mcp is on its allow-list)
  -> localhost:3100/mcp                   (mcp.routes.ts) -> response relayed back up
```

So the remote MCP is live as soon as **(a) Core is started** (prod via `lm-assist start` — the `/mcp` route binds with Core, there is no separate MCP daemon) **and (b) the HubClient is authenticated** to `assist-api.langmart.ai` (auto-connects on Core start when `~/.lm-assist/hub.json` has `hubUrl` + `apiKey`; `register -> register_ack -> auth_confirmed`). The hub **pushes** requests down the existing outbound socket — nothing listens on a separate inbound MCP port. If Core is down (e.g. the chokidar crash above) the relay has nowhere to land and the connector errors with "MCP down", even though `mcp.langmart.ai` and the hub are healthy.

## Key API Endpoints

### Health & Status
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/status` | Server status (uptime, project path) |

### Sessions (27 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/sessions` | List Claude Code sessions |
| GET | `/sessions/:id` | Get full session data |
| GET | `/sessions/:id/conversation` | Get session conversation |
| GET | `/sessions/:id/from/:lineIndex` | Delta fetch — messages from JSONL line position |
| GET | `/sessions/:id/has-update` | Lightweight poll — check if session changed |
| GET | `/sessions/:id/exists` | Check if session file exists |
| GET | `/sessions/:id/messages/last/:count` | Last N messages (shorthand) |
| GET | `/sessions/:id/compact-messages` | Continuation/compaction messages |
| GET | `/sessions/:id/subagents` | All subagents spawned by session |
| GET | `/sessions/:id/subagents/:agentId` | Specific subagent session |
| GET | `/sessions/:id/forks` | Sessions forked from this one |
| GET | `/sessions/:id/related` | All related sessions (parents, forks, subagents, siblings) |
| GET | `/sessions/:id/dag` | Message DAG with branch info |
| GET | `/sessions/:id/session-dag` | Cross-session DAG (subagents, teams) |
| GET,POST | `/sessions/batch-check` | Check multiple sessions for updates in one request |
| POST | `/session-cache/warm` | Pre-load sessions into memory cache |
| POST | `/session-cache/clear` | Clear cache (specific session or all) |
| GET | `/monitor/executions` | Currently running executions with live status |
| GET | `/monitor/summary` | Aggregated execution counts by status/tier |
| POST | `/monitor/abort/:executionId` | Abort a specific execution |

### Querying Session Execution History

Sessions are stored as JSONL files in `~/.claude/projects/*/sessions/*.jsonl`. Each line is a message. The API provides three indexing dimensions for slicing into a session:

| Index | Type | Description |
|-------|------|-------------|
| `lineIndex` | 0-based | Raw JSONL line position in the file |
| `turnIndex` | 1-based | Conversation turn number (each user msg and each assistant msg is a turn) |
| `userPromptIndex` | 0-based | Sequential count of user messages only |

#### Common query patterns

**Get full session with all data:**
```
GET /sessions/:id?unlimited=true
```

**Get a specific user interaction (e.g., the 5th user prompt and its response):**
```
GET /sessions/:id?fromUserPromptIndex=4&toUserPromptIndex=4
```

**Get everything from turn 10 onwards:**
```
GET /sessions/:id?fromTurnIndex=10&unlimited=true
```

**Delta fetch — get only new messages since last poll:**
```
GET /sessions/:id/from/1523?limit=100
```
Use `fromLineIndex` alone (no other filters) for fast incremental updates via raw message cache.

**Conditional request — skip re-parse if unchanged:**
```
GET /sessions/:id?ifModifiedSince=2026-03-10T12:00:00Z
```
Returns `notModified: true` if the session hasn't changed since the timestamp.

**Formatted conversation (for display):**
```
GET /sessions/:id/conversation?toolDetail=summary&lastN=20
```
Query params: `lastN`, `beforeLine` (pagination), `toolDetail` (`none`|`summary`|`full`), `includeSystemPrompt`, `fromTurnIndex`/`toTurnIndex`.

**Batch check many sessions at once:**
```
POST /sessions/batch-check
Body: { "sessions": [{ "sessionId": "abc", "knownFileSize": 12345 }] }
```
Returns which sessions have changed, avoiding per-session polling.

**Monitor live executions:**
```
GET /monitor/executions
```
Returns `executionId`, `sessionId`, `status`, `isRunning`, `turnCount`, `costUsd`, `elapsedMs`.

**SSE stream for real-time updates:**
```
GET /stream?executionId=abc123
```
Server-sent events with `execution_update` events. Omit `executionId` for all events.

#### Key response fields from `GET /sessions/:id`

- **Metadata:** `sessionId`, `cwd`, `model`, `claudeCodeVersion`, `permissionMode`, `tools[]`, `mcpServers[]`
- **Execution:** `numTurns`, `durationMs`, `totalCostUsd`, `usage`, `modelUsage`, `isActive`, `status` (`running`|`completed`|`error`|`interrupted`|`idle`|`stale`)
- **Messages:** `userPrompts[]`, `toolUses[]`, `responses[]`, `thinkingBlocks[]`, `systemPrompt`
- **Operations:** `fileChanges[]`, `gitOperations[]`, `fileSummary`
- **Organization:** `todos[]`, `tasks[]`, `plans[]`, `subagents[]`
- **Team:** `teamName`, `allTeams[]`, `teamOperations[]`, `teamMessages[]`
- **Pagination:** `totalUserPrompts`, `totalTurns`, `lastLineIndex`, `lastTurnIndex`, `hasMore`
- **Fork tracking:** `forkedFromSessionId`

#### Additional query params for `GET /sessions/:id`

| Param | Default | Description |
|-------|---------|-------------|
| `cwd` | default project | Project directory to search in |
| `includeRawMessages` | false | Include raw JSONL lines |
| `includeReads` | false | Include read-only file operations |
| `fromLineIndex` / `toLineIndex` | — | Filter by JSONL line range |
| `fromTurnIndex` / `toTurnIndex` | — | Filter by turn range |
| `fromUserPromptIndex` / `toUserPromptIndex` | — | Filter by user prompt range |
| `lastNUserPrompts` | 50 | Last N user prompts (default limit) |
| `unlimited` | false | Return all data (no 50-message default limit) |
| `ifModifiedSince` | — | ISO timestamp for conditional requests |

### Projects (12 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/projects` | List all projects |
| GET | `/projects/:path/sessions` | Sessions for a project |
| GET | `/projects/:path/tasks` | Tasks with session mapping |

### Tasks (10 + 12 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/tasks` | List task lists |
| GET | `/tasks/:listId` | Get tasks in a list |
| GET | `/task-store/tasks` | Aggregated tasks across sessions |
| GET | `/task-store/tasks/ready` | Ready (unblocked) tasks |

### Knowledge (21 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/knowledge` | List knowledge entries |
| GET | `/knowledge/search` | Search knowledge (BM25 + vector) |
| POST | `/knowledge/generate` | Generate knowledge from sessions |

### Web Terminal (13 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/ttyd/start` | Start ttyd for a session |
| POST | `/ttyd/stop` | Stop ttyd server |
| GET | `/ttyd/status` | Get ttyd status |
| GET | `/ttyd/processes` | List session processes |

### Backlog / feature-idea graph (12 endpoints)

A fleet-synced registry of NOT-YET-IMPLEMENTED ideas/features/issues/bugs/tasks forming a
typed graph (edges: `depends-on|blocks|relates-to|parent-of|duplicate-of|spawned-mission`).
Versioned like the other registries (every write = a rev with full-state history; rollback
restores as a NEW rev). Dataset `backlog` (cache backend, scope fleet) — created by the
FIRST WRITE on the origin node; reads never create it. Writes are origin-anchored; reads
serve from the local replica. Web UI: `/backlog` (graph like missions). MCP tools (both
surfaces): `backlog_list/get/create/update/link/unlink/review/discuss/remove/graph` —
`backlog_discuss` auto-attaches the CALLER session (connector tool-call id → precise
session; remote/CCR self-declare `sessionId`+`sessionKind:"remote"`). Removal is SOFT
(`removed:true` rev; `restore:true` brings it back). Design:
`docs/superpowers/specs/2026-07-21-backlog-graph-design.md`.

**Write-path robustness (2026-07-25).** Registry WRITES used to refuse callers over things
reads never checked — the reason "creates keep failing while lists work" is always a
validation refusal, not a transport fault. Three rules now hold, and new registry writes
should follow them:
- **Coerce caller-plausible enums, refuse the rest LOUDLY.** `priority:"medium"` → `med`,
  `"urgent"`→`critical`, `status:"done"`→`implemented`, `type:"enhancement"`→`feature`
  (`normalizePriority/Type/Status` in `backlog-model.ts`). An unmappable value still fails,
  but the message now **echoes what was sent** (`priority "spicy" is not valid — …`);
  without that, a caller retries the same value forever (it did: 3× identically).
- **Consume transport keys before the unknown-field guard.** `node` is the connector's
  ROUTING param and rides on nearly every relayed call; it used to trip mission_update's
  whitelist and refuse the whole write. `routes/core/transport-keys.ts` strips a CLOSED
  list — the UNSUPPORTED_FIELD guard must keep catching real typos (the 200-noop lesson).
- **Creates are IDEMPOTENT.** `POST /backlog` takes `requestId`; a repeat (or an identical
  title+description within 10 min) resolves to the SAME item (`idempotent:true`), and
  same-key creates are serialized by a create-lock. Near-duplicate titles are *reported*
  (`possibleDuplicates`) but never refused. Pair this with the anchor's honest failure
  codes: **`ORIGIN_TIMEOUT` = may have landed, retry only with the same `requestId`;
  `ORIGIN_UNREACHABLE` = nothing written, retry freely.** (A relay 504 body used to have
  no `success` key and slipped through as a *successful* write — the worst answer here.)

### Memory read path — `project_id` takes the project NAME, and refusals are typed

The same bug class on a READ path (2026-07-26, `bl_4140a6fc`). `memory_file` was
reported as "intermittently fails with a bare *MCP tool call failed*", suspected to be a
payload-size or relay-timeout cutoff on the larger full-file body. It was neither:
`mcp-calls.jsonl` showed every failure as `durationMs 1-10` with a 35-byte body —
`Project not found: lm-assist`. A ~20KB MEMORY.md returns fine and a 200KB body
round-trips in ms. **`resolveProjectIdToCwd` took only the encoded slug
(`-home-ubuntu-lm-assist`); the caller sent the NAME.** A name has no leading dash, so
it is not legacy-slug shaped → base64 → garbage → null.

- 🔴 **"Intermittent" was DETERMINISTIC PER INPUT** — it varied only because the caller
  sometimes used the slug and sometimes the name. Sort failures by ARGUMENT, not by time,
  before theorising about load or size.
- 🔴 **`search_memory` never failed because its `project` arg is an optional ABSOLUTE
  PATH defaulting to a sweep of every project** — it never asks the caller to name a slug,
  so there is no id to get wrong. That asymmetry pointed at id resolution, not transport;
  the same fact was first read as evidence for a size cutoff.
- **Resolution order:** strict (slug / decodable path) runs FIRST and is unchanged; only
  on failure does it match the project NAME or an absolute path against the **enumerated**
  project set — so a name can never become path traversal. **Ambiguity is REFUSED, never
  guessed** (`PROJECT_AMBIGUOUS` lists the ids). Cost on an 80-project host: fast path
  ~7-10ms, fallback ~21ms, and the fallback only runs where the call previously failed.
- **Typed errors** (`core/src/api/memory-api.ts` + `mcp-server/tools/expanded.ts`):
  `PROJECT_NOT_FOUND` echoes what was sent AND names candidates (`lm-assistt` → *"Did you
  mean: lm-assist"*), distinct from `FILE_NOT_FOUND`/`SOURCE_NOT_FOUND`; transport
  failures split `[READ_TIMEOUT]` (retry safe — a read is idempotent) vs
  `[CORE_UNREACHABLE]` (NOTHING was read), mirroring ORIGIN_TIMEOUT/ORIGIN_UNREACHABLE.
- 🔴 **A dropped `error.code` manufactures phantom transport bugs.** `workerGet`'s
  `unwrapEnvelope` keeps only `error.message` — which is exactly how a 0ms bad-id refusal
  reached the caller as "MCP tool call failed". Reads that classify their own failures use
  **`workerGetRaw`**. The 15s timeout was deliberately NOT raised: measurement showed
  orders of magnitude of headroom, and raising it only delays a wedged Core's answer.

### Caller-identity resolution is ON THE HOT PATH of every connector MCP call

`mcp-session-resolver.ts` resolves WHO is calling. Its header used to say "resolved only for
bootstrap/session_status" — untrue since the backlog/mission write paths started calling it on
EVERY write via the `_actor` hint. Anything expensive added there is paid by every connector
tool call, in front of the relay's fixed 25s local / 30s gateway cutoffs. **Keep full store
sweeps, unbounded network calls and timer-only deadlines off this path.**

Measured on prod 117 (backlog_create, 4 concurrent, direct :3100): warm with a tool-call id
**9359ms → 42ms**; plain no-`_actor` path is 8ms.

- 🔴 **A cost that survives a WARM cache is not the cached thing.** The claude.ai call and the
  8s cache were the suspects; the web-caller shape (no tool-call id) already warmed to 9ms while
  the tool-call-id shape stayed at 9359ms **warm**. That row named the real culprit:
  `findPreciseClaudeCodeSession` — commented *"cheap (in-memory) so it runs every call"* —
  called `getAllSessionsFromCache()`, a **synchronous** lmdb `getRange()` that msgpack-decodes
  **all 13,607** cached sessions: **1663-1977ms per call**, against **6-8ms** for the file-tail
  scan it exists to accelerate. Split a path by input shape and compare warm rows.
- **The cheap fallback was also the RELIABLE one.** The tail scan wins on both axes — the
  caller's tool_use was written moments ago, precisely the window where the parsed cache LAGS.
  Recent sessions now come from a directory walk (**37-53ms** for 6,610 files, memoized 3s);
  the `cwd` label from an **O(1) point get for the ONE session chosen**, never for all.
- 🔴 **A `setTimeout` bound is not a deadline.** A 2.5s bound let an 8229ms call through, and
  `Promise.race` never cancelled the fetch. Proven: **a 2500ms timer did not fire at all during
  a 6s synchronous block.** Use an AbortController (combined with `claudeaiGet`'s internal
  timeout, not replacing it) **plus a wall-clock re-check after the await**.
- 🔴 **Stamp a cache at COMPLETION, not at start.** Stamped at start, an 8229ms resolution
  against an 8000ms TTL wrote an **already-expired** entry — the slower the resolution, the
  shorter its cache lived. Now completion-stamped + stale-while-revalidate, so resolution leaves
  the hot path after the first one (identity here is explicitly best-effort).
- **Injected test deps get NO live enrichment hook** — `getSessionCache()` constructs the cache
  *and* starts its chokidar watcher, the open-handle hang `core/scripts/run-tests.js` bisects.

Regression suite: `core/src/__tests__/mcp-session-resolver-latency.test.ts` (each test
mutation-verified — the born-expired one first PASSED with the bug reintroduced, because a 20ms
delay never approaches an 8s TTL; it now asserts the stamp directly).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/backlog` | List items (`?status=&type=&tag=&includeRemoved=`) |
| GET | `/backlog/graph` | Drawable `{nodes, edges:[{from,to,kind}]}` |
| GET | `/backlog/:id` | Full item incl. discussion/reviews/history |
| GET | `/backlog/:id/history` | Rev history, newest first |
| POST | `/backlog` | Create `{title, description?, type?, priority?, tags?, requestId?}` — idempotent on `requestId` |
| POST | `/backlog/:id` | Update whitelist fields (unknown field ⇒ `UNSUPPORTED_FIELD`) |
| POST | `/backlog/:id/link` `/unlink` | Add/remove typed edge `{to, kind}` |
| POST | `/backlog/:id/discuss` | Attach note `{note, session?}` (session defaults to caller) |
| POST | `/backlog/:id/review` | Attach review `{verdict: approve\|reject\|concerns, note?, by?}` |
| POST | `/backlog/:id/remove` | Soft delete (`{restore:true}` restores) |
| POST | `/backlog/:id/rollback` | Restore rev `{toRev}` as a new rev |

### Hub Client (6 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/hub/status` | Connection status |
| POST | `/hub/connect` | Connect to Hub |
| POST | `/hub/disconnect` | Disconnect from Hub |
| PUT | `/hub/config` | Update Hub config (persists to .env) |

### Claude Code OAuth (14 endpoints)

**Full guide:** [`docs/claude-code-routes.md`](./docs/claude-code-routes.md).

Proxies `api.anthropic.com` endpoints that use Claude Code's OAuth token (from `~/.claude/.credentials.json`). Outbound headers match the real `claude-code/<version>` fingerprint observed in lm-proxy captures, with the appropriate `anthropic-beta` value per endpoint (source-verified against the leaked Claude Code source).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/claude-code/oauth-status` | Token presence + expiry (no secrets) |
| GET | `/claude-code/usage` | Live `Utilization` payload (rate-limit windows) |
| GET | `/claude-code/profile` | Account / org / application info |
| GET | `/claude-code/roles` | Org + workspace role for current OAuth (no beta header) |
| GET | `/claude-code/account-settings` | OAuth account settings (onboarding flags, dismissed banners) |
| GET | `/claude-code/cli-bootstrap?entrypoint=&model=` | Full CLI bootstrap config (account/org/model bundle) |
| GET | `/claude-code/grove` | Extended-thinking grove config |
| GET | `/claude-code/penguin` | Fast-mode config |
| GET | `/claude-code/policy-limits` | Org-level usage caps + compliance taints |
| GET | `/claude-code/settings` | Remote-managed Claude Code settings |
| GET | `/claude-code/user-settings` | User state with checksum |
| GET | `/claude-code/team-memory?repo=owner/repo[&view=hashes]` | Team-scoped memory |
| GET | `/claude-code/mcp-servers` | Anthropic-managed MCP servers (`anthropic-beta: mcp-servers-2025-12-04`) |
| GET | `/claude-code/mcp-registry` | Public MCP marketplace catalog (no auth) |

### claude.ai Web Integration (15 endpoints)

**lm-assist can introspect and operate on the user's claude.ai web account** — list conversations, read full message trees, list projects, read memory and artifacts, AND send new messages to existing conversations. Two parallel families:

| Path | Auth | Best for |
|---|---|---|
| `/claude-ai/...` | `~/.claude/claudeai-session.json` (cookie file) | Headless callers (cron, dashboards, scheduled jobs) |
| `/claude-ai/via-chrome/...` | Real Chrome via MCP | Interactive agents driven by Claude Code with Chrome MCP loaded |

**ALWAYS pre-flight with the health check** before driving these routes. Both families share a stable `reason` vocabulary (`ok`, `session_not_configured`, `session_expired`, `cloudflare_blocked`, `wrong_tab`, `not_logged_in`, `network_error`, `upstream_error`).

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/claude-ai/healthz` | One-glance verdict (file status + live `/api/account_profile` probe) |
| GET | `/claude-ai/session-status[?probe=true]` | File status; optional active probe |
| POST | `/claude-ai/via-chrome/health-check` | Snippet the agent runs in a tab to verify it's on `claude.ai`, logged in, and reachable |
| GET | `/claude-ai/account-profile` | Standalone account profile read |
| GET | `/claude-ai/conversations` | List conversations |
| GET | `/claude-ai/conversations/:uuid` | Read full message tree of one conversation |
| GET | `/claude-ai/projects` | List Projects |
| GET | `/claude-ai/memory` | Claude's persistent memory for the org |
| GET | `/claude-ai/bootstrap` | High-leverage page-load: account + flags + recent conversations |
| GET | `/claude-ai/artifacts/:uuid/versions` | Artifact version history |
| GET | `/claude-ai/org` | Org metadata |
| GET | `/claude-ai/org/subscription` | Subscription details (`?cached=true` by default) |
| GET | `/claude-ai/org/usage` | claude.ai-side usage |
| GET | `/claude-ai/org/skills` | Installed skills |
| GET | `/claude-ai/org/mcp-bootstrap` | Connected MCP servers (**SSE** — events drained server-side) |
| GET | `/claude-ai/org/styles` | Chat styles |
| GET | `/claude-ai/org/model-config/:model` | Per-model capabilities |
| GET | `/claude-ai/org/memory-settings` | Memory feature flags + retention |
| GET | `/claude-ai/org/cowork-settings` | Team/cowork mode toggles |
| GET | `/claude-ai/org/sync-settings` + `/claude-ai/org/sync/gdrive-progress` | Drive sync config + ingestion status |
| GET | `/claude-ai/org/notifications` | Email/push prefs |
| GET | `/claude-ai/account/invites` | Pending org invites |
| GET | `/claude-ai/user-access` | Per-user permissions/roles |
| GET | `/claude-ai/sessions-active` | **Live sessions across devices** — security view |
| POST | `/claude-ai/conversations/:uuid/completion` | **WRITE** — send a message, drain SSE, return aggregated text + events |
| PUT | `/claude-ai/conversations/:uuid` | **WRITE** — **rename** a conversation (`{name}` or `{title}`); returns `previousName` |
| POST | `/claude-ai/conversations/:uuid/title` | **WRITE** — claude.ai's **auto-title generator** (needs `message_content`). ⚠️ NOT a rename — see below |
| POST | `/claude-ai/via-chrome` | Generic snippet generator (path whitelist: `/api/`, `/edge-api/`, `/v1/`) |
| POST | `/claude-ai/via-chrome/...` | Convenience snippet generators mirroring every cookie-file route above |

**Renaming a conversation — `/title` is NOT the rename endpoint.** Despite its
name, `POST .../:uuid/title` is claude.ai's **auto-title generator**: it derives a
title from message content and takes `{message_content, recent_titles}`. Handing it
a title returns `400 "message_content is required."` — it can never set a title of
your choosing. The real rename is a plain `PUT` on the conversation resource:

```
PUT /api/organizations/{org}/chat_conversations/{uuid}   {"name": "New title"}   -> 202
```

Established twice independently (live probe + reading claude.ai's own front-end
bundle, where the "Rename chat" dialog submits `{name}`). Neighbours, so a future
"fix" doesn't wander back: `PATCH`/`POST` on the resource → **405**; `POST .../rename`
→ **404**. Sibling PUTs that *do* exist carry `?rendering_mode=raw` (settings,
`is_starred`) — the rename has **no query string**. Wrapped by
`renameConversation()` (`claudeai-session.ts`), the `PUT /claude-ai/conversations/:uuid`
route, and the `rename_conversation` MCP tool; regression-locked by
`core/src/__tests__/rename-conversation.test.ts`.

Two traps fall out of this: anything that renames by rewriting the chat name (e.g.
`setConversationAutoDelete`'s `[lm-autodel:…]` marker) must go through
`renameConversation`, **and** a successful rename must call
`ClaudeAiCache.updateName()` — `GET /claude-ai/conversations` answers from
`listIndex()` with **no TTL**, so a rename that skips it reads back stale forever
and looks like it silently failed.

**Header fingerprint** — both paths re-inject the application-level headers claude.ai's web app normally adds (`anthropic-client-platform`, `anthropic-client-version`, `anthropic-client-sha`, `anthropic-device-id`, `anthropic-anonymous-id`, `x-activity-session-id`). Identity values come from non-HttpOnly cookies. `x-datadog-*` and `traceparent` are intentionally omitted (random per request, not load-bearing).

**Full integration guide:** [`docs/claude-ai-routes.md`](./docs/claude-ai-routes.md) — covers cookie capture workflow, the via-chrome agent loop pattern, the SSE response shape, the reason-code table, and verified end-to-end test results.

**Endpoint inventory** (independent of lm-assist's wrapper): [`lm-claude-endpoint`](https://github.com/langmartai/lm-claude-endpoint).

### SSE Streams
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/stream` | General event stream (optional `?executionId=` filter) |
| GET | `/tasks/events` | Real-time task file change events |

## Configuration

All configuration is via `.env` (see `.env.example`):

```bash
ANTHROPIC_API_KEY=your-key       # For AI features (knowledge generation, etc.)
API_PORT=3200                    # Core API port (dev default: 3200, prod: 3100)
WEB_PORT=3948                    # Web UI port (dev default: 3948, prod: 3848)
TIER_AGENT_HUB_URL=wss://...    # Hub gateway WebSocket URL (optional)
TIER_AGENT_API_KEY=sk-...       # Hub API key (optional)
```

The server also accepts CLI options: `node dist/cli.js serve --port 3200 --host 0.0.0.0 --project /path --api-key KEY`

## Hub Client

Connects to LangMart Hub for remote API relay, console relay, and session sync. Auto-connects on server start if `TIER_AGENT_HUB_URL` and `TIER_AGENT_API_KEY` are configured. Auto-reconnects with exponential backoff on disconnect.

```bash
./core.sh hub start    # Connect
./core.sh hub stop     # Disconnect
./core.sh hub status   # Connection info
./core.sh hub logs     # Hub log entries
```

## Hook Scripts (`core/hooks/`)

| Script | Platform | Description |
|--------|----------|-------------|
| `context-inject-hook.js` | All (Node.js) | Cross-platform context injection hook (Windows, macOS, Linux) |
| `statusline-worktree.sh` | Linux/macOS | Claude Code status line showing git branch, session info |

The **context-inject hook** is the primary hook. It uses Node.js for cross-platform support (no shell dependencies like jq, curl, or flock).

## Plugin / Slash Commands

lm-assist is packaged as a Claude Code plugin. On `claude plugin install .`, the plugin auto-registers:
- **MCP server** (`lm-assist`) — search, detail, feedback tools
- **Hook** — context injection (UserPromptSubmit) via cross-platform Node.js script
- **Slash commands** — 6 commands for managing lm-assist

The **statusline** is optional and not auto-installed by the plugin.

**Plugin structure:**
- `.claude-plugin/plugin.json` — Plugin metadata
- `.mcp.json` — MCP server auto-registration
- `hooks/hooks.json` — Hook auto-registration (context-inject only)
- `commands/` — Slash command definitions

**Slash commands:**

| Command | Description |
|---------|-------------|
| `/assist` | Open the web UI — checks API health, opens browser or prints URL |
| `/assist-logs` | View context-inject hook logs (`GET /assist-resources/log?file=context-inject-hook.log`) |
| `/assist-mcp-logs` | View MCP tool call logs (`GET /assist-resources/log?file=mcp-calls.jsonl`) |
| `/assist-search` | Search the knowledge base (`GET /knowledge/search?q=...`) |
| `/assist-status` | Show status of all components — API, web, MCP, hooks, statusline, hub, knowledge |
| `/assist-setup` | Start services and verify integrations (statusline optional via `--statusline`) |

All commands call the existing REST API with `curl` on the active port (dev :3200, prod :3100). If the API is not running, commands advise the user to start it or run `/assist-setup`.

**Install methods:**
- Plugin: `claude plugin install .` (from repo root)
- npm global: `npm install -g lm-assist` then `/assist-setup`


**Effective hub config lives in saved files, not just `.env`.** The Core reads `~/.lm-assist/hub.json` (prod) / `~/.lm-assist/hub-dev.json` (dev) — `{ hubUrl, apiKey, apiPort, assistWebPort }`. `.env`'s `TIER_AGENT_HUB_URL` is only the fallback used when the saved file has none. The `-dev` suffix is applied automatically when running from the repo (`IS_DEV_REPO`).

**Which hub each env connects to (do not mix):**

| Env | `hubUrl` | meaning |
|-----|----------|---------|
| **Prod** (npm, :3100) | `wss://assist-api.langmart.ai` | LangMart **prod** hub (SG instance) |
| **Dev** (repo, :3200) | `wss://assist-api.xeenhub.com` | **xeenhub** dev/HMR hub |

The Core dials the hub **outbound** over WebSocket on start: register → `register_ack` → `auth_confirmed`. Verify: `curl -s localhost:3100/health` (Core up) and `curl -s localhost:3100/hub/status` → `{ configured, connected, authenticated, hubUrl, apiKeyConfigured }`. The public MCP path is `Claude Code → mcp.langmart.ai → langmart hub → this prod worker`; when prod is authenticated the `mcp__claude_ai_lm-assist_langmart__*` tools appear in the Claude Code session. A 502 from `assist-api.langmart.ai` means the SG hub origin is down (not a local problem); a crash-looped local `langmart-gateway.service` (xeenhub Type-3 gateway, :8083, needs a marketplace at :8081) is unrelated leftover and **not** in this path.
## Development

```bash
# Build core (TypeScript → dist/)
./core.sh build

# Watch mode (auto-recompile on change)
cd core && npm run dev

# Build web (Next.js production build)
cd web && npx next build

# Dev mode (web with Turbopack HMR)
cd web && npm run dev

# Run from root (npm workspaces)
npm install              # Install all deps (hoisted to root node_modules/)
npm run build:core       # Build core
npm run build:web        # Build web
```

### Workspace Notes

This project uses **npm workspaces**. Dependencies are hoisted to the root `node_modules/` directory. Run `npm install` from the project root, not from inside `core/` or `web/`.

### Dependency pin — chokidar MUST stay `^3.6.0` (do NOT bump)

chokidar 4.x/5.x are **ESM-only**. The core build is CommonJS (`core/tsconfig.json` → `"module": "commonjs"`), so `core/dist/*.js` does `require("chokidar")`. `require()` of an ESM-only module throws **`ERR_REQUIRE_ESM`** and **Core crashes on boot** — the Web UI still starts, but Core never binds `:3100` (prod) / `:3200` (dev). Symptom: services look half-up, `curl localhost:3100/health` fails, and anything the hub relays (the MCP) errors → "lm-assist MCP is down". Loaders that import it: `task-store.ts`, `rest-server.ts`, `session-cache.ts`, `memory-cache.ts`.

The source uses the v3 API (`import chokidar, { FSWatcher }` + `chokidar.watch(...)`), so **`^3.6.0`** (last CommonJS release) matches the code and can never resolve to the ESM v4/v5 line. Keep it pinned in BOTH `package.json` and `core/package.json`.

Recover if Core won't boot with `ERR_REQUIRE_ESM`:
1. `npm install chokidar@^3.6.0 --ignore-scripts` (the `prepare` hook runs `next build`; `--ignore-scripts` skips it).
2. `core` is a workspace — a nested `core/node_modules/chokidar@5` wins resolution from `core/dist`. Remove it so it hoists to root v3: `rm -rf core/node_modules/chokidar`.
3. Verify: `node -e "const p=require.resolve('chokidar',{paths:['./core/dist']}); require(p); console.log(require(p.replace(/index\.js$/,'package.json')).version)"` → prints `3.6.0`, no throw.

**⚠️ Upgrade hazard:** `lm-assist upgrade` / `npm install -g lm-assist@latest` reinstalls from npm. Until a version carrying `chokidar: ^3.6.0` is **published to npm** (npm `latest` still ships `^5.0.0`), every upgrade RE-BREAKS startup and needs the recovery above. A build/install from this repo is fine (pin committed here).

### Agent SDK (`@anthropic-ai/claude-agent-sdk`) is ESM-only — `import()` must survive tsc

`/agent/execute` (the agent runtime in `sdk-runner.ts`) loads `@anthropic-ai/claude-agent-sdk`, which is **ESM-only** (`type: module`, `exports.require: null`). The code imports it dynamically, but **tsc with `module: commonjs` downlevels `await import('pkg')` to `Promise.resolve().then(() => require('pkg'))`** — and `require()` of an ESM module throws **`ERR_REQUIRE_ESM`**. Result: every agent execution dies with **0 turns / empty result** on the dev build (`:3200`). Prod masks it only because its older npm-installed SDK is still `require`-able — a latent trap, same class as the chokidar one above.

**Fix (in `sdk-runner.ts`):** indirect the dynamic import through `Function` so tsc cannot see/downlevel it:
```
const esmImport: (m: string) => Promise<any> = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
// ...
const { query } = await esmImport('@anthropic-ai/claude-agent-sdk');
```
Type-only imports from the SDK are fine as `import type { ... }` (erased at compile). Verify: `POST :3200/agent/execute {"prompt":"reply OK","model":"haiku"}` → `turns>0`, no `ERR_REQUIRE_ESM`. (Note: `annotation/matcher.ts` + `annotation/annotator.ts` have the same downleveled `import()` and would need the same treatment if/when their feature is exercised on a CJS build with an ESM SDK.)

### Route Development

Routes live in `core/src/routes/core/`. Each file exports a `create*Routes(ctx: RouteContext)` function returning an array of `RouteHandler` objects:

```typescript
export function createMyRoutes(ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'GET',
      pattern: /^\/my-endpoint$/,
      handler: async (req, api) => {
        const start = Date.now();
        // ... logic ...
        return wrapResponse(data, start);
      },
    },
  ];
}
```

Register new route files in `core/src/routes/core/index.ts`.

### Publishing / Version Bumps

When releasing a new version, update the version in **all three files** before committing:

| File | Field | Purpose |
|------|-------|---------|
| `package.json` | `"version"` | npm package version (what `npm view lm-assist version` reports) |
| `.claude-plugin/plugin.json` | `"version"` | Plugin version (shown in Claude Code plugin cache) |
| `.claude-plugin/marketplace.json` | `plugins[0].version` | Marketplace listing version (used by plugin registry) |

**Release steps:**

```bash
# 1. Bump version in all three files (keep them in sync)
# 2. Commit and push
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump version to X.Y.Z"
git push origin main

# 3. Publish to npm
npm publish

# 4. Verify
npm view lm-assist version   # Should show new version
```

**How each version is used:**
- `package.json` → npm registry, `GET /dev-mode/check-update` (current vs latest comparison)
- `.claude-plugin/plugin.json` → `claude plugin install lm-assist@langmartai` reads this for the version string stored in `~/.claude/plugins/installed_plugins.json`
- `.claude-plugin/marketplace.json` → Plugin marketplace/registry uses this to index the plugin

**Upgrade flow** (from web UI or CLI):
- Web UI: Settings → Experiment → "Check for Updates" → "Upgrade" (calls `POST /dev-mode/upgrade`, runs detached `core/scripts/upgrade.js`)
- CLI: `lm-assist upgrade` (runs `core/scripts/upgrade.js` in foreground)
- The upgrade script: plugin install → kill services → `npm install -g lm-assist@latest` → restart services
- Upgrade log: `~/.cache/lm-assist/upgrade.log`

### Install/upgrade sources (published vs custom)

Every surface supports both: **published** (`lm-assist@latest`/`@<ver>` from npm) and **custom** (a GitHub-Release tgz, `github:…#ref`, a local `.tgz`, or a source build). The current install is tracked in `~/.lm-assist/install-source.json` (`{kind:'published'|'custom',source,version}`) and shown by `lm-assist version`, `GET /dev-mode/check-update` (`currentSource`/`isCustomBuild`), and the Settings UI. `lm-assist version` only prompts an upgrade when npm latest is GREATER (no downgrade nudges) and warns when on a custom build. Installers (`install.sh`/`install.ps1`) prefer the prebuilt GitHub-Release tgz for the ref, fall back to source-build, and take `--published [<ver>]` for the registry. CLI: `lm-assist upgrade --from <tgz|dir|version|github:…#ref|release-url>`.

### Running Modes: npm Package vs Dev Repo

lm-assist has two independent environments that can run simultaneously on separate ports:

- **Prod (npm package)**: Managed by `lm-assist start/stop/restart`. Runs on ports 3100/3848. Do not modify.
- **Dev (this repo)**: Managed by `./core.sh start/stop/restart`. Runs on ports 3200/3948. Use for development and testing.

The `devModeEnabled` flag in `~/.claude-code-config.json` controls which environment the **MCP server, hook, and statusline** talk to. The Settings → Experiment → Developer Mode toggle switches it.

| `devModeEnabled` | MCP/Hook/Statusline target | Effect |
|-------------------|---------------------------|--------|
| `false` (default) | Prod API (:3100) | Normal operation — plugin tools use the npm-installed prod services |
| `true` | Dev API (:3200) | Plugin tools switch to the dev repo services for testing |

**Important:** `devModeEnabled` only affects which API port the MCP/hook/statusline connect to. It does NOT change which services are running — prod and dev run independently on their own ports.

#### Component launch paths

| Component | Prod (`lm-assist start`) | Dev (`./core.sh start`) |
|-----------|--------------------------|-------------------------|
| **Core API** | `<npm-root>/lm-assist/core/dist/cli.js` → :3100 | `<repo>/core/dist/cli.js` → :3200 |
| **Web UI** | `<npm-root>/lm-assist/web/` → :3848 | `<repo>/web/` → :3948 |
| **MCP Server** | Always runs from plugin cache (`${CLAUDE_PLUGIN_ROOT}`) | Same binary — `devModeEnabled` switches target port |
| **Hook** | Always runs from plugin cache (`${CLAUDE_PLUGIN_ROOT}`) | Same binary — `devModeEnabled` switches target port |
| **Statusline** | `<npm-root>/lm-assist/core/hooks/statusline-worktree.js` | `<repo>/core/hooks/statusline-worktree.js` |

Where `<npm-root>` = e.g. `~/.nvm/versions/node/v20.19.6/lib/node_modules` and `<repo>` = e.g. `/home/ubuntu/lm-assist`.

#### How mode switching works

1. `bin/lm-assist.js` → `getProjectRoot()` checks `~/.claude-code-config.json`
2. If `devModeEnabled && devRepoPath` → uses repo path; otherwise → uses npm package path (`path.dirname(path.dirname(__filename))`)
3. `core/src/service-manager.ts` → same logic in `getRepoRoot()`
4. Both Core API and Web UI resolve their working directory from this root
5. The MCP server and hook always run from the plugin cache (`${CLAUDE_PLUGIN_ROOT}`); they read `devModeEnabled` from config to determine which API port to call (3200 dev / 3100 prod)

#### Upgrade methods

| Method | Command | What it does |
|--------|---------|-------------|
| **Web UI** | Settings → Experiment → "Check for Updates" → "Upgrade" | `POST /dev-mode/upgrade` → spawns detached `core/scripts/upgrade.js` |
| **CLI** | `lm-assist upgrade` | Runs `core/scripts/upgrade.js` in foreground with live output |

**Upgrade script steps** (`core/scripts/upgrade.js`):
1. `claude plugin install lm-assist@langmartai` — update plugin cache (MCP, hooks, slash commands)
2. `fuser -k 3100/tcp && fuser -k 3848/tcp` — kill prod services
3. `npm install -g lm-assist@latest` — update npm package
4. Wait 2s
5. `lm-assist start` — restart services

Log file: `~/.cache/lm-assist/upgrade.log`

### Bootstrapping from the repo on a fresh host (dev + prod)

**One-command (recommended), per OS** — both run `scripts/preflight.js` first (Node>=20.9, git/npm, chokidar pin) then a prod install (CLI + services :3100/:3848); add `--dev`/`-Dev` for the dev ports (3200/3948):
- Linux/macOS: `curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash`
- Windows: `irm https://raw.githubusercontent.com/langmartai/lm-assist/main/install.ps1 | iex`
- Diagnose anytime: `lm-assist doctor` (runs the same preflight; `--json` for machine output).
- Node policy is **guidance-only**: too-old Node prints the nvm / nvm-windows / fnm upgrade command and stops — it never changes your Node.

Verified end-to-end in a clean cloud **CCR** container (Node 22). This is the same procedure the MCP ships through `guide(topic="install")` / `bootstrap` (see `core/src/mcp-server/tools/guide.ts`) so a connector-only host with **no local lm-assist** can self-install. It's an npm **workspace** monorepo (`core` = Node API, `web` = Next.js 16). Requires **Node ≥ 20.9** (the Next 16 web build fails on 18). **Run every `npm` command from the repo ROOT** — workspaces hoist deps; installing inside `core/` or `web/` nests a `node_modules` that shadows the hoist (e.g. the wrong chokidar then resolves from `core/dist`).

**Dev (repo ports — API :3200, Web :3948), from the repo root:**
```bash
npm install --ignore-scripts          # plain `npm install` DIES on onnxruntime-node's native postinstall
                                       # (transitive via @huggingface/transformers / @lancedb):
                                       # "Cannot find module .../global-agent/.../index.js"
node -e "require('chokidar');console.log(require('chokidar/package.json').version)"   # must print 3.6.0, no throw
./core.sh build                        # core TS -> core/dist
./core.sh start                        # Core :3200, then builds + starts Web :3948
curl -s localhost:3200/health          # -> "runningFrom":"dev-repo"
curl -so /dev/null -w '%{http_code}\n' localhost:3948   # -> 307 (= up; see gotcha #3)
```

**Prod (CLI ports — API :3100, Web :3848), also from the repo root:**
```bash
npm pack                               # the `prepare` script builds core+web -> lm-assist-<ver>.tgz (~28 MB)
npm install -g ./lm-assist-*.tgz       # installs the `lm-assist` CLI + compiles native better-sqlite3 (~46s)
                                       # (CLI already there? -> lm-assist upgrade --from ./lm-assist-*.tgz)
lm-assist start                        # Core :3100 + Web :3848
curl -s localhost:3100/health          # -> "runningFrom":"npm"
```

Dev + prod run **simultaneously** — separate port spaces (3200/3948 vs 3100/3848), no conflict (`./core.sh status` shows both).

**Gotchas (verified in the container):**

| # | Gotcha | Symptom | Fix |
|---|--------|---------|-----|
| 1 | `onnxruntime-node` native postinstall (transitive via `@huggingface/transformers` / `@lancedb`) | `npm install` dies: `Cannot find module .../global-agent/.../index.js` | **dev:** `npm install --ignore-scripts`. **prod** (`npm install -g ./tgz`) does NOT need it — the prod-only dep tree installs clean. |
| 2 | `--ignore-scripts` skips the better-sqlite3 native build | `better-sqlite3/build/Release/better_sqlite3.node` absent | Core still boots healthy (sqlite is lazy / worker-thread loaded); only matters if you use the SQL data backend. The prod global-install compiles it anyway. |
| 3 | `./core.sh` web "Failed to start" / "Not Running" | the probe wants 200 on `/`, but the app **307-redirects** `/` → `/sessions` | False negative — ignore it; `curl :3948` → 307 means it's up. |
| 4 | chokidar must be `^3.6.0` (see the pin section above) | v4/v5 are ESM-only → `ERR_REQUIRE_ESM` → Core never binds :3200/:3100 | the repo + its `npm pack` tgz carry the pin (safe). Only `npm install -g lm-assist@latest` from the registry re-breaks it. |
| 5 | `lm-assist upgrade` (no flag) reinstalls from npm | overwrites a local-tgz / source build with npm `latest` (possibly older / chokidar-broken) | use `lm-assist upgrade --from ./<tgz>` to keep your source build. |

The hub is a **separate, user-confirmed step**: bootstrapping writes no hub credentials and connects to nothing — `lm-assist setup --key <KEY>` runs only on explicit user instruction (both Core instances report Hub Client *Not configured* until then, and the local services still work).

### Key Types

```typescript
// Route system
interface RouteHandler {
  method: string;
  pattern: RegExp;
  handler: (req: ParsedRequest, api: TierControlApiImpl) => Promise<ApiResponse<any>>;
}

interface RouteContext {
  api: TierControlApiImpl;
  tierManager: TierManager;
  projectPath: string;
  getProjectManager(): ProjectManager;
  getSessionStore(): AgentSessionStore;
  getEventStore(): EventStore;
}

// API responses
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
  meta: { timestamp: Date; requestId: string; durationMs: number };
}
```
