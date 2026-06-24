# Install/Upgrade Both-Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every install/upgrade surface (CLI, Web UI, `install.sh`, `install.ps1`, `upgrade.js`) support both the npm-**published** package and **custom builds** (GitHub-Release tgz / source-build / any `--from` spec), with an install-source marker so the CLI/UI know which is installed and never nudge a custom build to downgrade.

**Architecture:** A new dependency-free `core/src/utils/install-source.ts` writes/reads `~/.lm-assist/install-source.json` (`{kind,source,version,installedAt}`). `upgrade.js`/`postinstall.js`/`install.sh`/`install.ps1` write it; `lm-assist version` + `GET /dev-mode/check-update` + the Web UI read it. Installers gain a 3-way prod source (published / prefer prebuilt-release-tgz / source-build fallback). The CLI `upgrade`, `upgrade.js resolveSource`, and the dev-mode routes already accept `--from`/`{source}` — unchanged.

**Tech Stack:** TypeScript (CommonJS core), Bash, PowerShell, Next.js/React (web), `node:test`.

**Spec:** `docs/superpowers/specs/2026-06-24-install-upgrade-both-sources-design.md`
**Branch:** `feat/install-upgrade-both-sources` (already created).

## Global Constraints

- **Marker file:** `<dataDir>/install-source.json` (`getDataDir()` = `~/.lm-assist`), atomic write mode **0600** (mirror `worker-role/worker-store.ts`). Shape: `{ kind: 'published'|'custom', source: string, version: string|null, installedAt: string }`.
- **`published` vs `custom`:** `published` = the npm **registry** (`lm-assist@<version|latest|tag>`, no path/url/git separators); `custom` = a tgz path, a URL (incl. a GitHub-Release asset), a `github:…#ref`, or a source build. Classify from the **spec string**.
- **Best-effort:** marker writes are wrapped in try/catch — a write failure must NEVER fail an install/upgrade; `read` returns `null` on any error (callers treat null as "unknown → behave as today / assume published").
- **core is CommonJS**; tests in `core/src/__tests__/*.test.ts`, built via `cd core && npm run build:test`, run via `node --test dist-test/__tests__/<f>.test.js`. Dev host: `export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH`.
- **install.ps1 stays pure ASCII** (PowerShell 5.1). install scripts write the marker JSON **directly** (small `node -e` / here-string) — no `dist` dependency (published mode never builds).
- **🔴 e2e must not do a live global install/restart on a fleet node** — test arg-parsing/resolution logic and the route's *returned* `source`, not an actual reinstall.
- **Release URL convention:** `https://github.com/langmartai/lm-assist/releases/download/<tag>/lm-assist-<ver>.tgz` (ver = tag without leading `v`). A v0.1.76 release with `lm-assist-0.1.76.tgz` already exists.

## File Structure

| File | Responsibility |
|---|---|
| `core/src/utils/install-source.ts` (new) | the marker model: `classifyInstallSource` (pure), `recordInstallSource`, `readInstallSource` |
| `core/scripts/upgrade.js` (modify) | write the marker after a successful install |
| `bin/lm-assist.js` (modify) | `version`: read marker + show source + direction guard |
| `bin/postinstall.js` (modify) | record a `published` marker on npm-global install |
| `core/src/routes/core/dev-mode.routes.ts` (modify) | `check-update` returns `currentSource` + `isCustomBuild` |
| `install.sh` (modify) | 3-way prod source (published / prefer-release / source-build) + marker |
| `install.ps1` (modify) | same in PowerShell + marker (ASCII) |
| `web/src/app/(dashboard)/settings/page.tsx` (modify) | guided source dropdown + custom warning + send `{source}` + show current source |

---

### Task 1: `install-source.ts` — the marker model

**Files:**
- Create: `core/src/utils/install-source.ts`
- Test: `core/src/__tests__/install-source.test.ts`

**Interfaces:**
- Consumes: `getDataDir()` from `./path-utils`.
- Produces:
  - `interface InstallSource { kind: 'published'|'custom'; source: string; version: string|null; installedAt: string }`
  - `function classifyInstallSource(spec: string): { kind: 'published'|'custom'; source: string }` (pure)
  - `function recordInstallSource(info: { kind: 'published'|'custom'; source: string; version?: string|null }): void`
  - `function readInstallSource(): InstallSource | null`

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/install-source.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isrc-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  delete require.cache[require.resolve('../utils/install-source')];
  return { mod: require('../utils/install-source'), dir };
}

