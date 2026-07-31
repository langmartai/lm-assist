# Gmail Connector (CDP / driven browser)

lm-assist can read and act on the operator's **own** Gmail account, exposed as MCP
tools that ride the same hub relay as the rest of the connectors. Once the node has
a logged-in Gmail browser profile, the `gmail_*` tools appear in any Claude Code /
claude.ai session connected to this node.

Like the LinkedIn connector, this drives a real logged-in `mail.google.com` session
in Chrome over the **Chrome DevTools Protocol**. Unlike LinkedIn — where the choice
is forced because no personal API exists — Gmail *does* have an official API, so
the browser-driven approach here is a deliberate decision. See below for what was
measured and why.

## How it fits the architecture

```
claude.ai / Claude Code
  └─ mcp__…_lm-assist_…_gmail_*                (MCP tools)
       └─ LangMart hub  ──api_relay──▶  Core   (/gmail/* on loopback)
                                          └─ cdp-client.ts ──CDP──▶ Chrome (port 9224)
                                                                      └─ mail.google.com (the operator's session)
```

Each MCP tool wraps this node's own `/gmail/*` REST route on loopback (single source
of truth), so identical behavior is reachable from the stdio MCP, the HTTP `/mcp`
endpoint, and remotely via the hub relay.

**There is no local message store.** LinkedIn needs one because it cannot backfill
history; Gmail can, and it owns read-state server-side, so mirroring it locally would
only produce state that goes stale. Every read here is a live read.

## The endpoint decision — why the DOM, measured 2026-07-29

The obvious plan is to drive Gmail's own JSON feeds, the way the SPA does. That plan
does not survive contact. Probed from inside a logged-in page (same-origin,
cookie-authed) against a real Workspace account:

| probe | result | verdict |
|---|---|---|
| `/mail/u/0/h/` (basic HTML Gmail) | 200, then redirects to the SPA (~1.4 MB) | **retired** — Google removed it in 2024 |
| `?ui=2&ik=<ik>&view=tl&rt=j` | 200, `content-type: text/html`, the SPA shell | **no longer returns JSON** |
| `POST /sync/u/0/i/fd?rt=r` | 400, `application/vnd.google.octet-stream-compressible` | binary **protobuf**, undocumented wire format |

Seeing the SPA *call* an endpoint is not evidence a third party can *use* it. All
three are effectively closed, so this connector reads the rendered DOM.

That turns out to be a good surface. Gmail keeps its long-stable legacy class names
and — better than LinkedIn — exposes real server ids as data attributes:

- thread rows `tr.zA` (unread adds `zE`), sender `.yX span[email]`, subject `.y6 span`,
  snippet `.y2`, and **`data-legacy-thread-id`**;
- open thread: subject `h2.hP`, messages `.adn.ads`, sender `.gD[name][email]`,
  timestamp `.g3[title]`, body `.a3s.aiL`, and **`data-legacy-message-id`**.

So threads are keyed on real Gmail ids, not synthesized from a display name.

Navigation is **hash-based** (`#inbox`, `#label/<name>`, `#search/<query>`,
`#all/<threadId>`), which makes routing deterministic. Notably **search is a URL
change, not typing into the search box** — far more robust than UI choreography.

All selectors live in one `SELECTORS` object in `core/src/gmail/cdp-client.ts`. Fix
breakage there, never inline.

## Setup — one-time login

```bash
# via MCP
gmail_login                      # headed browser opens at mail.google.com
# …user signs in with the Google account + 2FA…
gmail_status                     # poll until loggedIn:true
```

The session persists in a dedicated Chrome profile at
`~/.lm-assist/gmail[-dev]/login-profile/<name>/`, on debug port **9224** (distinct
from WhatsApp's 9222 and LinkedIn's 9223 — all three can run side by side).

## Per-node readiness — WHICH node can serve a Gmail call

🔴 **A Gmail tool only works on a node that has a signed-in browser of its own.**
The login lives in a Chrome profile on one machine; it does not travel with the
branch and it is not fleet state. Deploying the code to a node does NOT make that
node able to read mail.

That matters because every `gmail_*` call routes to exactly ONE node — your default
node unless you pass `node`. So the failure mode is: the code is installed
everywhere, the default node has no login, and every call fails there while another
node would have answered.

