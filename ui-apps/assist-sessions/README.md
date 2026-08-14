# assist-sessions — the ORIGINAL sessions page, bundled as a pane

Since 2026-08-15 this pane **is** `web/src/components/sessions/*` — the real
`SessionBrowser`/`SessionDetail`/`ChatTab` React tree, bundled by `build.mjs` and mounted
with a pane environment around it. It is NOT a hand-maintained port (the previous plain-JS
implementation lived here until then); display drift against the web page is structurally
impossible because both surfaces render the same components from the same source files.

```
ui-apps/assist-sessions/
├── build.mjs           esbuild IIFE bundle + Tailwind-v4 compile of web/src/app/globals.css
├── index.html          relative refs; </head> is the token-injection anchor (see warning below)
├── lmui.config.json    uiId + the 12 GET-only grant leaves (see Grants)
├── src/
│   ├── main.tsx        mount + embed/theme contract + liveness ping + first-visit tab seed
│   ├── data-plane.ts   scoped fetch patch: Bearer view token + re-mint + relay-envelope unwrap
│   ├── pane.css        pane sizing (100vh contract) + CSP-safe font stacks
│   └── shims/          the FOUR modules whose environment a pane must replace:
│       ├── app-mode.tsx     useAppMode(): real createLocalClient pinned at /data/<uiId>/node,
│       │                    with GET batch-check + compact-params getSessionConversation
│       ├── api-client.ts    re-exports the REAL api-client; overrides only the env probes
│       │                    (detectAppMode/detectProxyInfo/workerFetch '/_coreapi' rewrite)
│       ├── machine.tsx      single-node MachineContext stub (isSingleMachine: true)
│       ├── navigation.ts    next/navigation over an in-iframe URLSearchParams store
│       │                    (accepts the legacy `id` deep-link alias for `session`)
│       └── console-tab.tsx  ConsoleTab stub — see "What is NOT ported"
└── assets/
    ├── app.js          GENERATED (~567 KB min) — never edit; rebuild via build.mjs
    ├── app.css         GENERATED (~102 KB) — compiled globals.css + pane.css
    └── lmui.js         canonical shared shim — NEVER inlined into app.js, so
                        `./core.sh panes sync` + lmui-shim-identity.test.ts keep governing it
```

Build: `node ui-apps/assist-sessions/build.mjs` (add `--dev` for sourcemaps, `--why` for a
bundle breakdown). Deploy: `cp -r ui-apps/assist-sessions/. ~/.lmui/apps/assist-sessions/`
then `env -u API_PORT ./core.sh panes check`. A Core build does NOT deploy panes.

## 🔴 The two traps this file exists to warn about

1. **The literal closing-head tag must appear exactly once in `index.html`.** Both serving
   tiers splice the view-token globals in front of the FIRST occurrence. A comment that
   *mentions* the tag entombs the injection inside the comment and the pane boots tokenless
   — every data call becomes `/data//node/...` and 404s. This shipped once.
2. **Grant changes ride the registry, not the file.** Editing `lmui.config.json` does
   nothing until the node re-asserts its panes (Core restart → boot sync). Freshly minted
   view tokens carry whatever grant set the REGISTRY holds — decode `window.lmui.token`'s
   payload (`grant` array) when a route unexpectedly 403s.

## Data plane

Everything flows through `/data/<uiId>/node<path>` with the Bearer view token; the scoped
fetch patch in `src/data-plane.ts` attaches the token, re-mints once on 401/403, and
unwraps the hub pane origin's outer `{status,data}` relay envelope so the SAME bundle runs
on the local tier (which forwards the node envelope untouched). Two api-client methods are
overridden in `src/shims/app-mode.tsx`:

- `batchCheckSessions` → the **GET** twin of `/sessions/batch-check` (the local client's
  POST is deliberately not granted — a session browser that could POST is a session
  driver). The unified live-poll loop works unchanged.
- `getSessionConversation` → the compact chat extras (`includeToolResults` +
  `includeSystemMessages`, measured ~10x smaller than `includeRawMessages`), adapted onto
  the shapes the REAL `transformSessionResponse` (exported from `web/src/lib/api-client`)
  already reads. Consequence: raw-only row types (progress / queue-op / file-history)
  have no data here — their filter chips count zero. They are default-hidden noise on the
  web page too.

## Grants (12 GET-only leaves — see `lmui.config.json`)

List + detail: `/projects`, `/projects/sessions`, `/projects/*/sessions`, `/sessions/*`
(the last also covers the 2-segment `GET /sessions/batch-check` and `/sessions/summaries`).
Detail tabs: `/sessions/*/subagents`, `/sessions/*/summary`, `/sessions/*/skills`,
`/plans/*`. FlowGraph: `/sessions/*/session-dag`, `/sessions/*/related`, `/sessions/*/dag`,
`/dag/unified/*`. The must/mustNot fixture lives in
`core/src/ui-pages/local-tier/__tests__/grants.test.ts`.

## What is NOT ported, and why

| dropped | why |
|---|---|
| **Console tab + the three console header buttons** (Open Console / Fork Session / New Shell) | A live terminal: ttyd/WebSocket attach plus session-driving POSTs — both outside the read-only grant; streaming across the pane data plane is a separate, still-blocked backlog item. The tab is stubbed with an explanation; the three new-tab buttons are hidden by `pane.css` and intercepted in `data-plane.ts` (they would open a dead 404 tab on a pane origin). First visit lands on Chat (`session-detail-tab` seeded once; the user's own choice is honored after). |
| **Machine picker / multi-node** | A pane is served BY one node. `MachineContext` is stubbed single-node; `useMachines` and its fetches drop out of the bundle. |
| **Raw-message fetching** | Replaced by the compact chat extras (above). Consequence: the Prog/Res/Files/Queue filter chips in Chat always count zero — those row types exist only in the raw stream (they are default-hidden noise on the web page too). |
| The `q` inbound param | The web page has no list-filter deep-link; the old plain-JS pane did. Dropped with the port. |
| The `?tab=tools` vocabulary value | The web page has no Tools tab. The navigation shim coerces `tools` — and any unknown tab — to `chat`, preserving the old pane's "unknown falls back to chat, never renders nothing" guarantee. |
| Outbound `lmui.goto('assist-projects', …)` project link | The web page's project affordances differ; no equivalent emission exists in the bundle. Inbound `project=` deep-links still work (assist-projects → sessions). |
| The `/auth/me` identity chip | The web page has no pane-header identity display; the shell shows the signed-in user itself. |

## Verify like this

Open the pane standalone (hub pane origin) and in the assist-web shell (`/p/assist-sessions`),
both themes. Check `window.lmui.token` grants length is 12, watch `/data/<uiId>/node/...`
calls in the network log (a `/data//node/...` URL means the token injection failed — trap #1),
and confirm the Chat tab renders tool calls with paired results.
