# Cross-Platform Capability Architecture for lm-assist

**Date:** 2026-06-05
**Status:** Design proposal (review-and-architect; no code changed yet)
**Author:** review requested by user; drafted with Claude Code

---

## 1. Goal

Establish a **standard cross-platform architecture** for lm-assist's REST endpoints, so that:

1. **Platform-dependent implementations live under a platform-named module**, organized by the
   feature/app/function they implement. Example: the Windows terminal implementation lives under
   `platform/windows/terminal/`, the POSIX one under `platform/posix/terminal/`.
2. **The cross-platform surface is a single unified interface** (a "capability port"). Inside it,
   a **resolver dispatches to the per-platform adapter**. Callers (routes) never branch on the OS.
3. **One codebase, developed / managed / deployed everywhere, without the platforms breaking each
   other** — adding or changing the Windows adapter cannot change Linux behavior, and a Windows-only
   module that fails to load on Linux degrades to a typed "unavailable", not a crash.

### Hard constraint (added during review)

> The existing **lm-assist web app already consumes these endpoints.** The HTTP contract cannot
> change. The refactor must happen **behind the route handlers**; URLs and response envelopes stay
> byte-stable.

This constraint is not a complication — it is the load-bearing principle of the design. The OS split
belongs in the *source tree* and the *adapter resolution*, **never in the URL**. A client (web app,
agent, remote caller) must never need to know which OS is behind an endpoint.

---

## 2. Current state (review findings)

### 2.1 Route model

- HTTP layer is **Hono** (`core/src/rest-server.ts`). A route is a plain object
  `{ method, pattern: RegExp, handler }` (`core/src/routes/index.ts:35`).
- Each route group is a factory `createXRoutes(ctx): RouteHandler[]`; all ~30 groups are
  **flat-concatenated** in `core/src/routes/core/index.ts` → `createCoreRoutes` → `createAllRoutes`.
- **There is no URL namespacing and no per-route feature/platform grouping.** Patterns are raw
  regexes like `/^\/terminal\/tmux$/`. This is fine and stays — the platform split is a *handler-layer*
  concern, not a routing concern.

### 2.2 The "terminal" domain is already three route groups with two different consumers

| Route group | File | Backing code | Primary consumer |
|---|---|---|---|
| `/terminal/*`, `/terminal/cc/*` | `terminal.routes.ts` (375 ln) | `terminal/` layered modules | **Agents / Claude Code automation** (drive tmux + CC TUI) |
| `/ttyd/*` | `ttyd.routes.ts` (1213 ln) | `ttyd-manager.ts` (**82 KB**), `ttyd-proxy.ts` | **Web app** (browser console) |
| `/tmux/*` | `tmux.routes.ts` (360 ln) | inline `execFile('tmux'...)`, `~/.bashrc` edits | **Web app** (settings → tmux auto-start) |

The web app's calls are centralized in **one client**, `web/src/lib/api-client.ts`, which hardcodes:

```
/ttyd/status            /ttyd/processes            /ttyd/port/:port
/ttyd/shell/start       /ttyd/start-all            /ttyd/session/:id/start|stop|kill|status
/ttyd/process/:pid/kill /ttyd/process/identify
/tmux/status            /tmux/install              /tmux/uninstall            /tmux/config
```
(plus `web/src/app/console/page.tsx` and `web/src/app/(dashboard)/settings/page.tsx`).

**These exact strings are the frozen contract.** The `/terminal/*` surface is *not* used by the web
app — it is used by agents — so the two surfaces can migrate behind the scenes independently as long
as both keep their URLs and envelopes.

### 2.3 The terminal subsystem is already 80% of the target shape

`terminal/` is the model citizen and the reason terminal is the right worked example:

- **Layered:** `terminal.routes.ts` is a thin pass-through → `validate.*` → `manager` → `tmux`/`cc`/`spawn-tabs`.
- **Typed domain:** `terminal/types.ts` models tmux/CC state as entities, not strings.
- **Typed errors:** `terminal/errors.ts` has `TerminalError` with codes incl. **`PLATFORM_UNSUPPORTED` → HTTP 501** already mapped (`httpStatusFor`).
- What it lacks: the platform branch is **scattered inline** (`if (!IS_POSIX) throw`, `if (IS_WINDOWS) return {platformSupported:false}`) rather than lifted into named per-platform adapters behind one resolver. `manager.ts` hard-switches `openGnomeTab` (POSIX) vs `openWtSshTab` (Windows) on the `kind` field; `tmux.ts`/`cc.ts` just `assertPosix()`.

### 2.4 Platform coupling inventory (the work to be organized)