There is no fleet-wide readiness call — `node` selects a single node per call. Ask
each one:

```bash
list_nodes                      # which nodes exist
gmail_status node=<hostId>      # per node: loggedIn true/false, and which account
# use a node whose loggedIn is true; if none, gmail_login on the node you want
```

`gmail_status` is the authority, not the presence of the tools: the tools are
advertised by any node running the code, signed in or not.

**Measured 2026-07-31**, the current fleet:

| node | code | signed in | notes |
|---|---|---|---|
| 123 (`yitest`, Linux) | yes | **yes** | primary validation host |
| 107 (`DESKTOP-GDKLATG`, Windows) | yes | **yes** | profile survived a Core restart |
| 117 (`ubuntu-Virtual-Machine`, prod) | yes | **no** | deployed 2026-07-31; run `gmail_login` there to use it |

A call that lands on a node without a login now fails with **`BROWSER_NOT_RUNNING`**,
which names the fix rather than surfacing an opaque `fetch failed`.

🔴 **Whether a Core restart costs you the browser is PLATFORM-SPECIFIC.** MEASURED
2026-07-31, same deploy, both nodes:

| platform | after `lm-assist restart` |
|---|---|
| Linux (123) | Chrome is a child of Core and **dies with it** — `gmail_status` goes `loggedIn:false`, re-run `gmail_login` |
| Windows (107) | Chrome **re-parents itself and survives** — came back `loggedIn:true`, and a `gmail_login` returns 400 because port 9224 is still attached |

Either way the profile persists, so recovery never needs a new sign-in. Do not
generalise from one platform: the first draft of this note said a restart always
kills the browser, which is simply false on Windows.

## Deploy and e2e verification

Deploying is a dist sync, not `npm i -g` (see `docs/build-pack-install-upgrade.md`):

```bash
# on a build host, from the branch
npm run build:core                       # tsc AND copy-voice-assets
#   🔴 running tsc alone then `rsync --delete` STRIPS the voice assets from the
#   install. Compare the trees before syncing.
sudo rsync -a --delete core/dist/ <install>/core/dist/
lm-assist restart                        # kills the Gmail browser; re-login after
```

Then verify, in this order — each step is a precondition for the next:

```bash
curl -s localhost:3100/health                    # Core is up
gmail_status node=<n>                            # routes registered; loggedIn?
gmail_login node=<n>                             # only if loggedIn:false
gmail_selfcheck node=<n>                         # the canary: 11 checks
```

`gmail_selfcheck` is the real gate. It drives the live UI and fails closed on
drift — a green `/health` proves only that the process booted. Anything less than
11/11 means the connector is mis-reading Gmail even when individual calls look
fine.

**Verified 2026-07-29** on a real Workspace account, on both a Windows host and a
Linux host: Google does **not** refuse a sign-in in a Chrome launched with a custom
`--user-data-dir` and an open `--remote-debugging-port`, and the session survives a
restart. A headed one-time login followed by **headless** operation against the same
profile lands straight back in the inbox.

### Headless requires a normal User-Agent

With the default `HeadlessChrome/...` UA, Google serves the degraded
`flowName=WebLiteSignIn` flow; with a normal UA it serves the full `GlifWebSignIn`.
`gmail_login` forces `HEADLESS_UA` (config.ts) whenever `headless:true`. This is the
same class of problem the existing `/browser/switch-to-headless` route already solves
for Cloudflare.

### Windows: the launched pid is not the browser

Chrome re-parents itself on Windows, so the pid returned by `gmail_login` may already
be gone while the browser is still running (this is what the `isPidAlive` fix in PR #6
exists for). Trust `gmail_status`, not the pid.

## Tools & scopes

9 tools. Reads observe the mailbox; writes send real mail; `gmail_login` drives
interactive auth.

| Tool | Scope | Purpose |
|---|---|---|
| `gmail_status` | read | provider, logged-in state, signed-in address |
| `gmail_list_threads` | read | threads in a view (default inbox), newest first |
| `gmail_read_thread` | read | open one thread, return its messages |
| `gmail_search` | read | Gmail's own query syntax (`from:`, `is:unread`, …) |
| `gmail_labels` | read | labels from the left nav |
| `gmail_send` | write | compose and send a new message |
| `gmail_reply` | write | reply to an existing thread |
| `gmail_draft` | write | compose and save a draft, sending nothing |
| `gmail_login` | admin | launch a browser for the one-time sign-in |

