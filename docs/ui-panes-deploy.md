# Deploying UI panes — the shim ships on a different rail than the server

🔴 **A Core build does not deploy panes.** `./core.sh build` compiles TypeScript into `core/dist`
and stops. The panes that actually run are files under the node's apps root
(`~/.lmui/apps/<uiId>/`), and nothing in the build, the packer, the installer or
`lm-assist upgrade` ever writes there.

That matters because the pane contract has two halves that travel on different rails:

| half | lives in | reaches a node via |
|---|---|---|
| **server** — the local serving tier (`/viewtoken/remint`, `/data`, `/go`, the document injection) | `core/src/ui-pages/local-tier/` | `./core.sh build` + restart |
| **client** — the browser shim every pane loads | `ui-apps/<pane>/assets/lmui.js` | **a file copy into the apps root** |

Change both in one commit, deploy only the first, and nothing appears to break. The panes keep
working on their old shim until each one's **15-minute view token expires** and it fires a remint
using the previous contract. The failure is delayed, silent, and detached from the change that
caused it — the worst shape a deploy bug can take.

Measured on node 117 (2026-08-13), before the mechanism below existed: **7 deployed shims across
two distinct stale generations**, neither matching the repo's canonical copy.

## How panes actually get deployed today

**A human runs `cp -r`.** That is the whole procedure. Each pane's README carries its own line:

```bash
cp -r ui-apps/assist-backlog ~/.lmui/apps/assist-backlog
```

There is no script, no `core.sh` step, and no upgrade hook that does this — verified by grepping
`core.sh`, `install.sh`, `core/scripts/*`, and `core/scripts/deploy-prod.sh` for `lmui`/`ui-apps`
(zero hits). `ui-apps/` is not even in the npm package's `files` list, so a prod install has no
copy of the panes at all.

The shim is copied, never imported: all 18 `ui-apps/*/assets/lmui.js` are byte-identical, and
`core/src/__tests__/lmui-shim-identity.test.ts` fails the build if they fork inside the repo. That
test says nothing about what is deployed — which is the gap the tooling below closes.

## The mechanism

**Build bakes the canonical shim into Core.** `core/scripts/copy-ui-shim.js` copies
`ui-apps/assist-backlog/assets/lmui.js` (the canonical copy) to `core/dist/ui-pages/shim/lmui.js`
on every `./core.sh build`. Core therefore knows the exact bytes it expects, in prod as well as
from source. Drift is detected by **content hash**, not by a version marker — a marker has to be
remembered and bumped by the same person who already forgot to run `cp`, and it cannot catch a
hand-edit.

**Core warns at boot.** `logShimDrift()` runs in the ui-pages boot pass and names every stale pane:

```
[ui-pages] 🔴 STALE PANE SHIMS — 7 of 12 installed pane(s) run an OLD lmui.js.
[ui-pages] 🔴 A Core build does NOT touch the apps root, so these panes still speak the PREVIOUS
[ui-pages] 🔴 client contract. They keep working until each pane's 15-min view token expires,
[ui-pages] 🔴 then their remint fails — silent at deploy time, broken minutes later.
[ui-pages] 🔴 canonical 3efe4e7e05ed  (…/core/dist/ui-pages/shim/lmui.js)
[ui-pages] 🔴   assist-backlog  c9871cc2d6a3 != 3efe4e7e05ed  /home/ubuntu/.lmui/apps/…/lmui.js
…
[ui-pages] 🔴 FIX: node core/scripts/sync-ui-shims.js   (or ./core.sh panes sync)
```

**One command fixes it.**

```bash
./core.sh panes check    # report only; exit 1 if anything is stale
./core.sh panes sync     # re-copy the canonical shim over every stale installed pane
```

Both wrap `node core/scripts/sync-ui-shims.js` (`--check`, `--json`), which ships inside the npm
package too, so a prod node runs the same command with no repo present.

The check reads the apps root **and** every `~/.lmui/dev-*.json` state file, because a pane can be
served from anywhere the state file's `dir` points — on 117 that is how `hostdemo` is found at
`/home/ubuntu/uidemo`, outside the apps root entirely.

## The rules

1. 🔴 **Server and shims ship in ONE commit.** If a commit touches
   `core/src/ui-pages/local-tier/` *and* the pane contract, it must also carry every updated
   `ui-apps/*/assets/lmui.js`. A commit that changes only one half is not reviewable — the other
   half is invisible until a token expires on someone's node.

