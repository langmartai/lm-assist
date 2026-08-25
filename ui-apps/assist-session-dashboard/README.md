# assist-session-dashboard — the ORIGINAL live grid, bundled as a pane

This pane **is** the default export of `web/src/app/(dashboard)/session-dashboard/page.tsx` —
the live terminal grid — bundled by `build.mjs` and mounted with a pane environment around
it. Not a lookalike: display drift against the web page is impossible by construction. Same
harness as `assist-sessions`; only the entry component, the grants and the hidden controls
differ.

## Why this was listed as blocked, and why it is not

The migration backlog carried this page as **BLOCKED on streaming over the relay**. Measured
2026-08-25: it does not stream. There is no `EventSource` and no `WebSocket` in the page, in
`useSessionDashboard`, in `useMultiSessionMonitor`, or in any of the three
`components/session-dashboard/*` files. The "live" grid is a poll loop:

| what it polls | route |
|---|---|
| the session list | `GET /projects/sessions` |
| per-session change detection | `GET /sessions/batch-check` (the GET twin — see below) |
| a message tail per visible panel | `GET /sessions/:id` (compact chat extras) |
| running detection | `GET /ttyd/processes` |

What it really holds that a read-only pane must not is the **session-driving** half: start or
stop a ttyd console, and kill a session's processes. Those are POSTs under `/ttyd/session/*`,
outside this pane's grant, so they 403 at the data plane — and their four buttons are hidden
so nobody clicks a control that cannot work.

## 🔴 The traps this file exists to warn about

1. **The literal closing-head tag must appear exactly once in `index.html`.** Both serving
   tiers splice the view-token globals in front of the FIRST occurrence; a comment that
   *mentions* the tag entombs the injection inside it and the pane boots tokenless. This
   shipped once, on the sessions pane.
2. **Grant changes ride the registry, not the file.** Editing `lmui.config.json` does nothing
   until the node re-asserts its panes (Core restart → boot sync).
3. **Hiding a button by `title=` needs `!important` when the button sets an inline
   `display`.** Close All (`TerminalFilterBar.tsx`) does; the other three do not. Without the
   flag that one control stayed visible while its siblings disappeared correctly — a
   half-hidden driving surface is worse than none, because it reads as supported.

## Data plane

Two api-client methods are overridden in `src/shims/app-mode.tsx`, both load-bearing for a
grid rather than a single view:

- `batchCheckSessions` → the **GET** twin of `/sessions/batch-check`. The local client POSTs,
  and a grant that could POST to a session route is a session driver.
- `getSessionConversation` → the compact chat extras (`includeToolResults` +
  `includeSystemMessages`) instead of `includeRawMessages`, measured ~10x smaller. On a grid
  that tails many sessions at once this is the difference between a poll loop and a stall.

## Grants (3 GET-only leaves — see `lmui.config.json`)

`/projects/sessions`, `/sessions/*` (covers the 2-segment `batch-check` and `/sessions/:id`),
`/ttyd/processes`. All `exact`, which is what keeps the rest of the ttyd surface — every
`/ttyd/session/*` control route — unreachable. The must/mustNot inventory lives in
`core/src/ui-pages/local-tier/__tests__/grants.test.ts`.

## What is NOT ported, and why

| dropped | why |
|---|---|
| **Connect / Reconnect / Stop / Close All** | Each starts or kills a ttyd console: session-driving POSTs outside the read-only grant. Hidden in `pane.css` by `title=`; `window.open` of a console/ttyd URL is swallowed in `data-plane.ts` as the backstop. |
| **Machine picker / multi-node** | A pane is served BY one node; `MachineContext` is stubbed single-node. |

## Known characteristic, inherited from the page

The grid renders one panel per available session with no virtualization — on a node with
6,644 sessions that is ~20k buttons and ~1.8 MB of text in the DOM. The message feeds are
lazy ("Scroll into view to load"), so the data cost stays bounded, but the initial mount is
heavy. This is the web page's behaviour, unchanged by the port; the "running only" filter is
the practical mitigation on a busy node.

## Verify like this

Open standalone and in the shell (`/p/assist-session-dashboard`), both themes. Confirm
`window.lmui.token`'s grant array has 3 leaves, watch `/data/<uiId>/node/...` in the network
log (a `/data//node/...` URL means the token injection failed — trap #1), and check that
every Connect/Stop/Close All control computes `display: none`.