One existing seam: `core/src/utils/process-utils.ts` — exports `IS_WINDOWS`/`IS_POSIX` plus a flat
grab-bag of helpers (`killProcessTree`, `findProcessesByName`, `isBinaryInstalled`, `shellQuote`,
`getDiskStats`, `requireTerminalSupport`, …). Good instinct, wrong shape: it is a utility bag, not a
set of per-capability ports.

Heaviest-coupled files (per a full source scan), i.e. the future adapter internals:

1. `ttyd-manager.ts` — tmux + ttyd + bash + detached spawn + `os.platform()` switch (terminal capability)
2. `utils/claudeai-browser-launch.ts` — `%PROGRAMFILES%`, X11/Wayland detection, macOS specifics (browser capability)
3. `service-manager.ts` — 6× `process.platform==='win32'`, WMI `Win32_Process.Create`, junction vs symlink, `npx.cmd` vs `npx` (service capability)
4. `terminal/spawn-tabs.ts` — gnome-terminal, wmctrl/xdotool, X11/Wayland env (terminal capability)
5. `utils/process-utils.ts` — `/proc`, pgrep, tree-kill (process capability)

Plus: `claude-oauth.ts`, `claudeai-browser-profile.ts`, `github-service.ts`, `detached-runner.ts`,
`memory-cache.ts`, `path-utils.ts` carry smaller per-OS branches.

### 2.5 Build / deploy

- Single npm package; workspaces `core` + `web`. `tsc` → `core/dist`; `next build` (standalone) → `web/.next/standalone`.
- **No per-OS native dependencies** — lmdb/lancedb/transformers ship prebuilt or WASM; same `npm install` output on every OS. So **a single build artifact already targets all platforms** — the architecture must preserve this (no conditional compilation, resolve at runtime).
- Bootstrap: `bin/lm-assist.js` → `service-manager.ts`. Service mgmt is hand-rolled Node (tree-kill / find-process), with a Windows WMI spawn path. No systemd/pm2.
- Feature-gating today: exactly one kill-switch (`knowledgeEnabled` in `project-settings.json`), and routes are **not** gated — all are registered; the backend checks the flag. There is **no capability/platform advertisement** today; clients discover unsupported features by catching a 501 or a `{platformSupported:false}` flag.

---

## 3. Architecture

### 3.1 Concepts

- **Capability** — a named cross-platform feature with a stable contract. e.g. `terminal`, `browser`,
  `process`, `service`. Identified by a string id.
- **Provider (port)** — a TypeScript interface describing a capability's operations
  platform-independently, in domain terms. e.g. `TerminalProvider`.
- **Adapter** — a per-platform implementation of a provider, living under `platform/<os>/<capability>/`.
- **Resolver** — `getCapability(id)` detects the platform once, returns the registered adapter, or a
  **NullAdapter** whose every method throws `CAPABILITY_UNAVAILABLE` carrying a structured reason.
- **Capability matrix** — computed once by `platform/detect.ts`: for each capability, which adapter is
  active, whether it is available, and the reasons it is not (wrong OS, missing binary, load error).

The route is the **port boundary**: a stable HTTP contract. The per-platform module is the **adapter**.
This is hexagonal / ports-and-adapters, scoped per capability, with a runtime registry.

### 3.2 Folder layout

```
core/src/platform/
  index.ts            getCapability<T>(id), getCapabilityMatrix()         ← the only thing routes import
  detect.ts           current OS + env/binary probe; builds capability matrix (SINGLE source of truth,
                      replaces scattered IS_WINDOWS / isBinaryInstalled / requireTerminalSupport)
  registry.ts         register(platform, capId, factory); internal resolve()
  capabilities.ts     capability ids + provider INTERFACES (ports) + NullAdapter factory
  errors.ts           CapabilityError { CAPABILITY_UNAVAILABLE, ADAPTER_LOAD_FAILED } → HTTP 501/500

  posix/
    terminal/index.ts   PosixTerminalProvider  — wraps existing terminal/manager + tmux + cc + spawn-tabs
                                                  + ttyd-manager (no logic rewrite; thin delegation)
  windows/
    terminal/index.ts   WindowsTerminalProvider — Windows Terminal / ConPTY / wt-ssh (built in Phase 3)
  darwin/
    terminal/index.ts   optional — `export { default } from '../../posix/terminal'` to reuse POSIX

  shared/               platform-agnostic supporting code reused by every adapter
    (the generic terminal modules — registry/audit/mutex/validate/types — move here over time)
```

- **Outer folder = platform. Inner folder = feature/app/function.** This is exactly the requested
  shape: "put platform-dependent impl under the windows feature name, for this example `terminal`."
