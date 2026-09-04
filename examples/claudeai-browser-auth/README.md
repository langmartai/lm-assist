# claude.ai browser authentication — and what it unlocks automatically

Goal: give a node a real claude.ai web session (the browser cookie), so the 28-endpoint claude.ai
proxy works — conversations, rename, token measurement, fork, org settings, voice — and so the
node can maintain your claude.ai connector for you.

## One-time: capture the session from a real browser

From any connected Claude session:

> **You:** my claude.ai cookie on this machine expired — can you fix it?
>
> **Claude:** *(lm-assist → claudeai_login)* This node has a desktop browser, so I've opened a
> controlled Chrome window at claude.ai — sign in there normally and the session cookie is
> captured into the node's credential store. Done? I just re-checked: the claude.ai session is
> healthy, cookie valid for about 29 more days.

> **You:** and the headless linux box?
>
> **Claude:** *(lm-assist → claudeai_login)* No desktop browser there, so here are the exact
> manual steps instead: copy the `Cookie:` header from DevTools in a logged-in browser into
> `~/.claude/claudeai-session.json` on that node. One caveat — the cookie is IP-pinned to the
> host that captured it, so capture it on the node that will use it.

- On a node with a desktop browser, the login launches a controlled browser at claude.ai
  (`POST /claude-ai/browser/launch-and-capture`) — sign in normally, and the session cookie is
  captured into the node's credential store. It never types your credentials.
- On a headless node, you get the exact manual steps instead, as above.
- The tool re-checks `/claude-ai/healthz` at the end so you see the result immediately.

Tools involved: claudeai_login

## Kept fresh automatically

The **auth monitor** runs browser-free in the background: it proactively renews the Claude Code
OAuth token before expiry and tracks claude.ai cookie health (including when the session expires)
into a per-node snapshot. One question sweeps the whole fleet:

> **You:** are all my machines still logged in?
>
> **Claude:** *(lm-assist → auth_status)* Swept all three connected nodes — laptop: OAuth valid
> (renews in 6h), claude.ai cookie healthy. linux-box: OAuth valid, cookie expires in 4 days.
> windows-desk: OAuth valid, but no claude.ai cookie captured yet — want me to run the login
> flow there?

Tools involved: auth_status

The Settings → Connection page shows the node's hub link and key state at a glance:

![Connection status page](./settings-connection.png)

## The automatic part: connector upkeep

Once a node holds a valid claude.ai cookie, lm-assist maintains your claude.ai connector without
manual steps. claude.ai keeps three layers of per-account state that used to require a manual
chain every time the tool surface changed; when a plugin's tools appear or disappear, the node now
runs the whole chain itself:

1. clear the connector's cached tool list
2. force the bootstrap refetch (claude.ai re-pulls `tools/list`)
3. enable account-level tool access for the new tools
4. mark them auto-approved so driven calls don't die on "No approval received"

Every step is an idempotent read-modify-write against claude.ai's own APIs, through the captured
cookie. On a node with no cookie the sync is deferred, not failed — another node (or a manual
`POST /mcp-plugins/sync-connector`) can complete it.
