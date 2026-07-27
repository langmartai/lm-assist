# LinkedIn Connector (CDP / driven browser)

lm-assist can read and act on the operator's **own** LinkedIn account, exposed as
MCP tools that ride the same hub relay as the rest of the connectors. Once the
node has a logged-in LinkedIn browser profile, the `linkedin_*` tools appear in
any Claude Code / claude.ai session connected to this node.

Unlike WhatsApp, **there is no personal LinkedIn API** — LinkedIn offers no
usable messaging/posting endpoint for an individual account. So this connector
has a **single provider, `cdp`**: it drives a real, logged-in `linkedin.com`
session in Chrome over the **Chrome DevTools Protocol** and mirrors what it reads
into the shared message store.

## How it fits the architecture

```
claude.ai / Claude Code
  └─ mcp__…_lm-assist_…_linkedin_*            (MCP tools)
       └─ LangMart hub  ──api_relay──▶  Core  (/linkedin/* on loopback)
                                          └─ cdp-client.ts ──CDP──▶ Chrome (port 9223)
                                                                      └─ linkedin.com  (the operator's session)
```

- **Reads** (conversations, thread messages, feed, notifications, people search)
  come from what the rendered page exposes. LinkedIn virtualizes its lists, so a
  read captures the most-recent RENDERED items and **accumulates in the store
  across calls** — there is no "fetch history" endpoint.
- **Writes** drive the real UI: send a message, publish a feed post, publish a
  long-form Article, follow/connect, comment, delete a post.

Each MCP tool wraps this node's own `/linkedin/*` REST route on loopback (single
source of truth), so identical behavior is reachable from the stdio MCP, the HTTP
`/mcp` endpoint, and remotely via the hub relay.

## Tools & scopes

16 tools. Reads observe; writes publish/message/connect; `linkedin_login` drives
interactive auth.

| Tool | Scope | Purpose |
|------|-------|---------|
| `linkedin_status` | read | Provider, login state, signed-in name, ingested counts. Check before sending/posting. |
| `linkedin_list_conversations` | read | Recent messaging threads (accumulates across calls). |
| `linkedin_read_messages` | read | Messages in one thread. |
| `linkedin_search` | read | Search ingested messages. |
| `linkedin_read_feed` | read | Recent rendered feed items. |
| `linkedin_read_notifications` | read | Recent notifications. |
| `linkedin_search_people` | read | Search for people (name, handle, URL, headline). |
| `linkedin_send_message` | write | Send a message in an existing thread. |
| `linkedin_post` | write | Publish a feed post. |
| `linkedin_publish_article` | write | Publish a long-form Article. |
| `linkedin_follow` | write | Follow a profile/page. |
| `linkedin_connect` | write | Send a connection request. |
| `linkedin_message_profile` | write | Open/start a thread with a profile and message it. |
| `linkedin_comment` | write | Comment on a post. |
| `linkedin_delete_post` | write | Delete one of your own posts. |
| `linkedin_login` | admin | Launch a controlled Chrome so the user can log in. |

REST routes (all under Core, loopback): `GET /linkedin/status`,
`GET /linkedin/conversations`, `GET /linkedin/messages`, `GET /linkedin/search`,
`POST /linkedin/send`, `GET /linkedin/feed`, `GET /linkedin/notifications`,
`POST /linkedin/post`, `POST /linkedin/article`, `POST /linkedin/login`,
`GET /linkedin/login/status`, `GET /linkedin/people`, `POST /linkedin/follow`,
`POST /linkedin/connect`, `POST /linkedin/message-profile`,
`POST /linkedin/comment`, `POST /linkedin/delete-post`, `POST /linkedin/keepalive`.

## The dedicated Chrome profile (port 9223)

The connector runs its **own** persistent Chrome profile under
`~/.lm-assist/linkedin/` (`linkedin-dev/` when running from the repo), on debug
port **9223** — deliberately distinct from the WhatsApp connector's 9222 and from
the user's everyday Chrome. The login (an ordinary LinkedIn email/password
session, plus 2FA if enabled — no QR) is persisted in that profile, so it
**survives Core restarts**: log in once, and the driveable session stays good.

This is why the shared browser launcher grew a `userDataDir` option: `'isolated'`
is a single shared dir and `'Default'` would collide with the user's own Chrome,
so the connector passes an explicit persistent dir instead.

Env overrides (forward-compat): `LINKEDIN_CDP_URL`, `LINKEDIN_CDP_PORT`
(default 9223), `LINKEDIN_PROVIDER` (default `cdp`).

## One-time login

```bash
# dev :3200 (repo) / prod :3100 (npm). Use the matching API token.
curl -X POST localhost:3200/linkedin/login -H "x-api-key: $LM_API_KEY"
```

If the profile is already authenticated this returns `loggedIn:true` with no
further action. Otherwise a Chrome window opens at linkedin.com for the user to
log in (email / password / 2FA); then poll status until it flips:

```bash
curl localhost:3200/linkedin/status -H "x-api-key: $LM_API_KEY"
# → { "provider":"cdp", "backend":"cdp-browser", "loggedIn": true|false, ... }
```

`loggedIn:false` is the correct answer on any node that has never had a LinkedIn
browser profile (e.g. a headless container) — it is not an error, just "run
`linkedin_login` first". Interactive login requires a headed browser, so it runs
on the machine that hosts the profile (in this deployment, a Windows host).

## 15-minute session keep-alive

LinkedIn expires idle sessions, so a keep-alive touches the driven page on an
interval (default ~15 minutes) to keep the logged-in session warm between calls
(`POST /linkedin/keepalive`; `keepalive.ts`). This means the one-time login
generally holds without re-authenticating, as long as Core keeps running.

## Usage

```bash
curl "localhost:3200/linkedin/conversations" -H "x-api-key: $LM_API_KEY"
curl "localhost:3200/linkedin/messages?thread=<id>" -H "x-api-key: $LM_API_KEY"
curl -X POST localhost:3200/linkedin/post -H "x-api-key: $LM_API_KEY" \
  -H 'Content-Type: application/json' -d '{"text":"Shipping notes for this week…"}'
```

Or, from a connected Claude session: *"post to LinkedIn: …"*, *"read my LinkedIn
messages"*, *"any new LinkedIn notifications?"*, *"connect with <person>"*.

## Notes & limits

- **No personal API**: everything is UI automation of the operator's own logged-in
  session — there is no LinkedIn messaging/posting API for individuals.
- **Reads are rendered snapshots**: LinkedIn virtualizes lists, so reads capture
  the most-recent rendered items and accumulate over time; there is no backfill of
  older history.
- **Storage**: ingested messages + read-state live node-locally under
  `~/.lm-assist/linkedin[-dev]/`.
- **Headed login**: launching the login browser needs a display; on a headless
  node it will report it cannot open a GUI browser. Log in on the host that owns
  the profile.
