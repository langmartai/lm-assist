# Install/Upgrade — npm-published AND custom builds, everywhere — Design

**Date:** 2026-06-24
**Status:** Approved (design)
**Goal:** Make **every** install/upgrade surface — CLI, Web UI, `install.sh`, `install.ps1`, `upgrade.js` — support **both** (a) the npm-**published** package (`lm-assist@latest` / a published version) and (b) a **custom build** (a GitHub tag/branch/commit, a local `.tgz`, an unpacked dir, or any npm/git spec). Plus **install-source tracking** so the CLI/UI know whether the current install is published or custom and never silently nudge a custom build to downgrade.

---

## 1. Current state (from review)

Already support both (no change): **CLI `lm-assist upgrade [--from S]`**, **`upgrade.js`** (`resolveSource()` handles tgz/dir/bare-version/npm-or-git-spec incl. `github:org/repo#ref`), and the **`POST /dev-mode/upgrade` + `/dev-mode/npm-update`** routes (accept `{source|from}` → `--from`).

Gaps:
- **Web UI "Upgrade"** (`web/src/app/(dashboard)/settings/page.tsx` `handleUpgrade` ~`:984`, buttons ~`:3723-3756`) POSTs **no body** → always npm-latest; no way to choose a source.
- **`install.sh` / `install.ps1`** always **source-build** (clone → `npm pack` → `npm install -g ./tgz`); no npm-**published** mode (the `--ref` flag only pins the *source* checkout).
- **Version/update detection:** `lm-assist version` (`bin/lm-assist.js:250-273`) prompts "upgrade" on **any** version difference (no direction guard); neither `version` nor `GET /dev-mode/check-update` (`core/src/routes/core/dev-mode.routes.ts:701-743`) knows whether the install is **custom**, so they can steer a custom build onto npm latest.

---

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| UI source picker | **Guided dropdown + conditional field**: a `<select>` (Latest published / Specific version / GitHub ref / Local .tgz path) that reveals the matching input; the UI assembles the `source` string and POSTs `{source}`. |
| Source tracking | **Full tracking now**: every install/upgrade writes an install-source marker; `version` + `check-update` + the UI read it and warn before replacing a custom build. |
| Installer custom source | **Prefer the prebuilt GitHub-Release tgz; fall back to source-build.** Default prod installs the prebuilt release asset directly (fast, carries the pins); only clones+builds when no release asset exists for the ref. `--published` → npm registry; `--source-build` forces a build. (A v0.1.76 Release with `lm-assist-0.1.76.tgz` is already published.) |

---

## 3. Architecture

```
  every install/upgrade path  ──writes──►  ~/.lm-assist/install-source.json
   upgrade.js · install.sh · install.ps1 · bin/postinstall.js (npm-global)
                                              │
                                  { kind, source, version, installedAt }
                                              │ read by
              ┌───────────────────────────────┼───────────────────────────────┐
              ▼                                ▼                               ▼
   lm-assist version                GET /dev-mode/check-update         Web UI Settings card
   (Source: <label>; direction      (+ currentSource{kind,source},     (shows current source +
    guard: prompt only when          isCustomBuild)                     dropdown+field picker;
    npm latest > installed)                                             warns if custom)
```

**New unit — install-source marker** (`core/src/utils/install-source.ts`, plain CommonJS so `upgrade.js`/`postinstall.js` can `require` it too):
- `InstallSource = { kind: 'published' | 'custom'; source: string; version: string | null; installedAt: string }`
- `classifyInstallSource(spec: string, isCustom: boolean): { kind, source }` — pure (published when `!isCustom` / spec is `lm-assist@<ver>`-published; custom otherwise; `source` = a human label).
- `recordInstallSource(info: { kind; source; version? }): void` — writes `<dataDir>/install-source.json` (atomic, 0600), stamping `installedAt`.
- `readInstallSource(): InstallSource | null`.

(File lives in `core/src/utils/` and is compiled to `core/dist/utils/install-source.js`; `upgrade.js` and `bin/lm-assist.js` `require` the **compiled** path; `install.sh`/`install.ps1` write the JSON directly since they run pre-build.)

---

## 4. Components & changes

### 4.1 `core/src/utils/install-source.ts` (new) — the marker model (pure + IO; unit-tested)
The functions above. `classifyInstallSource` is pure (table-tested); `record`/`read` use `getDataDir()` + atomic write (mirror `worker-store.ts`).

### 4.2 `core/scripts/upgrade.js` — write the marker after a successful install
After the install step succeeds, `require('<pkgDir>/core/dist/utils/install-source.js').recordInstallSource({ kind: source.isCustom ? 'custom' : 'published', source: source.label, version: <newly-installed version> })`. `source.isCustom`/`source.label` already exist from `resolveSource()`. (Best-effort; wrapped in try/catch — a marker-write failure must not fail the upgrade.)

