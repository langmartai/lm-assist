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

| Check | Where | Result |
|---|---|---|
| `tsc --noEmit` | 123 | clean |
| scope parity + catalog completeness | 123 | 15/15 tests pass |
| Core boots, `/gmail/*` registers | 123, non-prod port 3399 | pass |
| `gmail_status` | 123, live | `loggedIn:true`, correct account |
| `gmail_list_threads`, `gmail_read_thread`, `gmail_search` | 123, live | real data returned |
| `gmail_send` / `gmail_reply` / `gmail_draft` | — | **NOT exercised live** — they write to a real mailbox |
| Windows (headed) end-to-end | 107 | login verified; read/write path not yet run |
