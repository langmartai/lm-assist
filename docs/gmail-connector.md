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

39 tools. Reads observe the mailbox; writes send real mail or mutate threads;
`gmail_login` drives interactive auth.

| Tool | Scope | Purpose |
|---|---|---|
| `gmail_status` | read | provider, logged-in state, signed-in address, watch state |
| `gmail_summary` | read | account snapshot — label/draft/inbox counts, what arrived, unread |
| `gmail_list_threads` | read | threads in a view (default inbox), newest first |
| `gmail_read_thread` | read | open one thread, return its messages |
| `gmail_search` | read | Gmail's own query syntax (`from:`, `is:unread`, …) |
| `gmail_search_local` | read | search the local cache — no browser, no Gmail round-trip |
| `gmail_labels` | read | labels from the left nav |
| `gmail_aliases` | read | send-as addresses on the account |
| `gmail_drafts` | read | list saved drafts |
| `gmail_attachments` | read | attachment metadata on a thread (names/types, not bytes) |
| `gmail_attachment_download` | read | download one attachment's BYTES to disk; returns the path, not the file |
| `gmail_selfcheck` | read | internal validation sweep over the endpoints |
| `gmail_settings` | read | audit signature / vacation / forwarding / filters — never writes |
| `gmail_sync` / `gmail_sync_status` | read | populate + report on the local cache |
| `gmail_send` | write | compose and send a new message (attachments supported) |
| `gmail_reply` | write | reply to an existing thread |
| `gmail_forward` | write | forward a thread to new recipients |
| `gmail_schedule_send` | write | compose and send LATER (Gmail's Schedule send) |
| `gmail_schedule_cancel` | write | un-schedule a pending send — returns it to Drafts, undelivered |
| `gmail_draft` | write | compose and save a draft, sending nothing |
| `gmail_draft_send` · `gmail_draft_delete` | write | send or discard a saved draft — completes the lifecycle |
| `gmail_archive` · `gmail_trash` · `gmail_spam` | write | move a thread out of the inbox |
| `gmail_bulk` | write | one verb (archive/trash/read/unread/star/unstar) over up to 25 threads |
| `gmail_untrash` | write | restore a thread OUT of Trash (only while it is still there) |
| `gmail_mark_read` · `gmail_star` | write | per-thread state |
| `gmail_triage` | write | mute/unmute, important/unimportant, **snooze** |
| `gmail_apply_label` · `gmail_remove_label` · `gmail_create_label` · `gmail_move_to` | write | label management |
| `gmail_rename_label` · `gmail_delete_label` | write | rename/delete a label via Settings → Labels |
| `gmail_login` | admin | launch a browser for the one-time sign-in |

`gmail_unread` is deliberately **not** a tool — it is exactly
`gmail_search("is:unread")`, and the advertised tool list is a connect-time cost paid
by every conversation. Its trigger words live on `gmail_search`.

## REST routes

`GET /gmail/status` · `GET /gmail/summary?window=&refresh=` · `GET /gmail/threads?limit=&label=` ·
`GET /gmail/thread?id=` · `GET /gmail/search?q=&limit=` · `GET /gmail/search-local` ·
`GET /gmail/unread?limit=` · `GET /gmail/labels` · `GET /gmail/aliases` · `GET /gmail/drafts` ·
`GET /gmail/attachments` · `POST /gmail/attachment/download` · `GET /gmail/settings?filters=` · `GET /gmail/selfcheck` · `GET /gmail/sync-status` · `POST /gmail/sync` ·
`POST /gmail/send` · `POST /gmail/schedule-send` · `POST /gmail/schedule-cancel` · `POST /gmail/reply` · `POST /gmail/forward` · `POST /gmail/draft` ·
`POST /gmail/draft/send` · `POST /gmail/draft/delete` · `POST /gmail/triage` ·
`POST /gmail/archive` · `POST /gmail/trash` · `POST /gmail/untrash` · `POST /gmail/spam` · `POST /gmail/mark-read` ·
`POST /gmail/star` · `POST /gmail/bulk` · `POST /gmail/move-to` · `POST /gmail/label/apply` ·
`POST /gmail/label/remove` · `POST /gmail/label/create` · `POST /gmail/label/rename` · `POST /gmail/label/delete` ·
`POST /gmail/login` ·
`GET /gmail/login/status?port=` · `POST /gmail/keepalive`

(`/gmail/unread` and `/gmail/keepalive` have no MCP tool — REST only.)

🔴 **Attachment downloads return a PATH, never the bytes.** The file is written on the node
that ran the call (default `<GM_DATA_DIR>/downloads/<threadId>/`), so a *remote* node's download
is not readable from here — fetch it, or run the call on the node you want the file on.
`inline: true` adds base64 but refuses above 256 KB rather than truncating.

🔴 **Snooze lives on `/gmail/triage`, not a `/gmail/snooze` route.** A caller reaching for
the obvious path gets `Route not found`, which reads like a missing feature.

🔴 **`BROWSER_BUSY` is normal, not a fault.** One browser serves every Gmail call, so a
sync or an auto-sync triggered by an arrival push holds it — a 30-day sync measured 255s.
The lock waits up to 120s, then refuses rather than queueing forever. Retry.

## Environment

| Var | Default | Effect |
|---|---|---|
| `GMAIL_CDP_PORT` | `9224` | debug port of the driver browser |
| `GMAIL_CDP_URL` | — | full CDP base; wins over the port |
| `GMAIL_KEEPALIVE_MIN` | `15` | keep-alive interval in minutes; `0` disables |
| `GMAIL_PROVIDER` | `cdp` | provider name (forward-compat) |
| `LM_ASSIST_PROD` | — | `true` forces prod paths (no `-dev` suffix) |

## Attachment bytes — measured 2026-07-31

`gmail_attachments` yields a `downloadUrl` of the `view=att` form. Which `disp` it carries
decides whether you get the file or garbage:

| `disp` | result on a 38-byte text attachment |
|---|---|
| `safe` | 38 bytes, `content-disposition: attachment; filename="…"` — **the real file** |
| `attd` | identical to `safe` |
| `inline` | 294 bytes of padding — **not the file**, and it still returns HTTP 200 |

So an *observed* URL is used as-is and only `disp=inline` is rewritten to `attd`. The fetch runs
INSIDE the page: that is what carries Gmail's session cookies, and there is no token to hand a
server-side HTTP client.

🔴 **`sizeBytes` in the listing is Gmail's ROUNDED label, not the true size** — measured `1024`
for a 38-byte file and `700416` for a 700,000-byte one. `gmail_attachment_download` returns the
true `bytes` alongside `reportedSizeBytes` so the gap cannot be misread as a truncated download.

Verified end-to-end on 123 (Linux) and 107 (Windows): a 700,000-byte binary containing NUL, CR and
LF round-tripped **byte-identical** (sha256 equal on both nodes), crossing the 256 KB chunk boundary
three times.

## Restoring and label surgery — measured 2026-08-01

🔴 **`move-to {label:"inbox"}` cannot untrash.** Gmail's All Mail (`#all`) EXCLUDES Trash and
Spam, and the row selector only searched `#inbox`/`#all` — so restoring a trashed thread failed
with `ROW_NOT_SELECTABLE` while the thread sat in `#trash` the whole time. `gmail_untrash` is the
same machinery scoped to `#trash`. A thread purged from Trash (30 days) is unrecoverable.

🔴 **Label rename/delete live on the Settings → Labels page**, not the left-nav hover menu — the
hover overflow control never rendered under automation. Two traps there, both of which produce a
silent no-op rather than an error:

- the name cell carries a trailing conversation count (`"Paypal 88 conversations"`), so an exact
  compare against the label name never matches;
- the page is long — the `edit`/`remove` controls sat at **y≈4700** on a 1080 viewport, so clicking
  their raw coordinates lands outside the window and opens nothing. Scroll first, re-read the rect,
  then click.

Both dialogs are `role="alertdialog"`: edit shows a pre-filled input with **Cancel/Save**, remove
shows `Delete the label "X"?` with **Cancel/Delete**. Deleting a label does **not** delete mail.

A nested label's real name is its FULL path (`Parent/Child`) — that is what both verbs expect.

## Schedule send and the settings audit — measured 2026-08-01

**Schedule send** is `More send options` (aria-label) -> `Schedule send` -> a preset. Confirmed
reachable before the picker had ever been seen: clicking it with no recipient raises Gmail's own
`Please specify at least one recipient` dialog.

🔴 **The two time pickers format their rows DIFFERENTLY**, which punishes copying a pattern across:

| picker | measured row text |
|---|---|
| snooze | `TomorrowSat, 8:00 AM` — **no separator** |
| schedule send | `Tomorrow morning Aug 2, 8:00 AM` — with a space |

A bare prefix (`^Tomorrow`) matches both. A `\b`-terminated pattern works for schedule send and
**silently fails** for snooze, because in `TomorrowSat` the `w`→`S` junction is not a word boundary.
Which presets exist also depends on the time of day, so a miss reports what the picker offered.

**`gmail_settings`** is READ ONLY by design — every write there changes how the mailbox behaves for
everyone who mails the operator. It reads signature, vacation responder, forwarding and filters, via
aria-label anchors (`aria-label="Signature"`, `aria-label="Vacation responder"`) rather than hashable
class names.

🔴 **It distinguishes "none configured" from "could not read".** An unexpected forwarding address is
a classic account-compromise signal, so reporting an empty list for an unreadable page would be the
most dangerous possible output — `forwarding.read` and `vacation.enabled: null` carry that. Filters
are capped (default 40) with the true `total` always reported; this account has 275.

## 🔴 Adding a Gmail (or any) MCP tool — the step that takes a node DOWN

A new tool needs an entry in **`TOOL_SCOPES`** (`core/src/mcp-server/configure.ts`) as well as its
def + handler. Miss it and `assertScopesCoverTools()` throws **while the MCP server is being
built** — so Core does not merely reject the call, it **CRASHES on every `tools/list`**.

MEASURED 2026-08-01, six Gmail tools shipped without scopes. What that looks like from the outside,
three hops away from the cause:

| where you look | what you see |
|---|---|
| the connector | bare `502 Bad gateway` from Anthropic's MCP proxy |
| hub gateway-type1 | `Worker disconnected` / `no connected lm-assist node for this user` |
| `mcp.langmart.ai`, `assist-api`, `/health` | all **healthy** — nothing points at the worker |
| the node | `lm-assist` Core dead, `TOOL_SCOPES missing entries for: …` in `core-prod.log` |

It is indistinguishable from a hub outage, and `docs/mcp-surfaces.md` says exactly this: *"If Core
is down the relay has nowhere to land and the connector errors with 'MCP down', even though
`mcp.langmart.ai` and the hub are healthy."* **Check the worker's own log first.**

Why it escaped testing: the tools were exercised through their REST routes, which never build the
MCP server. Only an MCP request does. `core/src/__tests__/mcp-tool-scopes.test.ts` now runs the
assertion at `npm test`.

## 🔴 `loggedIn: false` used to mean two different things

`GET /gmail/status` probes the live browser over CDP. When that probe failed it
reported `loggedIn: false` — which collapsed two states an operator must tell apart:

| what actually happened | what to do |
|---|---|
| the browser process is dead, credential intact | **relaunch** (`gmail_login`, no human needed) |
| the profile is genuinely signed out | **sign in** (a human types credentials) |

MEASURED 2026-08-01: Core restarts kill the Gmail browser on Linux (Chrome is a
child in Core's cgroup; Windows re-parents and survives). Both 117 and 123 then read
`loggedIn:false` — yet 123's profile was fully authenticated and `gmail_login`
restored it in SECONDS with no interaction. The credential had never gone anywhere.

Status now answers with four fields instead of one:

- `loggedIn` — `true` / `false` / **`null` when UNKNOWN** (no browser to ask).
  A caller treating `null` as "signed out" sends a human to re-authenticate for nothing.
- `browserRunning` — was the CDP probe reachable at all
- `credentialOnDisk` — does the driver profile hold a persisted Google session
  (pure disk state, answers with no browser running)
- `needsAction` — `relaunch` / `sign-in` / `null`, so the caller need not infer it

## Cancelling a scheduled send — measured 2026-08-02

🔴 **The `#scheduled` LIST toolbar has no cancel affordance.** With a row selected it
offers Mark as unread / Snooze / Add to Tasks / Move to Inbox / Labels — nothing else.
`Cancel send` exists ONLY once the message is OPEN. So the select-the-row pattern that
untrash and the triage verbs use cannot work here; the row must be clicked open first.

🔴 **And it cannot be opened by URL.** The opened hash is `#scheduled/<KtbxL…>`, an id
unrelated to the legacy thread id, so there is nothing to construct a URL from — the
same conclusion `openDraft` reached for drafts. Land on the list, find the row by
legacy id, click it, then trusted-click `Cancel send`.

Verified against a real pending send: `#scheduled` 1 → 0, the message reappeared in
Drafts undelivered, and the verb reports `verified` from that absence rather than from
the click.

## Bulk — what `succeeded` does and does not mean

`gmail_bulk` runs one verb over up to 25 threads, SEQUENTIALLY (they mutate one
shared DOM; concurrent clicks would race over which view is visible).

🔴 **Only CONFIRMED changes count as succeeded.** A thread whose change could not be
re-read lands in `failed` with an `UNVERIFIED:` prefix — and the verb STOPS rather
than re-applying, because a blind retry on a toggle can undo the thing it just did.
Measured on a live run: `succeeded: 2` of 3 while an independent listing showed all
3 starred. It UNDER-reports rather than over-reports, deliberately.

🔴 **Ids past the cap are REPORTED, never dropped.** A capped call that trims its
input and returns a short success list is indistinguishable from partial success.
Every id beyond 25 comes back in `failed` as `BULK_CAP_EXCEEDED`.

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
