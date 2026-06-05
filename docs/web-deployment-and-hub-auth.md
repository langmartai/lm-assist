# Web Deployment & Hub Auth State

How the Next.js web (`web/`) is deployed for prod + dev, and how it reflects
hub sign-in / sign-out. Learned the hard way fixing the 2026-05-31 logout/
account-switch bugs.

## One build serves both prod and dev — via a RUNTIME port, not a baked one

The web is a single Next standalone build meant to serve **both** the prod and
dev instances. They differ only in which local core API they talk to:

| Instance | Web port | Core port | Hub backend |
|----------|----------|-----------|-------------|
| prod     | 3848     | 3100      | `wss://assist-api.langmart.ai` |
| dev      | 3948     | 3200      | `wss://assist-api.xeenhub.com` |

The core port is chosen at **request time**, not build time:

- `web/src/app/layout.tsx` reads `process.env.LM_LOCAL_API_PORT` and injects
  `window.__LM_LOCAL_API_PORT__` into the HTML.
- `detectAppMode()` in `web/src/lib/api-client.ts` prefers that injected value
  over the build-time-baked `NEXT_PUBLIC_LOCAL_API_PORT` (which is only a
  fallback).

### The trap (root-caused 2026-05-31)

`NEXT_PUBLIC_*` variables are inlined into client bundles at **build** time;
setting them at launch does nothing for client code. The launchers
(`core.sh` `start_web` and `core/src/service-manager.ts` `startWeb`) historically
passed only `NEXT_PUBLIC_LOCAL_API_PORT` and **not** `LM_LOCAL_API_PORT`. Result:

- `window.__LM_LOCAL_API_PORT__` was empty → client fell back to the baked port.
- A single shared build baked with `3100` made **dev (3948) talk to the prod
  core (3100 → langmart.ai)** instead of `3200` (→ xeenhub.com). Symptom: the dev
  instance shows the langmart account / `assist-api.langmart.ai` hubUrl.

**Fix:** both launchers now set `LM_LOCAL_API_PORT=$API_PORT` at launch. With that,
one build serves both instances correctly. Always pass `LM_LOCAL_API_PORT` when
launching the standalone server by hand.

### Verifying the wiring

In the browser console of each instance:

```js
window.__LM_LOCAL_API_PORT__            // 3100 on prod, 3200 on dev
// then confirm the core targets the right hub:
fetch(`http://HOST:${window.__LM_LOCAL_API_PORT__}/hub/status`).then(r=>r.json())
  .then(j => j.data.hubUrl)             // langmart.ai vs xeenhub.com
```

## Building prod + dev separately (belt-and-suspenders)

When you want each instance's baked fallback to also be correct (independent of
the runtime env), build twice and run from isolated dirs:

```bash
cd web
# DEV (xeenhub, core 3200)
rm -rf .next && NEXT_PUBLIC_LOCAL_API_PORT=3200 npx next build
mkdir -p ~/lm-assist-web-builds/dev && cp -a .next/standalone/. ~/lm-assist-web-builds/dev/
cp -a .next/static ~/lm-assist-web-builds/dev/web/.next/static
cp -a public ~/lm-assist-web-builds/dev/web/public
# PROD (langmart, core 3100)
rm -rf .next && NEXT_PUBLIC_LOCAL_API_PORT=3100 npx next build
mkdir -p ~/lm-assist-web-builds/prod && cp -a .next/standalone/. ~/lm-assist-web-builds/prod/
cp -a .next/static ~/lm-assist-web-builds/prod/web/.next/static
cp -a public ~/lm-assist-web-builds/prod/web/public
# launch each from its own dir
cd ~/lm-assist-web-builds/prod && HOSTNAME=0.0.0.0 PORT=3848 LM_LOCAL_API_PORT=3100 NEXT_PUBLIC_LOCAL_API_PORT=3100 setsid nohup node web/server.js >/tmp/web-prod.log 2>&1 &
cd ~/lm-assist-web-builds/dev  && HOSTNAME=0.0.0.0 PORT=3948 LM_LOCAL_API_PORT=3200 NEXT_PUBLIC_LOCAL_API_PORT=3200 setsid nohup node web/server.js >/tmp/web-dev.log  2>&1 &
```

The standalone tree is `.next/standalone/{node_modules, web/server.js, web/.next}`;
run `node web/server.js` from the dir that contains both. Kill stale servers by
the pid from `sudo ss -tlnp | grep ':PORT'` — on these hosts `lsof -ti` returned
empty, so don't rely on it.

> The npm-global `lm-assist` is a **symlink** to the `~/lm-assist` checkout, so
> prod and dev share one source tree; only the launch env / build differs.

## Hub auth state must be refreshed on the client after logout

`AppModeContext` caches hub state in a **module-level** singleton
(`_persistedHubState`) that survives remounts. After a logout (which clears the
api key via `PUT /hub/config {apiKey:''}`), nothing reset that cache, so the UI
kept showing the previous user until a hard reload. Two places to keep in sync:

1. **Nav (`TopBar.tsx`):** `handleLogout` must `await refreshHubConnection()`
   (from `useAppMode`) after the `PUT /hub/config`. `refreshHubConnection()`
   nulls `_persistedHubState` and re-fetches `/hub/status` → `hubUser` clears →
   the nav switches to the signed-out state without a reload.

2. **Settings page (`settings/page.tsx`):** the sign-in/out panel reads the
   page's **own** local `hubStatus` (`isHubConnected`/`isAuthenticated`/
   `hasApiKey`), refreshed only on a 30s poll or on mount. Add an effect that
   re-runs `fetchStatus()` whenever the context `hubConnected`/`hubUser` flips,
   so signing out while already on the page updates the panel immediately.

### Account switch needs a fresh gateway-id

The node's `gateway-id` is machine-persisted (`core/src/hub-client/hub-config.ts`).
When the api key changes or is removed, `PUT /hub/config` calls `clearGatewayId()`
so the next connect mints a **fresh** node identity bound to the new user.
Without it the hub keeps associating the node with the old user and a re-sign-in
"sticks" on the previous account. Verify with `/hub/status` → each instance/user
should have its own distinct `gatewayId`.

## The three independent failure modes (sanity-probe each)

| Probe | Confirms |
|-------|----------|
| `curl :PORT/settings` → 200 | server up |
| `window.__LM_LOCAL_API_PORT__` matches the intended core | correct prod/dev wiring |
| `/hub/status` `hubUrl` matches the intended platform | core points at the right hub |