`gmail_unread` is deliberately **not** a tool — it is exactly
`gmail_search("is:unread")`, and the advertised tool list is a connect-time cost paid
by every conversation. Its trigger words live on `gmail_search`.

## REST routes

`GET /gmail/status` · `GET /gmail/threads?limit=&label=` · `GET /gmail/thread?id=` ·
`GET /gmail/search?q=&limit=` · `GET /gmail/unread?limit=` · `GET /gmail/labels` ·
`POST /gmail/send` · `POST /gmail/reply` · `POST /gmail/draft` · `POST /gmail/login` ·
`GET /gmail/login/status?port=` · `POST /gmail/keepalive`

(`/gmail/unread` and `/gmail/keepalive` have no MCP tool — REST only.)

## Environment

| Var | Default | Effect |
|---|---|---|
| `GMAIL_CDP_PORT` | `9224` | debug port of the driver browser |
| `GMAIL_CDP_URL` | — | full CDP base; wins over the port |
| `GMAIL_KEEPALIVE_MIN` | `15` | keep-alive interval in minutes; `0` disables |
| `GMAIL_PROVIDER` | `cdp` | provider name (forward-compat) |
| `LM_ASSIST_PROD` | — | `true` forces prod paths (no `-dev` suffix) |

## Limits and caveats

- **The thread list is virtualized.** A read returns the most-recent RENDERED threads
  up to `limit` — it is not full history. `gmail_list_threads` scrolls to force render,
  and the tool result says when it hit the cap. Use `gmail_search` to reach older mail.
- **Writes are real and immediate.** `gmail_send` and `gmail_reply` deliver from the
  operator's actual account with no undo. Prefer `gmail_draft` when the user wants to
  review first.
- **No rate limiting.** Neither this connector nor the LinkedIn one throttles. Gmail is
  more sensitive than LinkedIn about automation; the SPA also opens
  `waa-pa.clients6.google.com/$rpc/…/Waa/Create` (Web App Attestation, Google's
  anti-abuse channel), which is a detection surface LinkedIn never had.
- **Selectors are time-stamped assertions, not guarantees.** They were verified live on
  2026-07-29 against one Workspace account. Gmail ships UI changes; when a read goes
  empty, check `SELECTORS` first.
- **Attachments, HTML bodies, and label mutation are not implemented.** Bodies are
  returned as rendered text (`innerText`), capped at 20 000 chars per message.

## Validation status

**Updated 2026-07-31.** Verified LIVE, each by an INDEPENDENT read (a view listing
or a row state), never the tool's own return value — several of these tools
reported success while doing nothing before that rule was applied.

| Check | Where | Result |
|---|---|---|
| `gmail_selfcheck` (11 checks) | 123 **and** 107 | **11/11 pass on both** |
| `tsc --noEmit`, scope parity, catalogue budget | 123 | clean |
| page-script compile tests | 123 | 27/27 (all 10 embedded page scripts) |
| `gmail_status` / `list_threads` / `read_thread` / `search` | 123, 107 live | real data; A→B→A reads 3/3 correct |
| `gmail_send` | 123 live | **real delivery**, body + markdown intact |
| `gmail_reply` | 123 live | landed in-thread (1→2 messages) with body |
| `gmail_draft` | 123 live | body in the canonical Message Body |
| `archive` / `trash` / `star` / `mark_read` | 123 live | each confirmed by view membership |
| `apply_label` / `remove_label` / `create_label` / `move_to` | 123 live | `verified:true` via the chip reader |
| `gmail_sync` / `sync_status` / `search_local` | 123 live | 45 threads, `complete:true`; ranked local matches |
| `gmail_attachments` | 123 live | metadata + signed URLs (`size` unpopulated) |
| `gmail_spam` | — | **deliberately never exercised**: marking the operator's own address as spam trains Google's filter against their real mail, with no API undo. A successful test is worse than no test. |
| 117 (prod) | deployed 2026-07-31 | routes + MCP live; **not signed in** |
