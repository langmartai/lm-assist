# assist-search — the ORIGINAL search page, bundled as a pane

This pane **is** `web/src/components/search/SessionSearch` — the same component the web
app's `/search` route renders (`<SessionSearch mode="page" />`), bundled by `build.mjs`
and mounted with a pane environment around it. It is not a hand-maintained lookalike:
display drift against the web page is structurally impossible because both surfaces
render the same component from the same source file. Same harness as `assist-sessions`;
only the entry component, the grants and the cross-pane vocabulary differ.

```
ui-apps/assist-search/
├── build.mjs           esbuild IIFE bundle + Tailwind-v4 compile of web/src/app/globals.css
├── index.html          relative refs; the closing-head tag is the token-injection anchor (see below)
├── lmui.config.json    uiId + the 4 GET-only knowledge grant leaves (see Grants)
├── src/
│   ├── main.tsx        mount + embed/theme contract + liveness ping + the ?q= deep link
│   ├── data-plane.ts   scoped fetch patch (Bearer view token + re-mint + envelope unwrap)
│   │                   and the window.open interception for cross-page hrefs
│   ├── pane.css        pane sizing (100vh contract) + CSP-safe font stacks
│   └── shims/          the modules whose environment a pane must replace:
│       ├── app-mode.tsx     useAppMode(): the REAL createLocalClient pinned at
│       │                    /data/<uiId>/node — no method overrides needed here
│       ├── api-client.ts    re-exports the REAL api-client; overrides only the env probes
│       ├── machine.tsx      single-node MachineContext stub (isSingleMachine: true)
│       ├── navigation.ts    next/navigation whose push/replace become lmui.goto (below)
│       └── console-tab.tsx  ConsoleTab stub, inherited from the sessions harness
└── assets/
    ├── app.js          GENERATED (~600 KB min) — never edit; rebuild via build.mjs
    ├── app.css         GENERATED (~59 KB) — compiled globals.css + pane.css
    └── lmui.js         canonical shared shim — NEVER inlined into app.js, so
                        `./core.sh panes sync` + lmui-shim-identity.test.ts keep governing it
```

Build: `node ui-apps/assist-search/build.mjs` (`--dev` for sourcemaps, `--why` for a bundle
breakdown). Deploy: `cp -r ui-apps/assist-search/. ~/.lmui/apps/assist-search/` then
`env -u API_PORT ./core.sh panes check`. A Core build does NOT deploy panes.

## 🔴 The two traps this file exists to warn about

1. **The literal closing-head tag must appear exactly once in `index.html`.** Both serving
   tiers splice the view-token globals in front of the FIRST occurrence. A comment that
   *mentions* the tag entombs the injection inside the comment and the pane boots
   tokenless — every data call becomes `/data//node/...` and 404s. This shipped once, on
   the sessions pane.
2. **Grant changes ride the registry, not the file.** Editing `lmui.config.json` does
   nothing until the node re-asserts its panes (Core restart → boot sync). Freshly minted
   view tokens carry whatever grant set the REGISTRY holds — decode `window.lmui.token`'s
   payload (`grant` array) when a route unexpectedly 403s.

## Cross-pane navigation — the whole point of this page

Search results are LINKS OUT. On the web page those are same-origin hrefs; on a pane origin
they 404, so `src/shims/navigation.ts` translates each one into `lmui.goto(<sibling>, …)`,
the only API that resolves a sibling on both serving tiers. Each param below is one the
target actually reads (a param nobody reads is a silently broken button):

| the page does | the pane emits |
|---|---|
| `router.push('/sessions?session=…')` | `lmui.goto('assist-sessions', { session, tab })` |
| `window.open('/sessions?session=…&tab=chat')` | the same, with `{ newTab: true }` |
| `router.push('/knowledge?id=K12&part=K12.3')` | `lmui.goto('assist-knowledge', { unit: 'K12.3' })` — it addresses a unit at either grain and splits the part suffix itself; it does **not** read `id`/`part` |
| `window.open('/console?…')` | swallowed with a console note (see below) |

Inbound, the pane adds one param the web page has no equivalent for: **`?q=<term>`** seeds
the query box, and the page's existing scope effect runs the search on mount — so a sibling
can hand off a search, not just a destination.

## Grants (4 GET-only leaves — see `lmui.config.json`)

`/knowledge` (recent list), `/knowledge/search` (hits), `/knowledge/*` (one unit),
`/knowledge/*/comments` (unaddressed comments). All four are `exact`, which is what keeps
the pipeline's own 2-segment controls (`/knowledge/generate/*`, `/knowledge/review/status`)
out of reach — and the whole write half of the prefix is excluded by the GET-only verb list.
The must/mustNot inventory lives in `core/src/ui-pages/local-tier/__tests__/grants.test.ts`.

**No `/sessions` grant, deliberately.** The page carries a session-preview column, but it is
dead code on the current web page — `setSelectedSessionId` is only ever called with `null`,
so nothing can select a session. A grant for a path that cannot be reached is pure attack
surface. If that branch is revived, the grant comes back with it, together with the compact
`getSessionConversation` override the sessions pane uses.

## What is NOT ported, and why

| dropped | why |
|---|---|
| **The three preview header buttons** (Open Console / Fork Session / New Shell) | They open a ttyd console — a session-driving surface outside this read-only grant. Hidden in `pane.css` by `title=`, and `window.open('/console?…')` is swallowed in `data-plane.ts` as the backstop (a dead 404 tab explains nothing). They sit in the session-preview column, which is itself unreachable today. |
| **Machine picker / multi-node** | A pane is served BY one node. `MachineContext` is stubbed single-node. |
| The `directory` / `projectPath` props | Overlay-only scoping the `/search` page never passes either. |

## Verify like this

Open the pane standalone and in the assist-web shell (`/p/assist-search`), both themes.
Confirm `window.lmui.token`'s grant array has 4 leaves, watch `/data/<uiId>/node/knowledge…`
in the network log (a `/data//node/...` URL means the token injection failed — trap #1), and
check that a result row's Knowledge-Navigator affordance jumps to the knowledge pane rather
than 404ing.

⚠️ **On a node with knowledge generation disabled** (`getProjectSettings().knowledgeEnabled`
false — the default) `GET /knowledge` answers `{success:true, data:[]}`, indistinguishable
from "no entries". The pane then correctly renders its empty state and there is nothing to
click. That is the node's setting, not a pane fault — the shipped assist-knowledge pane
reads exactly the same empty list on such a node.