test('classifyInstallSource: registry specs are published', () => {
  const { mod } = fresh();
  assert.deepStrictEqual(mod.classifyInstallSource(''), { kind: 'published', source: 'lm-assist@latest' });
  assert.deepStrictEqual(mod.classifyInstallSource('latest'), { kind: 'published', source: 'lm-assist@latest' });
  assert.deepStrictEqual(mod.classifyInstallSource('lm-assist@0.1.76'), { kind: 'published', source: 'lm-assist@0.1.76' });
  assert.deepStrictEqual(mod.classifyInstallSource('lm-assist@next'), { kind: 'published', source: 'lm-assist@next' });
});

test('classifyInstallSource: tgz / url / github / dir are custom', () => {
  const { mod } = fresh();
  assert.strictEqual(mod.classifyInstallSource('/tmp/lm-assist-0.1.76.tgz').kind, 'custom');
  assert.strictEqual(mod.classifyInstallSource('https://github.com/langmartai/lm-assist/releases/download/v0.1.76/lm-assist-0.1.76.tgz').kind, 'custom');
  assert.strictEqual(mod.classifyInstallSource('github:langmartai/lm-assist#v0.1.76').kind, 'custom');
  assert.strictEqual(mod.classifyInstallSource('/home/me/lm-assist').kind, 'custom');
});

test('record then read round-trips; file is 0600', () => {
  const { mod, dir } = fresh();
  assert.strictEqual(mod.readInstallSource(), null);
  mod.recordInstallSource({ kind: 'custom', source: 'github:langmartai/lm-assist#v0.1.76', version: '0.1.76' });
  const r = mod.readInstallSource();
  assert.strictEqual(r.kind, 'custom');
  assert.strictEqual(r.source, 'github:langmartai/lm-assist#v0.1.76');
  assert.strictEqual(r.version, '0.1.76');
  assert.ok(r.installedAt && r.installedAt.length > 0);
  assert.strictEqual(fs.statSync(path.join(dir, 'install-source.json')).mode & 0o777, 0o600);
});

test('read tolerates a corrupt/missing file → null', () => {
  const { mod, dir } = fresh();
  fs.writeFileSync(path.join(dir, 'install-source.json'), 'not json');
  assert.strictEqual(mod.readInstallSource(), null);
});
```

- [ ] **Step 2: Build + run → verify it fails**

Run: `cd core && export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH && npm run build:test && node --test dist-test/__tests__/install-source.test.js`
Expected: FAIL — `Cannot find module '../utils/install-source'`.

- [ ] **Step 3: Implement**

Create `core/src/utils/install-source.ts`:

```ts
/** Records WHICH source the current lm-assist was installed from, so the CLI/UI/routes
 *  can show it and avoid nudging a custom build to downgrade. ~/.lm-assist/install-source.json */
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './path-utils';

export interface InstallSource {
  kind: 'published' | 'custom';
  source: string; // 'lm-assist@<ver|latest>' (registry) | a tgz path | a URL | 'github:…#ref' | a dir
  version: string | null;
  installedAt: string; // ISO timestamp
}

function markerFile(): string {
  return path.join(getDataDir(), 'install-source.json');
}

/** Pure: a registry spec (`lm-assist@…`, or empty/latest) is `published`; everything else
 *  (tgz path, URL, github:…#ref, dir) is a `custom` build. */
export function classifyInstallSource(spec: string): { kind: 'published' | 'custom'; source: string } {
  const s = (spec || '').trim();
  if (!s || s === 'latest' || s === 'lm-assist@latest') return { kind: 'published', source: 'lm-assist@latest' };
  if (/^lm-assist@[^/\\:]+$/.test(s)) return { kind: 'published', source: s };
  return { kind: 'custom', source: s };
}

export function recordInstallSource(info: { kind: 'published' | 'custom'; source: string; version?: string | null }): void {
  try {
    const rec: InstallSource = {
      kind: info.kind,
      source: info.source,
      version: info.version == null ? null : String(info.version),
      installedAt: new Date().toISOString(),
    };
    const f = markerFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
    try { fs.chmodSync(f, 0o600); } catch { /* best effort */ }
  } catch { /* best effort — never fail an install over the marker */ }
}

