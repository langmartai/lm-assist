# ui-apps — lm-assist's own pluggable UIs

Scoped UIs (AUIS / agentic-ui-spec) that lm-assist ships for itself — the framework
managing itself through its own grant model. Deploy an app by copying it into the
node's apps root (default `~/.lmui/apps/<uiId>/`) and registering it (`ui_register`
over MCP, or `lmui register`); the node's lmui host process serves every sibling under
the apps root on the host UI port.

## 🔴 Deploying: a Core build does NOT deploy panes

`./core.sh build` compiles TypeScript into `core/dist` and stops. The panes that run are the
files under `~/.lmui/apps/`, and **nothing in the build, packer, installer or `lm-assist upgrade`
writes there** — a human's `cp -r` is the only path (each pane README carries its own line).

So the pane contract ships on two rails: the serving tier
(`core/src/ui-pages/local-tier/`) rides the build, and the browser shim
(`<pane>/assets/lmui.js`) rides the copy. Deploy only the first and nothing appears to break —
every pane keeps running the old shim until its 15-minute view token expires, then its remint
fails. Delayed, silent, and detached from the change that caused it.

**After any change to the shim, run the sync — it is a deploy step, not a warning:**

```bash
./core.sh build          # also bakes the canonical shim into core/dist
./core.sh panes sync     # re-copy the canonical shim over every stale installed pane
./core.sh restart
./core.sh panes check    # expect "N pane(s) in sync"
```

Core also names every stale pane in its boot log, so a missed sync is loud rather than silent.
Panes already open in a browser need **one reload**.

Three rules, and the third is why the second exists:

1. **Server and shims ship in ONE commit** — a commit that changes the contract must carry every
   updated `<pane>/assets/lmui.js` with it.
2. **A new request field must be OPTIONAL on the server.** Open panes hold the old shim until
   someone reloads them, so both halves must tolerate the other being old for the whole deploy
   window. There is no ordering that avoids this.
3. **Four deployed panes cannot be fixed by any copy** (`assist-home`, `assist-machine`,
   `assist-api-keys`, `assist-whatsapp`): a bundler inlined the shim into a minified `app.js`, so
   they ship no `lmui.js` at all. They are built from `LangMartDesign/ui-apps/<pane>/src/shim.ts`
   — a different repo on a different release cycle. Only rebuilding them there updates them,
   which is why rule 2 is not optional.

`assets/lmui.js` is byte-identical across every pane here and is never hand-edited;
`ui-apps/assist-backlog/assets/lmui.js` is the canonical copy. Fan it out with:

```bash
for d in ui-apps/*/assets/lmui.js; do cp ui-apps/assist-backlog/assets/lmui.js "$d"; done
```

`core/src/__tests__/lmui-shim-identity.test.ts` fails if the in-repo copies fork; `./core.sh panes
check` is what tells you whether the *deployed* ones did.

**Full procedure and rationale: [docs/ui-panes-deploy.md](../docs/ui-panes-deploy.md).**

## Pane sizing — fill the shell's content panel

> Full authoring reference: `docs/superpowers/specs/2026-08-14-pane-authoring-reference-design.md`.

The hub shell (`/p/<uiId>`) gives the pane iframe the **full content panel**;
the pane's `lmui:height` postMessage is a **liveness signal only**,
not sizing. Consequences every pane must honor:

- **`100vh` inside the embed IS the panel height.** Size the primary content region(s)
  with the shared var pattern (all 15 plain-JS panes carry it, assist-backlog is the
  reference):
  ```css
  :root{--vh-cap:calc(100vh - <A>rem)}       /* A = standalone chrome around the region */
  body.embed{--vh-cap:calc(100vh - <B>rem)}  /* B ≈ A − 4.4 (header 3.2 + main-padding 1.2);
                                                backlog's − 5.7 also reclaims its external tabs bar */
  ```
  Fixed-height canvases → `height:var(--vh-cap)` + a `min-height` floor; capped lists →
  `max-height:max(var(--vh-cap), <floor>rem)` so short content stays compact. Compute A
  from the pane's actual markup, generous by ~1rem.
- 🔴 **`body.embed{overflow:hidden}` is a RELIC — it must be `auto`.** The hidden came
  from the old content-sized-iframe contract (scrollbar feedback guard). With the iframe
  panel-fixed, `hidden` makes everything past `100vh` UNREACHABLE (measured: the tasks
  kanban had 2000+ px of clipped, unscrollable board). All panes now say `overflow:auto`.
- The four bundled `assist-web` panes (home, api-keys, machine, whatsapp) are Tailwind
  full-height apps (`html,body{height:100%}`) — already compliant, nothing to retrofit.

## The grant language

Each app declares its data-plane ceiling in its own `lmui.config.json`:

```json
{ "service": "node", "pathPrefix": "/mission/*", "verbs": ["POST"], "exact": true }
```

A rule's path is a **segment pattern**, not a string prefix:

- a literal segment matches itself;
- a whole segment of `*` matches exactly ONE segment, never a `/` — it is how a rule names a
  **path parameter** (`/mission/session/*/read` is `POST /mission/session/:sid/read`);
- **`"exact": true`** requires the same SEGMENT COUNT — a **leaf**. Without it a rule keeps its
  historical meaning: itself **plus the whole subtree beneath it**.

🔴 **Default to `exact` for every write verb.** A subtree rule silently carries every mutating
route that exists — or is later added — below the path it names. That is not hypothetical: the
Missions pane's `node:/mission [GET, POST]` turned out to include `POST /mission/workflows/:id`
and `.../rollback`, i.e. authority to rewrite and roll back the Mission-Controller playbooks that
the Mission Processes pane next door had deliberately held to `GET`. A `GET`-only subtree is
usually fine — no write can hide inside a read-only verb.

Both forms are enforced by two independent evaluators that must never disagree:
`core/src/ui-pages/local-tier/grants.ts` (node-local tier) and
`LangMartDesign/ui-gateway/src/viewtoken/grant.ts` (hub). Neither ever matches a path carrying
`..`, `//` or a percent-encoded separator, and both DROP a malformed rule rather than guess.
Each pane's real call inventory is asserted in
`core/src/ui-pages/local-tier/__tests__/grants.test.ts` — narrowing a grant without breaking the
app is a test run, not a hope.

## assist-manage

The UI Pages manager as a scoped UI: owner-bound, scope `lm-assist`, four declared rules —
`node:/ui-pages [GET]` plus leaf writes on `/ui-pages/enable`, `/ui-pages/control` and
`/ui-pages/registry/*`. Its data-plane calls relay through the hub to THIS node's /ui-pages
routes, which act on the platform gateway with the node's own API key (the same trust path as the
ui_* MCP tools). The page can list every UI on the node, enable/disable registrations, start/stop
local servers, toggle autostart, read grants, and unregister — and can do nothing else: the view
token's grant is its hard ceiling (verified: /health outside the rules → 403). It notably cannot
`POST /ui-pages/register` (registering a pane is registering a grant) or `POST
/ui-pages/local-url` (minting an entry token for any sibling pane); see its own README.

First member of the assist family (see backlog: port of assist-web to scoped UIs).
