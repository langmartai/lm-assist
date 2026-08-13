# assist-manage

The **UI Pages manager** pane: lists the panes this node serves and the gateway registry rows
behind them, toggles a pane on/off, starts/stops its process, shows what a pane's grant currently
resolves to, and unregisters one. A single-file pane — everything lives in `index.html`, with the
shared `assets/lmui.js` shim for the data plane.

## Grant

Four rules in `lmui.config.json`, and nothing else it can reach:

```
node:/ui-pages            [GET]              ← subtree: every read under /ui-pages
node:/ui-pages/enable     [POST]    exact
node:/ui-pages/control    [POST]    exact
node:/ui-pages/registry/* [DELETE]  exact
```

Those map one-to-one onto the calls in `index.html`: `GET /ui-pages` (what this node serves),
`GET /ui-pages/registry` (the gateway rows), `GET /ui-pages/grants/:uiId` (a pane's live grant),
`POST /ui-pages/enable`, `POST /ui-pages/control` (start / stop / respawn-dead / autostart) and
`DELETE /ui-pages/registry/:uiId`.

🔴 **Why the writes are leaf rules and not the `node:/ui-pages [GET, POST, DELETE]` this used to
be.** A rule with no `exact` flag is a **subtree** rule, so one `POST` line handed this pane two
routes it never calls and must not have:

- **`POST /ui-pages/register`** — registering a pane *is* registering a grant. A pane that can
  call it can mint a new pane declaring any rules it likes and then reach the node through that,
  which makes every other pane's carefully-narrowed ceiling decorative.
- **`POST /ui-pages/local-url`** — mints a single-use **entry token** for an arbitrary `uiId`.
  That is the credential the local tier exchanges for a pane's working-session cookie; handing it
  to a page is handing it the front door of every sibling pane on the node.

Also dropped: `POST /ui-pages/grants/release` and `POST /ui-pages/screenshot`.

The narrowing uses the leaf/exact rule form in `core/src/ui-pages/local-tier/grants.ts`:
`"exact": true` means the request path must have the SAME NUMBER OF SEGMENTS as the rule (a leaf,
not a subtree), and a whole-segment `*` matches exactly one segment — how a rule names a path
parameter. The hub's ui-gateway enforces both identically
(`LangMartDesign/ui-gateway/src/viewtoken/grant.ts`), so a pane narrowed here is narrowed on both
serving tiers.

The `GET` rule keeps its subtree form deliberately: no write can hide inside a read-only verb, and
the read surface (`/ui-pages`, `/ui-pages/registry`, `/ui-pages/gateway`, `/ui-pages/grants/:id`)
is exactly this pane's subject matter.

The view token's grant is the hard ceiling — anything outside these four rules 403s.
