# assist-whatsapp

The WhatsApp pane: chat list, message history for the selected chat, connection status, and a
composer. A single-file pane — everything lives in `index.html`, with the shared `assets/lmui.js`
shim for the data plane. Scope is `assist-web` (the assist product's own pages), not `lm-assist`.

## Grant

Two rules in `lmui.config.json`, and nothing else it can reach:

```
node:/whatsapp      [GET]           ← subtree: every read under /whatsapp
node:/whatsapp/send [POST]  exact   ← the ONE write
```

The reads are `GET /whatsapp/chats`, `/whatsapp/messages?chat=`, `/whatsapp/status`; the write is
`POST /whatsapp/send`.

🔴 **Why the write is a leaf rule and not the `node:/whatsapp [GET, POST]` this used to be.** A
rule with no `exact` flag is a **subtree** rule, so `POST` covered every path under `/whatsapp` —
including **`POST /whatsapp/webhook`**, the inbound-message webhook in
`core/src/routes/core/whatsapp.routes.ts`. A page that can post to its own inbound webhook can
**fabricate received messages**: inject a chat that never happened, and have it read back as
genuine on every surface that trusts the store. The pane never calls it; now it cannot.

The narrowing uses the leaf/exact rule form in `core/src/ui-pages/local-tier/grants.ts`:
`"exact": true` means the request path must have the SAME NUMBER OF SEGMENTS as the rule (a leaf,
not a subtree). The hub's ui-gateway enforces it identically
(`LangMartDesign/ui-gateway/src/viewtoken/grant.ts`), so this pane is narrowed on both serving
tiers — which matters here more than for most panes, because an `assist-web`-scoped pane is
normally reached through the hub.

The `GET` rule keeps its subtree form deliberately: no write can hide inside a read-only verb.
`PUT /whatsapp/config` is outside the grant in either shape (the verb is not declared).

The view token's grant is the hard ceiling — anything outside these two rules 403s.