### 4.3 `install.sh` + `install.ps1` — THREE prod sources: published, prebuilt-release, source-build
The prod path resolves a source in this order (`--dev` stays source-build):
1. **`--published [<version>]`** (env `LM_ASSIST_PUBLISHED=1|<version>`): skip clone; `npm install -g lm-assist@${version:-latest}` from the **npm registry**. Marker `{kind:"published", source:"lm-assist@<ver|latest>"}`.
2. **Prebuilt GitHub-Release tgz — the DEFAULT prod custom path (prefer this; no clone/build):** for the requested ref (default = the **latest** release; or `--ref <tag>`), resolve the prebuilt asset and `npm install -g <url>`:
   - default/latest → GitHub API `repos/langmartai/lm-assist/releases/latest` (public, `curl`/`Invoke-RestMethod`) → the `lm-assist-*.tgz` asset's `browser_download_url`.
   - a tag `<v>` → construct `https://github.com/langmartai/lm-assist/releases/download/<v>/lm-assist-<ver>.tgz` (ver = tag without leading `v`) and **HEAD-check it's 200** before use.
   - Marker `{kind:"custom", source:"<release-url>"}`.
3. **Source-build FALLBACK:** if no release asset exists for the ref (HEAD ≠ 200 / no release), or `--source-build` is forced, do the current clone → `npm pack` → `npm install -g ./tgz` (honoring `--ref`). Marker `{kind:"custom", source:"github:langmartai/lm-assist#<ref|branch>"}`.

So default prod = fast prebuilt-release install, transparently falling back to source-build; `--published` overrides to the registry; `--source-build` forces a build. `--published` is mutually exclusive with `--ref`/`--dev`. Marker write = a small inline JSON write (`node -e` on Linux / a here-string on Windows) — no dist dependency. Keep `install.ps1` pure ASCII.

### 4.4 `bin/lm-assist.js` `version` — direction guard + show source
- Read the marker (`require('<root>/core/dist/utils/install-source.js').readInstallSource()`), print `  Source:     <source> (<kind>)`.
- Replace the `installedVersion !== latest` prompt with a **direction guard**: only print "Run lm-assist upgrade…" when `latest` is **numerically greater** than installed (reuse a small `isGreater(a,b)` compare). If the install is **custom**, append "(upgrading to npm latest replaces your custom build; use `lm-assist upgrade --from <ref>` to stay custom)".

### 4.5 `core/src/routes/core/dev-mode.routes.ts` — `check-update` returns source identity
- `GET /dev-mode/check-update`: add `currentSource: readInstallSource()` and `isCustomBuild: currentSource?.kind === 'custom'` to the response `data`. Keep the existing direction-guarded `updateAvailable`. (`POST /dev-mode/upgrade` already forwards `{source|from}` — no change.)
- `bin/postinstall.js` (runs on `npm install -g lm-assist`): best-effort `recordInstallSource({ kind:'published', source:'lm-assist@'+<version> })` so a plain published global install is tracked too.

### 4.6 Web UI — `web/src/app/(dashboard)/settings/page.tsx`
- **Show current source** (from `check-update`): "Installed: 0.1.76 — source: github:…#<ref> (custom build)".
- **Upgrade card picker:** a `<select>` `sourceKind ∈ {latest, version, github, tgz}` + a conditional text input (hidden for `latest`; "version e.g. 0.1.76" / "github ref e.g. github:langmartai/lm-assist#v0.1.76" / "absolute .tgz path"). On Upgrade, assemble `source` (`latest`→omit; `version`→the version; `github`→the spec; `tgz`→the absolute path) and POST `{ source }` to `/dev-mode/upgrade`.
- **Custom-build warning:** when `isCustomBuild`, show an inline note that "Upgrade → Latest published will replace your custom build."
- Use `workerFetch` (api-token), per web-core-fetch-rules.

---

## 5. Error handling / safety
- Marker writes are **best-effort** (try/catch) — never fail an install/upgrade because the marker couldn't be written; `read` returns `null` on any error (callers treat null as "unknown → assume published, behave as today").
- The direction guard prevents a custom/ahead build from being told to downgrade; the explicit custom-build warning prevents silent replacement.
- `--published` + `--dev` together → `--published` wins (published implies prod); warn.
- Absolute-path requirement for a `.tgz` source via the UI/route (the detached upgrade script resolves relative paths against the server cwd) — the UI validates/notes this.

## 6. Testing
- **Unit:** `classifyInstallSource` table (latest/version → published; tgz/dir/github-ref/`@next` → custom); `record`→`read` round-trip (atomic, 0600); the `version` direction-guard compare (latest>cur → prompt; latest<=cur → no prompt; custom → warning text).
- **Route:** `check-update` returns `currentSource` + `isCustomBuild` from a seeded marker.
- **Installer:** `bash -n install.sh`; `--published` arg parsing → the `npm install -g lm-assist@<ver>` branch is selected (dry-run/extracted-logic test, not a live global install); install.ps1 pure-ASCII + AST parse.
- **Web:** `next build` compiles; a light render/logic check that the dropdown assembles the right `source` string and `handleUpgrade` includes it in the body.
- **Integration:** `POST /dev-mode/upgrade {source:"0.1.70"}` (dry/guarded) forwards `--from 0.1.70` (assert via the route's returned `source`, without actually reinstalling on a live host).

## 7. Out of scope (YAGNI)
- Auto-installing the plugin from a custom ref (upgrade.js intentionally skips the marketplace plugin for custom builds — unchanged).
- A full "rollback to previous build" feature.
- Changing `lm-assist upgrade`'s CLI (already supports both).