2. 🔴 **Both halves must tolerate the other being old, for the whole deploy window.** There is no
   ordering that avoids this. Panes already open in a browser hold the *old* shim against the
   *new* server until someone reloads them; between the sync and the restart the *new* shim runs
   against the *old* server. So a new request field must be **optional** on the server, and a new
   shim must not *depend* on the new server. Hard-requiring a new field is the one change that
   cannot be deployed safely.

3. 🔴 **Some panes cannot be fixed by a copy.** `assist-home`, `assist-machine`,
   `assist-api-keys` and `assist-whatsapp` ship no `lmui.js` — a bundler inlined the shim logic
   into a minified `app.js` (measured: all four call `/viewtoken/remint` from `app.js`). No sync
   can reach them; only rebuilding them from their own source can. Their source of record is
   **`LangMartDesign/ui-apps/<pane>/src/shim.ts`** — a different repo, on a different release
   cycle, which is precisely why a contract change cannot assume both halves land together.
   `panes check` lists them separately, and `panes sync` never touches them, so a green sync
   never overstates what it fixed. **This is the concrete reason rule 2 is not negotiable:**
   a server that hard-required a new field would 401 these four panes with no remedy available
   from this repo at all.

4. **Panes open across the upgrade need one reload.** Nothing more: lmui reads each asset from
   disk on every request and serves `Cache-Control: no-store`, and the serving tier proxies assets
   with `cache-control: private, no-cache` — so a plain browser reload picks up the new shim. No
   lmui restart, no cache bust, no re-register.

## Deploy procedure

```bash
./core.sh build          # compiles Core AND bakes the canonical shim into core/dist
./core.sh panes sync     # ← the step that used to be missing
./core.sh restart        # dev; prod is `lm-assist restart`
./core.sh panes check    # expect: "N pane(s) in sync"
```

Then reload any pane that was already open in a browser.

## assist-web-scoped panes are NOT deployed here at all (2026-08-13)

Everything above is for **`scope: "lm-assist"`** panes — node data plane, node-hosted. The four
**`scope: "assist-web"`** panes (assist-home, assist-api-keys, assist-machine, assist-whatsapp)
talk only to assist-api, so they are **gateway-hosted**: registry `source='local'`, files on the
SG box under `/home/opc/LangMartDesign/ui-gateway/ui-artifacts/<uiId>/`, serving with **no node
online**. Their source lives in LangMartDesign `ui-apps/`.

- `syncManagedUis` and the status heartbeat **skip `scope: assist-web`** (`reporter.ts`). Do not
  remove that skip: one Core boot asserting them would flip the registration back to
  `source='worker'` and re-tie the panes to that node.
- Redeploying one of the four = build in LangMartDesign, then rsync `index.html` + `assets/` to
  the SG path above. No registry change, no gateway restart — artifacts are read per request.
- Their registry rows are `managed=true` (sticky) with **no file-of-record asserting them**;
  grant/scope changes for these four are operator SQL on SG (`ui_registry`), like trust.
- The copies still sitting in `~/.lmui/apps/` on a node are inert for serving via the hub (the
  gateway never relays for a `source='local'` UI) but are still served by the node-local tier.

If `panes check` reports `PANE SHIM CHECK SKIPPED — cannot resolve the canonical shim`, Core was
built before this build step existed: run `./core.sh build` again. The check never reports "all
clear" when it could not actually compare.

## Where the code is

| file | role |
|---|---|
| `core/src/ui-pages/shim-sync.ts` | inventory, hash comparison, sync, the warning text |
| `core/scripts/copy-ui-shim.js` | build step that bakes the canonical shim into `core/dist` |
| `core/scripts/sync-ui-shims.js` | the operator CLI (`--check`, `--json`) |
| `core/src/__tests__/ui-shim-sync.test.ts` | tests for all of the above |
| `core/src/__tests__/lmui-shim-identity.test.ts` | keeps the 18 in-repo copies identical |

Both test files sit in `core/src/__tests__/` as a pair: `lmui-shim-identity` keeps the 18 in-repo
copies identical, `ui-shim-sync` keeps the deployed copies honest. `run-tests.js` treats a compiled
`*.test.js` as a suite only if its path contains a `__tests__` segment, and it walks all of
`dist-test` — so `src/ui-pages/**/__tests__/` is discovered too (verified 2026-08-13: all eight
`local-tier` suites run). It also reports **stale** compiled suites whose `.ts` moved or was
deleted; clear those with `npm run clean` rather than leaving them to rot.