- The existing **generic** terminal modules (`registry.ts`, `audit.ts`, `mutex.ts`, `validate.ts`,
  `types.ts`, `errors.ts`) are *not* platform code — they stay shared. Only the platform **primitives**
  (`tmux.ts`, `cc.ts`, `spawn-tabs.ts`, and `ttyd-manager.ts`) become an adapter's internals.

### 3.3 The port (unified interface)

```ts
// platform/capabilities.ts
export const Capabilities = {
  Terminal: 'terminal',
  Browser:  'browser',
  Process:  'process',
  Service:  'service',
} as const;
export type CapabilityId = typeof Capabilities[keyof typeof Capabilities];

/** Unified, platform-independent terminal contract. Domain types come from terminal/types.ts. */
export interface TerminalProvider {
  // control surface (today: /terminal/*, agent consumer)
  createSession(input: CreateSessionInput, caller?: string): Promise<SessionRecord>;
  sendKeys(name: string, input: SendKeysInput): Promise<void>;
  capture(name: string, input: CaptureInput): string;
  kill(name: string): Promise<{ killed: boolean }>;
  // managed-app surface (today: /terminal/cc/*) — "managed terminal app", the user's example
  launchManagedApp(name: string, input: CCLaunchInput): Promise<CCSessionState>;
  // web-console surface (today: /ttyd/*, web-app consumer)
  startWebConsole(input: WebConsoleInput): Promise<WebConsoleHandle>;
  stopWebConsole(sessionId: string): Promise<void>;
  listWebConsoles(): Promise<WebConsoleHandle[]>;
  // host-config surface (today: /tmux/*, web-app consumer)
  multiplexerStatus(): MultiplexerStatus;
}
```

> The single `TerminalProvider` deliberately unifies all three of today's route groups (`/terminal`,
> `/ttyd`, `/tmux`) because they are facets of one capability with different consumers. The three URL
> surfaces stay frozen; they just resolve to methods on one provider.

### 3.4 The resolver (dispatch)

```ts
// platform/index.ts
export function getCapability<T>(id: CapabilityId): T {
  const adapter = registry.resolve<T>(detect.platform(), id);   // detect cached
  return adapter ?? (nullAdapter(id) as T);   // never throws here; methods throw CAPABILITY_UNAVAILABLE
}
```

```ts
// platform/registry.ts — fail-soft lazy registration is the "don't break each other" mechanism
export function registerLazy(platform: Platform, id: CapabilityId, load: () => unknown) {
  if (detect.platform() !== platform) return;          // foreign-OS adapter never even loads
  try { table.set(key(platform, id), load()); }        // load() does require('./posix/terminal')
  catch (e) { detect.recordLoadFailure(id, e); }       // visible in the matrix, NOT a silent crash
}
```

A missing/failed adapter does not crash startup and does not affect other platforms — it resolves to
the NullAdapter, the route returns **501 with a typed reason**, and the failure is **recorded in the
capability matrix** (not swallowed silently).

### 3.5 The route delta (contract unchanged)

`terminal.routes.ts` stops importing platform modules directly and asks the resolver instead. URLs,
params, and the `{success,data|error}` envelope are identical.

```diff
- import * as manager from '../../terminal/manager';
- import * as tmux from '../../terminal/tmux';
- import * as cc from '../../terminal/cc';
+ import { getCapability } from '../../platform';
+ import { Capabilities, type TerminalProvider } from '../../platform/capabilities';
+ const term = () => getCapability<TerminalProvider>(Capabilities.Terminal);

  // POST /terminal/cc/:name/launch  — same URL, same body, same envelope
- return await cc.launch(name, p);
+ return await term().launchManagedApp(name, p);
```

`CapabilityError.CAPABILITY_UNAVAILABLE` maps to HTTP 501 exactly like today's `PLATFORM_UNSUPPORTED`,
so a Windows host that lacks a terminal adapter returns the same 501 the web app/agents already handle.

### 3.6 Capability advertisement (additive, breaks nothing)

New endpoint, purely additive:

```
GET /capabilities  →
{ "platform": "linux",
  "capabilities": {
    "terminal": { "available": true,  "adapter": "posix",  "reasons": [] },
    "browser":  { "available": true,  "adapter": "posix",  "reasons": [] },
    "service":  { "available": true,  "adapter": "posix",  "reasons": [] } } }
```

On Windows, `terminal.available=false, reasons:["no terminal adapter for win32"]` until Phase 3. This
replaces "discover support by catching a 501 / reading `platformSupported:false`" with one explicit,
machine-readable matrix the web app can read to gray out unsupported controls. **The web app is not
required to adopt it** — it is an enhancement, not a contract change.