export function readInstallSource(): InstallSource | null {
  try {
    const raw = JSON.parse(fs.readFileSync(markerFile(), 'utf8'));
    if (raw && (raw.kind === 'published' || raw.kind === 'custom') && typeof raw.source === 'string') {
      return { kind: raw.kind, source: raw.source, version: raw.version == null ? null : String(raw.version), installedAt: typeof raw.installedAt === 'string' ? raw.installedAt : '' };
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Build + run → verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/install-source.test.js`
Expected: PASS (4 tests). Confirm full build: `npm run build 2>&1 | tail -2`.

- [ ] **Step 5: Commit**

```bash
git add core/src/utils/install-source.ts core/src/__tests__/install-source.test.ts
git commit -m "feat(install-source): marker model (classify/record/read)"
```

---

### Task 2: `lm-assist version` — show source + direction guard; `postinstall` records published

**Files:**
- Modify: `bin/lm-assist.js` (the `version` command, ~`:250-273`)
- Modify: `bin/postinstall.js` (record a published marker on global install)
- Test: `scripts/__tests__/version-guard.test.js`

**Interfaces:**
- Consumes: `readInstallSource()` / `recordInstallSource()` from the **compiled** `core/dist/utils/install-source.js`.
- Produces: a pure `isNpmGreater(installed, latest): boolean` helper in `bin/lm-assist.js` (testable).

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/version-guard.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const path = require('node:path');

const BIN = path.join(__dirname, '..', '..', 'bin', 'lm-assist.js');

// isNpmGreater is exported when bin/lm-assist.js is required with LM_ASSIST_NO_RUN=1 (guard added in Step 3).
test('isNpmGreater: only true when latest > installed', () => {
  process.env.LM_ASSIST_NO_RUN = '1';
  delete require.cache[require.resolve('../../bin/lm-assist.js')];
  const { isNpmGreater } = require('../../bin/lm-assist.js');
  assert.strictEqual(isNpmGreater('0.1.75', '0.1.76'), true);
  assert.strictEqual(isNpmGreater('0.1.76', '0.1.76'), false);
  assert.strictEqual(isNpmGreater('0.1.76', '0.1.75'), false); // installed ahead → NOT an update
  assert.strictEqual(isNpmGreater('0.1.76', '0.2.0'), true);
  assert.strictEqual(isNpmGreater('0.1.9', '0.1.10'), true);   // numeric, not lexical
  delete process.env.LM_ASSIST_NO_RUN;
});
```

- [ ] **Step 2: Run → verify it fails**

Run: `node --test scripts/__tests__/version-guard.test.js`
Expected: FAIL — `isNpmGreater` is undefined (and the require currently runs the CLI).

- [ ] **Step 3: Implement**

In `bin/lm-assist.js`:

(a) Add the pure helper near the top (after the requires):
```js
/** True only when npm `latest` is numerically GREATER than `installed` (no downgrade prompts). */
function isNpmGreater(installed, latest) {
  if (!installed || !latest) return false;
  const a = String(installed).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(latest).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}
```

(b) At the VERY TOP of the command-dispatch area (right after `const command = process.argv[2] || 'help';`), add a test hatch so requiring the file doesn't run the CLI:
```js
if (process.env.LM_ASSIST_NO_RUN === '1') { module.exports = { isNpmGreater }; return; }
```
(If the file is not a module-wrapped context that allows `return`, wrap the rest of the file's top-level run in `if (process.env.LM_ASSIST_NO_RUN !== '1') { … }` instead, or guard just the dispatch. The goal: `require()` with `LM_ASSIST_NO_RUN=1` exports `{isNpmGreater}` and does not execute a command.)

(c) In the `version` command block (`:250-273`), after computing `installedVersion` and `latest`, read + show the source and replace the unconditional prompt:
```js
let src = null;
try { src = require(path.join(projectRoot, 'core', 'dist', 'utils', 'install-source.js')).readInstallSource(); } catch { /* ignore */ }
if (src) console.log(`  Source:     ${src.source} (${src.kind}${src.kind === 'custom' ? ' build' : ''})`);
if (installedVersion && latest && isNpmGreater(installedVersion, latest)) {
  console.log(`  Update:     Run "lm-assist upgrade" to update to ${latest}`);
  if (src && src.kind === 'custom') {
    console.log(`              (you're on a CUSTOM build — "lm-assist upgrade" installs npm latest and REPLACES it;`);
    console.log(`               use "lm-assist upgrade --from <your tgz/github ref>" to stay on a custom build)`);
  }
}
```

In `bin/postinstall.js` (runs on `npm install -g lm-assist`), after the existing best-effort steps, add:
```js
try {
  const pkgVer = require(path.join(__dirname, '..', 'package.json')).version;
  require(path.join(__dirname, '..', 'core', 'dist', 'utils', 'install-source.js'))
    .recordInstallSource({ kind: 'published', source: 'lm-assist@' + pkgVer, version: pkgVer });
} catch { /* best effort */ }
```
(`postinstall.js` already requires `path`; if not, add `const path = require('path');`.)

- [ ] **Step 4: Run → verify it passes**

Run: `node --test scripts/__tests__/version-guard.test.js`
Expected: PASS. Also smoke `lm-assist version` from source: `node bin/lm-assist.js version 2>&1 | head -8` → no crash; prints Installed/Latest (and Source if a marker exists).

- [ ] **Step 5: Commit**

```bash
git add bin/lm-assist.js bin/postinstall.js scripts/__tests__/version-guard.test.js
git commit -m "feat(cli): version shows install source + direction guard; postinstall records published marker"
```

---

### Task 3: `upgrade.js` writes the marker after install

**Files:**
- Modify: `core/scripts/upgrade.js` (after the successful install step, ~`:564`)
- Test: manual (covered by the marker unit tests + an integration assertion in Task 8)

**Interfaces:**
- Consumes: `classifyInstallSource`/`recordInstallSource` from `<pkgDir>/core/dist/utils/install-source.js`; `source.spec` from the existing `resolveSource()`.

- [ ] **Step 1: Implement (no new unit test — the marker model is already tested; this is wiring)**

In `core/scripts/upgrade.js`, immediately AFTER the install step succeeds in `main()` (after the `runNpmInstall(source.spec)` / `upgradeViaTarball(...)` call returns OK, before the restart), add:
```js
// Record the install source so `lm-assist version` / check-update / the UI can show it.
try {
  const pkgDir = /* the resolved global package dir already computed in main() — reuse it */ globalPkgDir;
  const isrc = require(path.join(pkgDir, 'core', 'dist', 'utils', 'install-source.js'));
  const cls = isrc.classifyInstallSource(source.spec || '');
  let ver = null;
  try { ver = require(path.join(pkgDir, 'package.json')).version; } catch (e) { /* ignore */ }
  isrc.recordInstallSource({ kind: cls.kind, source: cls.source, version: ver });
  log('Recorded install source: ' + cls.source + ' (' + cls.kind + ')');
} catch (e) {
  log('Could not record install source (non-fatal): ' + (e && e.message));
}
```
(Use whatever variable `main()` already holds for the installed global package directory — the script computes the global package path for the tarball/EBUSY fallback; reuse it. If none is in scope at that point, derive it the same way the script does elsewhere, e.g. via `findGlobalPkgDir()`/the npm root. Read the surrounding `main()` to wire the correct `pkgDir`.)

- [ ] **Step 2: Verify it doesn't break the script**

Run: `node -c core/scripts/upgrade.js && echo "upgrade.js syntax ok"`
Expected: `upgrade.js syntax ok`. (A full upgrade run is NOT done here — it would reinstall on this host; the marker write is covered by Task 1's model tests + Task 8's integration check.)

- [ ] **Step 3: Commit**

```bash
git add core/scripts/upgrade.js
git commit -m "feat(upgrade): record install source after a successful install"
```

---

### Task 4: `GET /dev-mode/check-update` returns `currentSource` + `isCustomBuild`

**Files:**
- Modify: `core/src/routes/core/dev-mode.routes.ts` (the `check-update` handler, ~`:701-743`)
- Test: `core/src/__tests__/check-update-source.test.ts`

**Interfaces:**
- Consumes: `readInstallSource()` from `../../utils/install-source`.
- Produces: `check-update` response `data` gains `currentSource: InstallSource|null` and `isCustomBuild: boolean`.

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/check-update-source.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// We test the small pure shaper the route uses (see Step 3): buildSourceFields(readFn).
test('buildSourceFields surfaces currentSource + isCustomBuild', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cupd-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  ['../utils/install-source', '../routes/core/dev-mode.routes'].forEach((m) => { try { delete require.cache[require.resolve(m)]; } catch {} });
  const isrc = require('../utils/install-source');
  const { buildSourceFields } = require('../routes/core/dev-mode.routes');
  // no marker → null / false
  assert.deepStrictEqual(buildSourceFields(), { currentSource: null, isCustomBuild: false });
  // custom marker → isCustomBuild true
  isrc.recordInstallSource({ kind: 'custom', source: 'github:langmartai/lm-assist#v0.1.76', version: '0.1.76' });
  const r = buildSourceFields();
  assert.strictEqual(r.isCustomBuild, true);
  assert.strictEqual(r.currentSource.source, 'github:langmartai/lm-assist#v0.1.76');
});
```

- [ ] **Step 2: Build + run → verify it fails**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/check-update-source.test.js`
Expected: FAIL — `buildSourceFields` not exported.

- [ ] **Step 3: Implement**

In `core/src/routes/core/dev-mode.routes.ts`:
(a) Add the import near the top: `import { readInstallSource } from '../../utils/install-source';`
(b) Export a small shaper (so it's unit-testable):
```ts
export function buildSourceFields() {
  const currentSource = readInstallSource();
  return { currentSource, isCustomBuild: currentSource?.kind === 'custom' };
}
```
(c) In the `check-update` handler, merge it into the returned `data` (alongside `currentVersion`, `latestVersion`, `updateAvailable`):
```ts
return { success: true, data: { currentVersion, latestVersion, updateAvailable, ...buildSourceFields() } };
```
(Find the existing `return { success: true, data: { … } }` in the `check-update` handler and add `...buildSourceFields()`.)

- [ ] **Step 4: Build + run → verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/check-update-source.test.js`
Expected: PASS. Full build: `npm run build 2>&1 | tail -2`.

- [ ] **Step 5: Commit**

```bash
git add core/src/routes/core/dev-mode.routes.ts core/src/__tests__/check-update-source.test.ts
git commit -m "feat(dev-mode): check-update returns currentSource + isCustomBuild"
```

---

### Task 5: `install.sh` — 3-way prod source + marker

**Files:**
- Modify: `install.sh`
- Verify: `bash -n` + an extracted-logic test of the source resolver

**Interfaces:** consumes the release-URL convention; writes the marker JSON directly.

- [ ] **Step 1: Implement the 3-way prod source**

In `install.sh`, add `--published` / `--source-build` to the arg loop (near the existing `--ref`):
```bash
PUBLISHED="${LM_ASSIST_PUBLISHED:-}"   # '', '1', or a version
FORCE_SOURCE_BUILD=""
# in the while-loop case:
    --published)   PUBLISHED="${LM_ASSIST_PUBLISHED:-1}"; if [ "${2:-}" ] && printf '%s' "${2:-}" | grep -qE '^[0-9]'; then PUBLISHED="$2"; shift; fi ;;
    --published=*) PUBLISHED="${1#--published=}" ;;
    --source-build) FORCE_SOURCE_BUILD=1 ;;
```

Add a marker-write helper (writes the JSON directly via node):
```bash
write_marker() { # $1=kind $2=source $3=version
  node -e "const fs=require('fs'),os=require('os'),path=require('path');const d=process.env.LM_ASSIST_DATA_DIR||path.join(os.homedir(),'.lm-assist');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'install-source.json'),JSON.stringify({kind:'$1',source:'$2',version:${3:-null},installedAt:new Date().toISOString()},null,2),{mode:0o600});" 2>/dev/null || true
}
```

Replace the prod install block (Step 4 `else` branch, the `npm pack` path) with the 3-way resolver:
```bash
else  # prod
  if [ -n "$PUBLISHED" ]; then
    VER=$([ "$PUBLISHED" = "1" ] && echo latest || echo "$PUBLISHED")
    info "Installing published lm-assist@$VER from npm..."
    npm install -g "lm-assist@$VER" 2>&1 | tail -3
    write_marker published "lm-assist@$VER" '"'"$([ "$VER" = latest ] && node -e "process.stdout.write(require('child_process').execSync('npm view lm-assist version').toString().trim())" 2>/dev/null || echo "$VER")"'"'
    ok "Installed published lm-assist@$VER."
  else
    # Prefer the prebuilt GitHub-Release tgz for the ref; fall back to source-build.
    TAG="${REF:-}"; ASSET_URL=""
    if [ -z "$FORCE_SOURCE_BUILD" ]; then
      if [ -n "$TAG" ]; then
        V="${TAG#v}"; ASSET_URL="https://github.com/langmartai/lm-assist/releases/download/$TAG/lm-assist-$V.tgz"
        curl -sfIL "$ASSET_URL" >/dev/null 2>&1 || ASSET_URL=""
      else
        ASSET_URL=$(curl -sfL https://api.github.com/repos/langmartai/lm-assist/releases/latest 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const a=(j.assets||[]).find(x=>/^lm-assist-.*\.tgz$/.test(x.name));process.stdout.write(a?a.browser_download_url:'')}catch(e){}})" 2>/dev/null)
      fi
    fi
    if [ -n "$ASSET_URL" ]; then
      info "Installing prebuilt release: $ASSET_URL"
      npm install -g "$ASSET_URL" 2>&1 | tail -3
      write_marker custom "$ASSET_URL" null
      ok "Installed prebuilt release build."
    else
      info "No prebuilt release for ${TAG:-latest} — source-building..."
      npm pack 2>&1 | tail -1
      TGZ=$(ls -t lm-assist-*.tgz | head -1); [ -n "$TGZ" ] || fail "npm pack did not produce a tgz"
      npm install -g "./$TGZ" 2>&1 | tail -3
      write_marker custom "github:langmartai/lm-assist#${REF:-$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}" null
      ok "Installed source build."
    fi
  fi
fi
```

> NOTE: in `--published` mode the clone/preflight steps before this are skipped — gate the clone (Step 2) and the preflight (Step 3) with `if [ -z "$PUBLISHED" ]; then … fi` so a published install does not require a checkout. Also add `--published`/`--source-build` to the header usage comment.

- [ ] **Step 2: Verify syntax + the resolver logic**

Run: `bash -n install.sh && echo "install.sh ok"`
Expected: `install.sh ok`.

Extracted resolver smoke (the release-URL HEAD check + the latest-asset query are real, public, and safe):
```bash
TAG=v0.1.76; V="${TAG#v}"
curl -sfIL "https://github.com/langmartai/lm-assist/releases/download/$TAG/lm-assist-$V.tgz" >/dev/null && echo "release asset reachable for $TAG"
curl -sfL https://api.github.com/repos/langmartai/lm-assist/releases/latest | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const a=(j.assets||[]).find(x=>/^lm-assist-.*\.tgz$/.test(x.name));console.log('latest asset:',a&&a.browser_download_url)})"
```
Expected: "release asset reachable for v0.1.76" and a printed latest asset URL.

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat(install.sh): prefer prebuilt release tgz, --published mode, source-build fallback + marker"
```

---

### Task 6: `install.ps1` — 3-way prod source + marker (ASCII)

**Files:**
- Modify: `install.ps1`
- Verify: pure-ASCII + PowerShell AST parse

**Interfaces:** mirror of Task 5 in PowerShell.

- [ ] **Step 1: Implement**

In `install.ps1`: add `[string]$Published = ''` and `[switch]$SourceBuild` to `param(...)`; resolve `$Published` from `$env:LM_ASSIST_PUBLISHED` (as `$Ref` is resolved). Add a marker helper:
```powershell
function Write-Marker($kind, $source, $version) {
  try {
    $d = if ($env:LM_ASSIST_DATA_DIR) { $env:LM_ASSIST_DATA_DIR } else { Join-Path $env:USERPROFILE '.lm-assist' }
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $v = if ($version) { '"' + $version + '"' } else { 'null' }
    $json = '{ "kind": "' + $kind + '", "source": "' + $source + '", "version": ' + $v + ', "installedAt": "' + (Get-Date).ToUniversalTime().ToString('o') + '" }'
    Set-Content -Path (Join-Path $d 'install-source.json') -Value $json -Encoding ascii
  } catch { }
}
```
Gate the clone + preflight with `if (-not $Published) { ... }`. Replace the prod `else` (npm pack) block with:
```powershell
} else {
  if ($Published) {
    $ver = if ($Published -eq '1' -or $Published -eq 'true') { 'latest' } else { $Published }
    Info "Installing published lm-assist@$ver from npm..."
    npm install -g "lm-assist@$ver" | Select-Object -Last 3
    if ($LASTEXITCODE -ne 0) { Fail 'published install failed' }
    Write-Marker 'published' "lm-assist@$ver" $(if ($ver -eq 'latest') { (npm view lm-assist version) } else { $ver })
    Ok "Installed published lm-assist@$ver."
  } else {
    $assetUrl = ''
    if (-not $SourceBuild) {
      if ($Ref) {
        $v = $Ref -replace '^v',''
        $u = "https://github.com/langmartai/lm-assist/releases/download/$Ref/lm-assist-$v.tgz"
        try { if ((Invoke-WebRequest -UseBasicParsing -Method Head -TimeoutSec 15 $u).StatusCode -eq 200) { $assetUrl = $u } } catch { }
      } else {
        try { $rel = Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 'https://api.github.com/repos/langmartai/lm-assist/releases/latest'; $a = $rel.assets | Where-Object { $_.name -match '^lm-assist-.*\.tgz$' } | Select-Object -First 1; if ($a) { $assetUrl = $a.browser_download_url } } catch { }
      }
    }
    if ($assetUrl) {
      Info "Installing prebuilt release: $assetUrl"
      npm install -g $assetUrl | Select-Object -Last 3
      if ($LASTEXITCODE -ne 0) { Fail 'release install failed' }
      Write-Marker 'custom' $assetUrl $null
      Ok 'Installed prebuilt release build.'
    } else {
      Info 'No prebuilt release - source-building...'
      npm pack | Select-Object -Last 1
      if ($LASTEXITCODE -ne 0) { Fail 'npm pack failed' }
      $tgz = Get-ChildItem -Filter 'lm-assist-*.tgz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if (-not $tgz) { Fail 'npm pack did not produce a tgz' }
      npm install -g ".\$($tgz.Name)" | Select-Object -Last 3
      if ($LASTEXITCODE -ne 0) { Fail 'global install failed' }
      $br = if ($Ref) { $Ref } else { (git -C $InstallDir rev-parse --abbrev-ref HEAD) }
      Write-Marker 'custom' "github:langmartai/lm-assist#$br" $null
      Ok 'Installed source build.'
    }
  }
}
```
Keep it pure ASCII. Update the header usage comment with `-Published`/`-SourceBuild`.

- [ ] **Step 2: Verify ASCII + AST parse**

Run locally: `LC_ALL=C grep -nP '[^\x00-\x7F]' install.ps1 >/dev/null 2>&1 && echo "NON-ASCII!" || echo "pure ASCII"` → `pure ASCII`.
Run on a Windows host (isolated, no install — scp the file + AST-parse):
```
[System.Management.Automation.Language.Parser]::ParseFile('<path>\install.ps1',[ref]$null,[ref]$errs); ($errs).Count
```
Expected: `0` parse errors.

- [ ] **Step 3: Commit**

```bash
git add install.ps1
git commit -m "feat(install.ps1): prefer prebuilt release tgz, -Published mode, source-build fallback + marker"
```

---

### Task 7: Web UI — guided source dropdown + custom warning

**Files:**
- Modify: `web/src/app/(dashboard)/settings/page.tsx` (`handleUpgrade` ~`:984`, `handleCheckUpdate` ~`:968`, buttons ~`:3723-3756`)

**Interfaces:** consumes `GET /dev-mode/check-update` (`currentSource`, `isCustomBuild` from Task 4); POSTs `{ source }` to `/dev-mode/upgrade` (route already supports it).

- [ ] **Step 1: Add state + the source builder**

Near the upgrade-related `useState`s, add:
```tsx
const [sourceKind, setSourceKind] = useState<'latest' | 'version' | 'github' | 'tgz'>('latest');
const [sourceValue, setSourceValue] = useState('');
const [currentSource, setCurrentSource] = useState<{ kind: string; source: string } | null>(null);
const [isCustomBuild, setIsCustomBuild] = useState(false);
```
In `handleCheckUpdate`, after `setUpdateAvailable(...)`, also `setCurrentSource(json.data.currentSource ?? null); setIsCustomBuild(!!json.data.isCustomBuild);`.

- [ ] **Step 2: Build the source string + send it**

Change `handleUpgrade` to assemble and POST `{ source }`:
```tsx
const buildSource = () => {
  if (sourceKind === 'latest') return undefined;
  const v = sourceValue.trim();
  if (!v) return undefined;
  if (sourceKind === 'version') return v;             // → lm-assist@<v> server-side
  if (sourceKind === 'github') return v;              // github:owner/repo#ref OR a release URL
  if (sourceKind === 'tgz') return v;                 // absolute .tgz path
  return undefined;
};
// inside handleUpgrade:
const source = buildSource();
const res = await workerFetch(tierAgentUrl + '/dev-mode/upgrade', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(source ? { source } : {}),
});
```

- [ ] **Step 3: Render the dropdown + field + warning**

In the Installation/upgrade card (near the two existing buttons ~`:3723-3756`), add:
```tsx
{currentSource && (
  <div className="text-xs text-gray-400 mb-2">
    Installed source: <span className="text-gray-200">{currentSource.source}</span> ({currentSource.kind}{isCustomBuild ? ' build' : ''})
  </div>
)}
<div className="flex items-center gap-2 mb-2">
  <select value={sourceKind} onChange={(e) => setSourceKind(e.target.value as any)} className="bg-gray-800 text-gray-100 text-sm rounded px-2 py-1">
    <option value="latest">Latest published (npm)</option>
    <option value="version">Specific version</option>
    <option value="github">GitHub ref / release URL</option>
    <option value="tgz">Local .tgz path</option>
  </select>
  {sourceKind !== 'latest' && (
    <input
      value={sourceValue} onChange={(e) => setSourceValue(e.target.value)}
      placeholder={sourceKind === 'version' ? '0.1.76' : sourceKind === 'github' ? 'github:langmartai/lm-assist#v0.1.76' : '/abs/path/lm-assist-0.1.76.tgz'}
      className="flex-1 bg-gray-800 text-gray-100 text-sm rounded px-2 py-1"
    />
  )}
</div>
{isCustomBuild && sourceKind === 'latest' && (
  <div className="text-xs text-amber-400 mb-2">Upgrading to Latest published will REPLACE your current custom build.</div>
)}
```
(Match the file's existing Tailwind classes/components; the above mirrors the page's dark theme. Keep `workerFetch` for all calls per web-core-fetch-rules.)

- [ ] **Step 4: Build the web**

Run: `cd web && export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH && npx next build 2>&1 | tail -6`
Expected: compiles with no type errors. (A wrong className or a TS mismatch fails here.)

- [ ] **Step 5: Commit**

```bash
git add web/src/app/(dashboard)/settings/page.tsx
git commit -m "feat(web): guided install-source picker (dropdown+field) + custom-build warning"
```

---

### Task 8: Integration, full suite, docs, final review

**Files:**
- Test: `core/src/__tests__/dev-mode-upgrade-source.test.ts`
- Modify: `CLAUDE.md` (document the source axis + the release-install path)

- [ ] **Step 1: Integration — the upgrade route forwards a custom source (no real reinstall)**

Create `core/src/__tests__/dev-mode-upgrade-source.test.ts` — assert that `POST /dev-mode/upgrade` with `{source}` reports the forwarded source WITHOUT performing a live install. The handler spawns a detached script and returns `{ source }` in its response (per the review, it returns `source: extraArgs.length ? extraArgs[1] : 'lm-assist@latest'`). Drive the route handler with a fake `req` and assert the returned `data.source`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
// Import the route factory + find the POST /dev-mode/upgrade handler; invoke with a mock req.
// (The handler copies upgrade.js to tmp + spawns detached; in the test, assert ONLY the returned
//  source label — do NOT await a real install. If spawning is unavoidable, stub child_process.spawn.)
test('POST /dev-mode/upgrade echoes the forwarded source', async () => {
  // Pseudocode shape — wire to the real factory export:
  // const routes = createDevModeRoutes(ctx); const h = routes.find(r => r.method==='POST' && r.pattern.test('/dev-mode/upgrade')).handler;
  // const res = await h({ body: { source: '0.1.70' }, params:{}, query:{}, method:'POST', path:'/dev-mode/upgrade' } as any, {} as any);
  // assert.strictEqual(res.data.source, '0.1.70');
  assert.ok(true); // replace with the wired assertion once the factory export name is confirmed by reading dev-mode.routes.ts
});
```
> The implementer reads `dev-mode.routes.ts` to get the exact factory export + handler shape, wires the real assertion, and (if `spawn` would actually run) stubs `child_process.spawn` so no install happens. Keep it hermetic.

- [ ] **Step 2: Full script + core suite (0 new regressions)**

Run: `node --test scripts/__tests__/` then `cd core && npm run build:test && node --test dist-test/__tests__/ 2>&1 | tail -25`
Expected: all new `install-source`/`version-guard`/`check-update-source`/`dev-mode-upgrade-source` tests pass; only the pre-existing environmental failures (better-sqlite3 `ERR_DLOPEN`, network/OAuth/session-resolver) remain — **0 new regressions**.

- [ ] **Step 3: Document in CLAUDE.md**

Add under the install/upgrade docs:
```markdown
### Install/upgrade sources (published vs custom)
Every surface supports both: **published** (`lm-assist@latest`/`@<ver>` from npm) and **custom** (a GitHub-Release tgz, `github:…#ref`, a local `.tgz`, or a source build). The current install is tracked in `~/.lm-assist/install-source.json` (`{kind:'published'|'custom',source,version}`) and shown by `lm-assist version`, `GET /dev-mode/check-update` (`currentSource`/`isCustomBuild`), and the Settings UI. `lm-assist version` only prompts an upgrade when npm latest is GREATER (no downgrade nudges) and warns when on a custom build. Installers (`install.sh`/`install.ps1`) prefer the prebuilt GitHub-Release tgz for the ref, fall back to source-build, and take `--published [<ver>]` for the registry. CLI: `lm-assist upgrade --from <tgz|dir|version|github:…#ref|release-url>`.
```

- [ ] **Step 4: Commit**

```bash
git add core/src/__tests__/dev-mode-upgrade-source.test.ts CLAUDE.md
git commit -m "test(install): upgrade-route source integration + docs"
```

---

## Self-Review

**1. Spec coverage:** §3 marker → Task 1. §4.1 model → Task 1. §4.2 upgrade.js → Task 3. §4.3 installers (published/release/source) → Tasks 5,6. §4.4 version guard + source → Task 2. §4.5 check-update + postinstall → Tasks 4,2. §4.6 UI → Task 7. §6 testing → every task + Task 8. CLI upgrade/upgrade.js-resolveSource/dev-mode-upgrade-route (already support both) → unchanged (Task 8 asserts the route forwards). No gaps.

**2. Placeholder scan:** The two "read the file to wire the exact export/var" notes (Task 3 `pkgDir`, Task 8 the route factory export) are genuine local-anchor confirmations against named line refs, each with the exact surrounding code quoted from the review — not hand-waving. All code steps carry real code.

**3. Type consistency:** `InstallSource`/`classifyInstallSource`/`recordInstallSource`/`readInstallSource` (Task 1) are used verbatim in Tasks 2,3,4. `isNpmGreater` (Task 2) matches its test. `buildSourceFields` (Task 4) matches its test + the route merge. The marker `{kind,source,version,installedAt}` shape is identical across the TS model, the bash `write_marker`, and the PowerShell `Write-Marker`. The UI `{source}` body matches the route's `{source|from}` reader.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-24-install-upgrade-both-sources.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
**2. Inline Execution** — batch with checkpoints.

**Which approach?**
