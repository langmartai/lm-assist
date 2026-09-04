# UI panes — Claude hands you a live dashboard, mid-conversation

The most distinctive door in lm-assist: **pluggable UI pages**. Every dashboard is also a
self-contained page with its own URL on the platform gateway — so a Claude session
(claude.ai conversation, Cowork session, or Claude Code local/remote) can *show you UI*
instead of describing things in text.

> **You:** how are the missions connected? show me.
>
> **Claude:** *(lm-assist → ui_list)* Here's your live mission graph:
> `https://ui-<your-key>-assist-mission-graph.langmart.ai`

Click it, sign in once (platform SSO), and you're looking at the real thing — interactive,
current, from anywhere:

![The mission-graph pane served on its own URL — content masked](./ui-pane-mission-graph-masked.png)

## What ships as panes

22 first-party pages are registered out of the box — Sessions, Session Dashboard, Projects,
Tasks, Missions, Mission Graph, Mission Processes, Scheduler, Backlog, Search, Knowledge,
Memory & Rules, Content, Clusters, Data, MCP Tools, Skills, and the UI Pages manager itself,
plus account-level pages (Home, API Keys, Machines, WhatsApp). Each is independently
addressable: `https://ui-<your-key>-<page>.langmart.ai`.

## The tools a session uses

> **You:** which of my dashboards are actually up right now?
>
> **Claude:** *(lm-assist → ui_list, ui_pages)* All 22 registered pages are live on the gateway,
> and this node's local servers are alive for every page it hosts — nothing stale, nothing
> waiting on a respawn. Each entry comes with its gateway URL if you want one.

> **You:** publish that little cost dashboard we just built on this node
>
> **Claude:** *(lm-assist → ui_register, ui_screenshot)* Registered it as `cost-dash` under your
> account — the gateway returned `https://ui-<your-key>-cost-dash.langmart.ai`, no DNS step
> needed. I granted it exactly the two API endpoints it renders from, and uploaded a catalog
> screenshot so it looks right on the management page.

> **You:** take the old prototype offline, but don't delete anything
>
> **Claude:** *(lm-assist → ui_enable)* Disabled it platform-wide — its URL stops serving for
> everyone, while the registration, grants, and local files all remain. Say the word and I flip
> it back on. If you'd rather just stop its local server on this node, that's a separate switch.

Tools involved: ui_list, ui_pages, ui_register, ui_enable, ui_pages_control, ui_screenshot

Because registering is just a tool call, a session can go further than showing the built-in
pages: scaffold a small page on a node, register it, and hand you the URL — a purpose-built
dashboard that didn't exist when the conversation started.

## How it stays safe

- Every pane runs under **per-page API grants**: the gateway relay reaches the node's API as
  the owner, so each page is granted exactly the endpoints it renders from — nothing more.
  Grants are part of the pane's definition and are enforced on the hub path.
- Pages are **SSO-gated** on the platform; a node-local tier exists for LAN/dev access with
  short-lived, single-redemption entry tokens.
- `scope: assist-web` pages are gateway-hosted — they serve even when no node is up; the
  node-scoped pages serve from their owning machine and auto-respawn when its Core boots.