---

## 4. "Develop, manage, deploy — without breaking each other"

- **Develop in isolation:** Windows work touches only `platform/windows/terminal/`. `tsc` type-checks
  all adapters together (one codebase), but at runtime `registerLazy` loads only the current platform's
  adapter, so a Windows adapter importing a Windows-only npm module never executes on Linux. A bug in
  the Windows adapter cannot change Linux runtime behavior.
- **Manage in one place:** `platform/detect.ts` is the single source of truth for "what OS am I + what
  is installed + which adapters loaded", surfaced via `GET /capabilities`. This retires the scattered
  `IS_WINDOWS` / `isBinaryInstalled` / `requireTerminalSupport` / `{platformSupported:false}` checks.
- **Deploy one artifact:** the build stays a single `tsc` over all adapters (all are plain TS, no
  native per-OS deps) — preserving today's "same `npm install` everywhere". No conditional
  compilation, no per-OS bundle. The resolver picks the adapter at runtime.

---

## 5. Migration plan (strictly behind the route; web app untouched until it opts in)

| Phase | Change | Web app impact |
|---|---|---|
| **0 — Skeleton** | Add `platform/` (detect, registry, capabilities, NullAdapter, `errors`). Register a **POSIX terminal adapter that is a 20-line shim** delegating to the *existing* `terminal/manager`+`ttyd-manager`. Add `GET /capabilities`. No files moved. | **Zero.** URLs + envelopes identical. |
| **1 — Move control primitives** | Physically move `terminal/{tmux,cc,spawn-tabs}.ts` under `platform/posix/terminal/`; move generic modules to `platform/shared/`. `terminal.routes.ts` calls the resolver. | **Zero** (`/terminal/*` frozen). |
| **2 — Fold ttyd + tmux-config in** | Wrap `ttyd-manager.ts` and the `/tmux/*` host-config behind the same `TerminalProvider` (POSIX sub-areas). Routes for `/ttyd/*` and `/tmux/*` become thin pass-throughs to the provider. **Wrap, do not rewrite** the 82 KB manager. | **Zero** (`/ttyd/*`, `/tmux/*` frozen — verified against `api-client.ts`). |
| **3 — Windows adapter** | Build `platform/windows/terminal/` (Windows Terminal / ConPTY / `wt-ssh`). `/capabilities` flips `terminal.available=true` on Windows. | Optional: web app reads `/capabilities` to enable terminal UI on Windows instead of catching 501. |
| **4 — Generalize** | Apply the same port/adapter split to `browser`, `process`, `service` (the next-heaviest coupled files). | Zero per phase; each capability's URLs stay frozen. |

**Backward-compat gate (every phase):** a contract-snapshot test asserts the exact URL+envelope set
consumed by `web/src/lib/api-client.ts` is unchanged. This test is the guardrail that lets the
behind-the-route refactor proceed safely.

---

## 6. Risks and non-goals

- **Non-goals:** changing any URL or response shape; changing the web app in Phases 0–2; rewriting
  `ttyd-manager.ts`; introducing systemd/pm2/native deps; conditional builds.
- **Risk — `ttyd-manager.ts` is 82 KB and tangled.** Mitigation: it is *wrapped* as a POSIX adapter
  internal (Phase 2), never rewritten as part of this work. Decomposition, if wanted, is a separate
  later effort behind the now-stable `TerminalProvider`.
- **Risk — lazy `require()` could hide real load errors.** Mitigation: `registerLazy` records load
  failures into the capability matrix (`ADAPTER_LOAD_FAILED`), visible via `GET /capabilities`, never
  silently swallowed.
- **Risk — provider interface churn while folding 3 surfaces into 1.** Mitigation: the provider is
  defined to be the *union* of the three existing surfaces' operations; no operation is dropped or
  renamed, so the route pass-throughs are mechanical.

---

## 7. Why this satisfies the goal

1. *Platform impl under a platform/feature name* → `platform/windows/terminal/`, `platform/posix/terminal/`.
2. *Unified cross-platform interface with an adapter inside* → `TerminalProvider` (port) + `getCapability()`
   resolver dispatching to per-platform adapters.
3. *One codebase, dev/manage/deploy without breaking each other* → single `tsc` build, runtime resolver,
   fail-soft lazy registration, single-source-of-truth `detect.ts`, additive `/capabilities` endpoint.
4. *Existing web app preserved* → the entire split is behind the route handlers; the `/ttyd/*`, `/tmux/*`,
   `/terminal/*` URL+envelope contracts (the surface `api-client.ts` depends on) are frozen and
   guarded by a contract-snapshot test.
```
