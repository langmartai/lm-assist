# Guided Cross-Platform Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give lm-assist one guided, correct bootstrap path on Windows AND Linux across Node versions — a single shared preflight backing a fixed `install.sh`, a new `install.ps1`, a `lm-assist doctor` command, honest `engines`, and an OS-aware guide.

**Architecture:** A dependency-free CommonJS `scripts/preflight.js` is the single source of truth for environment requirements (Node ≥ 20.9, git/npm, post-clone chokidar pin). It runs on *any* Node, so it can diagnose a too-old one. The shell installers do only a bare native gate (is node/git present + major) then defer to `preflight.js`. Both installers default to a symmetric **prod** flow (`npm pack` → `npm install -g ./tgz` → services on :3100/:3848) with a `--dev` opt-in (:3200/:3948). Windows reuses existing handling (`service-manager.ts` WMI/Session-1 start, `upgrade.js` primitives) by *calling* `lm-assist start`/`upgrade --from`, never reimplementing it.

**Tech Stack:** Node.js (CommonJS), Bash, PowerShell, TypeScript (core), `node:test` runner.

**Spec:** `docs/superpowers/specs/2026-06-24-guided-cross-platform-bootstrap-design.md`
**Branch:** `feat/guided-cross-platform-bootstrap` (already created).

## Global Constraints

- **Node floor: `>= 20.9.0`** (the Next 16 web build fails below it). The preflight gate uses `{ major: 20, minor: 9 }`.
- **`scripts/preflight.js` is dependency-free CommonJS**, only Node built-ins, must parse/run on Node ≥ 14 (so it can report "your Node is too old"). No optional-chaining-dependent control flow that breaks old Node; keep it conservative.
- **core is CommonJS** (`module: commonjs`): no ESM-only deps, no un-guarded `await import()` of ESM. Core TS tests live in `core/src/__tests__/*.test.ts`, built via `cd core && npm run build:test`, run via `node --test dist-test/__tests__/<f>.test.js`.
- **`--ignore-scripts` on every root `npm install`** (the dev dep tree's transitive `onnxruntime-node` postinstall dies otherwise). The `npm install -g ./tgz` step needs NO `--ignore-scripts` (prod-only tree installs clean; compiles `better-sqlite3`).
- **chokidar pin `^3.6.0`** must resolve to `3.6.x` from `core/dist` (4/5 are ESM-only → `ERR_REQUIRE_ESM` → Core won't boot).
- **Run npm from the repo ROOT** (workspaces hoist; a nested `core/node_modules` shadows the hoist).
- **Node policy = guidance only.** Never install or switch Node. On too-old Node, print the manager-specific upgrade command (detect nvm / nvm-windows / fnm) and fail.
- **Dev host commands need Node ≥ 20.9:** prefix with `export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH`.
- **🔴 Do NOT disturb the running fleet during e2e.** 117 (this host) and 107 (Windows) run **prod** lm-assist on :3100/:3848. e2e MUST use an isolated `npm_config_prefix` + `LM_ASSIST_DATA_DIR` and the **free dev ports (3200/3948)**, or a dedicated fresh box — never a real `npm install -g` / `lm-assist start` that overwrites or restarts the live fleet node.

---

### Task 1: `scripts/preflight.js` — pure evaluation logic + unit tests

**Files:**
- Create: `scripts/preflight.js` (pure functions in this task; CLI added in Task 2)
- Test: `scripts/__tests__/preflight.test.js`

**Interfaces:**
- Produces (consumed by Task 2's CLI and Task 5's tests):
  - `MIN_NODE = { major: 20, minor: 9 }`
  - `parseNodeVersion(v: string) → {major,minor,patch} | null`
  - `nodeMeetsMinimum(parsed, min?) → boolean`
  - `nodeUpgradeGuidance(platform: string, managers: {nvm?,fnm?,nvmWindows?}) → string`
  - `evaluate(input) → { ok, platform, arch, nodeVersion, checks:[{name,ok,hard,detail}], guidance }`
    where `input = { nodeVersion, platform, arch?, hasGit, hasNpm, managers, phase, chokidar? }`, `phase ∈ {'pre-clone','post-clone'}`, `chokidar = { resolved:boolean, version?:string, error?:string }`.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/preflight.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const pf = require('../preflight.js');

test('parseNodeVersion parses v?MAJOR.MINOR.PATCH', () => {
  assert.deepStrictEqual(pf.parseNodeVersion('v20.9.0'), { major: 20, minor: 9, patch: 0 });
  assert.deepStrictEqual(pf.parseNodeVersion('18.20.4'), { major: 18, minor: 20, patch: 4 });
  assert.strictEqual(pf.parseNodeVersion('garbage'), null);
  assert.strictEqual(pf.parseNodeVersion(''), null);
});

test('nodeMeetsMinimum gates at 20.9', () => {
  assert.strictEqual(pf.nodeMeetsMinimum({ major: 20, minor: 9, patch: 0 }), true);
  assert.strictEqual(pf.nodeMeetsMinimum({ major: 20, minor: 19, patch: 6 }), true);
  assert.strictEqual(pf.nodeMeetsMinimum({ major: 22, minor: 0, patch: 0 }), true);
  assert.strictEqual(pf.nodeMeetsMinimum({ major: 20, minor: 8, patch: 9 }), false);
  assert.strictEqual(pf.nodeMeetsMinimum({ major: 18, minor: 20, patch: 4 }), false);
  assert.strictEqual(pf.nodeMeetsMinimum(null), false);
});

test('nodeUpgradeGuidance picks the present manager per OS', () => {
  assert.match(pf.nodeUpgradeGuidance('linux', { nvm: true }), /nvm install 20 && nvm use 20/);
  assert.match(pf.nodeUpgradeGuidance('linux', { fnm: true }), /fnm install 20/);
  assert.match(pf.nodeUpgradeGuidance('linux', {}), /nodejs\.org/);
  assert.match(pf.nodeUpgradeGuidance('win32', { nvmWindows: true }), /nvm install 20\.19\.6/);
  assert.match(pf.nodeUpgradeGuidance('win32', { fnm: true }), /fnm install 20/);
  assert.match(pf.nodeUpgradeGuidance('win32', {}), /nodejs\.org/);
});

test('evaluate: too-old node fails hard with manager guidance', () => {
  const r = pf.evaluate({ nodeVersion: 'v18.20.4', platform: 'linux', hasGit: true, hasNpm: true, managers: { nvm: true }, phase: 'pre-clone' });
  assert.strictEqual(r.ok, false);
  assert.match(r.guidance, /nvm install 20/);
  assert.strictEqual(r.checks.find((c) => c.name === 'node').ok, false);
});

test('evaluate: good node + prereqs passes pre-clone with no guidance', () => {
  const r = pf.evaluate({ nodeVersion: 'v22.0.0', platform: 'linux', hasGit: true, hasNpm: true, managers: {}, phase: 'pre-clone' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.guidance, null);
});

test('evaluate: missing git fails hard', () => {
  const r = pf.evaluate({ nodeVersion: 'v22.0.0', platform: 'linux', hasGit: false, hasNpm: true, managers: {}, phase: 'pre-clone' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.checks.find((c) => c.name === 'git').ok, false);
});

test('evaluate: post-clone chokidar 4/5 fails with pin guidance', () => {
  const r = pf.evaluate({ nodeVersion: 'v22.0.0', platform: 'linux', hasGit: true, hasNpm: true, managers: {}, phase: 'post-clone', chokidar: { resolved: true, version: '5.0.0' } });
  assert.strictEqual(r.ok, false);
  assert.match(r.guidance, /chokidar@\^3\.6\.0/);
});

test('evaluate: post-clone chokidar 3.6.0 passes', () => {
  const r = pf.evaluate({ nodeVersion: 'v22.0.0', platform: 'linux', hasGit: true, hasNpm: true, managers: {}, phase: 'post-clone', chokidar: { resolved: true, version: '3.6.0' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.guidance, null);
});

test('evaluate: post-clone chokidar unresolved fails', () => {
  const r = pf.evaluate({ nodeVersion: 'v22.0.0', platform: 'linux', hasGit: true, hasNpm: true, managers: {}, phase: 'post-clone', chokidar: { resolved: false, error: 'not found' } });
  assert.strictEqual(r.ok, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/__tests__/preflight.test.js`
Expected: FAIL — `Cannot find module '../preflight.js'`.

- [ ] **Step 3: Write the minimal implementation (pure logic only)**

Create `scripts/preflight.js`:

```js
#!/usr/bin/env node
'use strict';
/**
 * scripts/preflight.js — lm-assist environment preflight / doctor (single source of truth).
 *
 * Dependency-free CommonJS; only Node built-ins; must parse + run on ANY Node (incl. a
 * too-old one) so it can diagnose itself. Pure logic here; the CLI + IO probes are in Task 2.
 *
 * CLI (Task 2): node scripts/preflight.js [--json] [--phase=pre-clone|post-clone] [--repo=<dir>]
 * Exit 0 iff every HARD check passes.
 */

var MIN_NODE = { major: 20, minor: 9 }; // Next 16 web build floor

/** Parse "v20.9.0" / "20.9.0" → {major,minor,patch} | null. */
function parseNodeVersion(v) {
  var m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** True if parsed >= min (default MIN_NODE). */
function nodeMeetsMinimum(parsed, min) {
  min = min || MIN_NODE;
  if (!parsed) return false;
  if (parsed.major !== min.major) return parsed.major > min.major;
  return parsed.minor >= min.minor;
}

/** The exact upgrade command to print when Node is too old (never executed). */
function nodeUpgradeGuidance(platform, managers) {
  managers = managers || {};
  var target = '20';
  var targetFull = '20.19.6';
  if (platform === 'win32') {
    if (managers.nvmWindows) return 'nvm install ' + targetFull + ' ; nvm use ' + targetFull;
    if (managers.fnm) return 'fnm install ' + target + ' ; fnm use ' + target;
    return 'Download Node.js LTS (>= 20.9) from https://nodejs.org/ and re-run the installer.';
  }
  if (managers.nvm) return 'nvm install ' + target + ' && nvm use ' + target;
  if (managers.fnm) return 'fnm install ' + target + ' && fnm use ' + target;
  return 'Install Node.js LTS (>= 20.9) from https://nodejs.org/ (or your package manager) and re-run.';
}

/** Build the full evaluation from injected inputs (no IO). */
function evaluate(input) {
  input = input || {};
  var checks = [];
  var parsed = parseNodeVersion(input.nodeVersion);
  var nodeOk = nodeMeetsMinimum(parsed, MIN_NODE);
  checks.push({
    name: 'node', ok: nodeOk, hard: true,
    detail: nodeOk
      ? input.nodeVersion + ' (>= ' + MIN_NODE.major + '.' + MIN_NODE.minor + ')'
      : (input.nodeVersion || 'not found') + ' — need >= ' + MIN_NODE.major + '.' + MIN_NODE.minor,
  });
  checks.push({ name: 'git', ok: !!input.hasGit, hard: true, detail: input.hasGit ? 'present' : 'not found' });
  checks.push({ name: 'npm', ok: !!input.hasNpm, hard: true, detail: input.hasNpm ? 'present' : 'not found' });

  var chokidarBad = false;
  if (input.phase === 'post-clone') {
    var ck = input.chokidar || {};
    var ckOk = !!ck.resolved && /^3\.6\./.test(ck.version || '');
    chokidarBad = !ckOk;
    checks.push({
      name: 'chokidar', ok: ckOk, hard: true,
      detail: ckOk
        ? ck.version + ' (CommonJS pin)'
        : (ck.error || ('resolves to ' + (ck.version || '?') + ' — must be 3.6.x (4/5 are ESM-only → ERR_REQUIRE_ESM)')),
    });
  }

  var hardFail = checks.some(function (c) { return c.hard && !c.ok; });
  var guidance = null;
  if (!nodeOk) guidance = nodeUpgradeGuidance(input.platform, input.managers);
  else if (chokidarBad) guidance = 'Fix the chokidar pin:  npm install chokidar@^3.6.0 --ignore-scripts  (and remove any nested core/node_modules/chokidar).';
  else if (!input.hasGit || !input.hasNpm) guidance = 'Install the missing prerequisite(s) and re-run.';

  return {
    ok: !hardFail,
    platform: input.platform || null,
    arch: input.arch || null,
    nodeVersion: input.nodeVersion || null,
    checks: checks,
    guidance: guidance,
  };
}

module.exports = { MIN_NODE: MIN_NODE, parseNodeVersion: parseNodeVersion, nodeMeetsMinimum: nodeMeetsMinimum, nodeUpgradeGuidance: nodeUpgradeGuidance, evaluate: evaluate };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/__tests__/preflight.test.js`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/preflight.js scripts/__tests__/preflight.test.js
git commit -m "feat(preflight): pure environment-check logic + unit tests"
```

---

### Task 2: `scripts/preflight.js` — CLI + IO probes

**Files:**
- Modify: `scripts/preflight.js` (append probes + `main`; keep Task 1 exports)
- Test: `scripts/__tests__/preflight.test.js` (add a CLI spawn test)

**Interfaces:**
- Consumes: Task 1's `evaluate`, `nodeUpgradeGuidance`.
- Produces (consumed by Task 3 `lm-assist doctor`, Task 6/7 installers): the CLI contract `node scripts/preflight.js [--json] [--phase=pre-clone|post-clone] [--repo=<dir>]` → human report or JSON; **exit 0 iff `result.ok`**.

- [ ] **Step 1: Write the failing test**

Append to `scripts/__tests__/preflight.test.js`:

```js
const cp = require('node:child_process');
const path = require('node:path');

test('CLI --json pre-clone on this host exits 0 with ok:true and a checks array', () => {
  // This host runs Node >= 20.9 (the dev/test node), so pre-clone must pass.
  const out = cp.execFileSync(process.execPath, [path.join(__dirname, '..', 'preflight.js'), '--json', '--phase=pre-clone'], { encoding: 'utf8' });
  const j = JSON.parse(out);
  assert.strictEqual(j.ok, true);
  assert.ok(Array.isArray(j.checks));
  assert.ok(j.checks.find((c) => c.name === 'node').ok);
});

test('CLI human report prints a status line and exits 0 on a healthy host', () => {
  const out = cp.execFileSync(process.execPath, [path.join(__dirname, '..', 'preflight.js'), '--phase=pre-clone'], { encoding: 'utf8' });
  assert.match(out, /lm-assist preflight/);
  assert.match(out, /Preflight OK/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/__tests__/preflight.test.js`
Expected: FAIL — the CLI emits nothing / the spawn yields empty output (no `main` yet), so `JSON.parse('')` throws.

- [ ] **Step 3: Add the probes + `main` to `scripts/preflight.js`**

Insert BEFORE the `module.exports = ...` line:

```js
// ── IO probes (used only by the CLI) ──
var cp = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

function cmdPresent(cmd) {
  try {
    if (process.platform === 'win32') {
      cp.execSync('where ' + cmd, { stdio: 'ignore' });
    } else {
      cp.execSync('command -v ' + cmd, { stdio: 'ignore', shell: '/bin/sh' });
    }
    return true;
  } catch (e) { return false; }
}

function detectManagers() {
  var home = os.homedir();
  return {
    nvm: !!process.env.NVM_DIR || fs.existsSync(path.join(home, '.nvm', 'nvm.sh')),
    fnm: !!process.env.FNM_DIR || cmdPresent('fnm'),
    nvmWindows: process.platform === 'win32' && (!!process.env.NVM_HOME || cmdPresent('nvm')),
  };
}

function probeChokidar(repo) {
  try {
    var fromDist = path.join(repo, 'core', 'dist');
    var pkgPath = require.resolve('chokidar/package.json', { paths: [fromDist] });
    var pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    require.resolve('chokidar', { paths: [fromDist] }); // confirm the entry resolves too
    return { resolved: true, version: pkg.version };
  } catch (e) {
    return { resolved: false, error: 'chokidar did not resolve from core/dist: ' + (e && e.message) };
  }
}

function printReport(r) {
  var sym = function (c) { return c.ok ? '✓' : (c.hard ? '✗' : '•'); };
  var out = [];
  out.push('lm-assist preflight — ' + r.platform + '/' + r.arch + ', node ' + r.nodeVersion);
  for (var i = 0; i < r.checks.length; i++) {
    var c = r.checks[i];
    out.push('  ' + sym(c) + ' ' + c.name + ': ' + c.detail);
  }
  if (!r.ok && r.guidance) { out.push(''); out.push('Guidance:'); out.push('  ' + r.guidance); }
  out.push('');
  out.push(r.ok ? 'Preflight OK.' : 'Preflight FAILED — resolve the above and re-run.');
  process.stdout.write(out.join('\n') + '\n');
}

function main(argv) {
  var opts = { json: false, phase: 'pre-clone', repo: process.cwd() };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a.indexOf('--phase=') === 0) opts.phase = a.slice('--phase='.length);
    else if (a.indexOf('--repo=') === 0) opts.repo = a.slice('--repo='.length);
  }
  var result = evaluate({
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    hasGit: cmdPresent('git'),
    hasNpm: cmdPresent('npm'),
    managers: detectManagers(),
    phase: opts.phase,
    chokidar: opts.phase === 'post-clone' ? probeChokidar(opts.repo) : undefined,
  });
  if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else printReport(result);
  process.exit(result.ok ? 0 : 1);
}
```

Then change the last line from:

```js
module.exports = { MIN_NODE: MIN_NODE, parseNodeVersion: parseNodeVersion, nodeMeetsMinimum: nodeMeetsMinimum, nodeUpgradeGuidance: nodeUpgradeGuidance, evaluate: evaluate };
```

to (add the `require.main` guard after it):

```js
module.exports = { MIN_NODE: MIN_NODE, parseNodeVersion: parseNodeVersion, nodeMeetsMinimum: nodeMeetsMinimum, nodeUpgradeGuidance: nodeUpgradeGuidance, evaluate: evaluate };

if (require.main === module) main(process.argv.slice(2));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH && node --test scripts/__tests__/preflight.test.js`
Expected: PASS — all tests (pure + CLI spawn) green.

Also manually verify the failure path renders (does not affect the suite):
Run: `node scripts/preflight.js --phase=post-clone --repo="$(pwd)" --json | head -40`
Expected: JSON with a `chokidar` check (ok:true here, since this repo's chokidar is 3.6.0) and `ok:true`.

- [ ] **Step 5: Commit**

```bash
git add scripts/preflight.js scripts/__tests__/preflight.test.js
git commit -m "feat(preflight): CLI + IO probes (managers, chokidar, prereqs)"
```

---

### Task 3: `lm-assist doctor` subcommand

**Files:**
- Modify: `bin/lm-assist.js` (add `doctor` to `validCommands` at line 104, a help line, and a standalone dispatch block alongside `upgrade`)
- Test: `scripts/__tests__/doctor-cli.test.js`

**Interfaces:**
- Consumes: `scripts/preflight.js` CLI (Task 2); `projectRoot` (already computed at `bin/lm-assist.js:82`).
- Produces: `lm-assist doctor [--json]` → runs `node <projectRoot>/scripts/preflight.js --phase=post-clone --repo=<projectRoot>`, inheriting stdio and exit code.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/doctor-cli.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..'); // repo root
const BIN = path.join(REPO, 'bin', 'lm-assist.js');

test('`lm-assist doctor --json` runs the preflight and reports ok on this repo', () => {
  // projectRoot resolves to this repo (not node_modules) when run from source.
  const out = cp.execFileSync(process.execPath, [BIN, 'doctor', '--json'], { encoding: 'utf8' });
  const j = JSON.parse(out);
  assert.strictEqual(j.ok, true);
  assert.ok(j.checks.find((c) => c.name === 'chokidar'), 'post-clone phase includes chokidar');
});

test('`lm-assist doctor` is a recognized command (not "Unknown command")', () => {
  const out = cp.execFileSync(process.execPath, [BIN, 'doctor'], { encoding: 'utf8' });
  assert.match(out, /lm-assist preflight/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/__tests__/doctor-cli.test.js`
Expected: FAIL — `doctor` is not in `validCommands`, so the process prints "Unknown command: doctor" to stderr and exits 1; `execFileSync` throws.

- [ ] **Step 3: Implement the `doctor` command**

In `bin/lm-assist.js`, change line 104 from:

```js
const validCommands = ['start', 'stop', 'restart', 'status', 'logs', 'upgrade', 'version', 'storage', 'log', 'setup', 'login', 'logout', 'help'];
```

to:

```js
const validCommands = ['start', 'stop', 'restart', 'status', 'logs', 'upgrade', 'version', 'storage', 'log', 'setup', 'login', 'logout', 'doctor', 'help'];
```

Add a help line in the Commands block (after the `version` line, around line 119):

```js
  doctor             Check this host's environment (Node>=20.9, git/npm, chokidar pin)
```

Add a standalone dispatch block immediately AFTER the `upgrade` block (after line 188, before the `formatBytes` helper):

```js
// Handle doctor separately — just runs the preflight (no service-manager needed)
if (command === 'doctor') {
  const preflight = path.join(projectRoot, 'scripts', 'preflight.js');
  if (!fs.existsSync(preflight)) {
    console.error('Preflight script not found at:', preflight);
    console.error('(Run from a source checkout, or reinstall lm-assist.)');
    process.exit(1);
  }
  const { execFileSync } = require('child_process');
  try {
    execFileSync(process.execPath, [preflight, '--phase=post-clone', `--repo=${projectRoot}`, ...args], {
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    });
  } catch (err) {
    process.exit(err.status || 1);
  }
  process.exit(0);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH && node --test scripts/__tests__/doctor-cli.test.js`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add bin/lm-assist.js scripts/__tests__/doctor-cli.test.js
git commit -m "feat(cli): lm-assist doctor — run the preflight on demand"
```

---

### Task 4: `engines` reconciliation to `>=20.9.0`

**Files:**
- Modify: `package.json:49-51`, `core/package.json:48-50`, `web/package.json` (add `engines`)
- Test: `scripts/__tests__/engines.test.js`

**Interfaces:** none consumed/produced (config honesty).

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/engines.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
function eng(rel) {
  const p = JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
  return p.engines && p.engines.node;
}

test('all package.json engines declare node >=20.9.0', () => {
  assert.strictEqual(eng('package.json'), '>=20.9.0');
  assert.strictEqual(eng('core/package.json'), '>=20.9.0');
  assert.strictEqual(eng('web/package.json'), '>=20.9.0');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/__tests__/engines.test.js`
Expected: FAIL — root/core say `>=18.0.0`, web has no `engines`.

- [ ] **Step 3: Edit the three package.json files**

Root `package.json` lines 49-51 — change `">=18.0.0"` to `">=20.9.0"`:

```json
  "engines": {
    "node": ">=20.9.0"
  },
```

`core/package.json` lines 48-50 — same change:

```json
  "engines": {
    "node": ">=20.9.0"
  },
```

`web/package.json` — add an `engines` block after the `"private": true,` line (line 4):

```json
  "private": true,
  "engines": {
    "node": ">=20.9.0"
  },
```

(Do NOT add `.npmrc` `engine-strict=true` — enforcement stays with the preflight; `engines` is documentation.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/__tests__/engines.test.js`
Expected: PASS.

Also confirm `web/package.json` is still valid JSON:
Run: `node -e "JSON.parse(require('fs').readFileSync('web/package.json','utf8')); console.log('web pkg ok')"`
Expected: `web pkg ok`.

- [ ] **Step 5: Commit**

```bash
git add package.json core/package.json web/package.json scripts/__tests__/engines.test.js
git commit -m "chore(engines): require node >=20.9.0 across workspace (matches Next 16)"
```

---

### Task 5: OS-aware `guide("install")` + `buildBootstrapInstruction`

**Files:**
- Modify: `core/src/mcp-server/tools/guide.ts` (the `install` topic string, ~line 113)
- Modify: `core/src/terminal/ccr-cloud.ts` (`buildBootstrapInstruction`, ~line 128)
- Test: `core/src/__tests__/bootstrap-os-aware.test.ts`

**Interfaces:**
- Consumes: `GUIDE_HANDLERS` (exported, `guide.ts:366`), `buildBootstrapInstruction` (exported, `ccr-cloud.ts:104`).
- Produces: install guidance text that names both `install.sh` and `install.ps1`, `lm-assist doctor`, and the Windows command map.

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/bootstrap-os-aware.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { GUIDE_HANDLERS } from '../mcp-server/tools/guide';
import { buildBootstrapInstruction } from '../terminal/ccr-cloud';

test('guide("install") names both OS installers + doctor', async () => {
  const res = await GUIDE_HANDLERS.guide({ topic: 'install' });
  const text = JSON.stringify(res);
  assert.ok(text.includes('install.sh'), 'mentions install.sh');
  assert.ok(text.includes('install.ps1'), 'mentions install.ps1');
  assert.ok(text.includes('lm-assist doctor'), 'mentions doctor');
});

test('buildBootstrapInstruction includes a Windows install alternative', () => {
  const s = buildBootstrapInstruction({});
  assert.ok(/install\.ps1/.test(s), 'mentions the Windows installer');
});
```

- [ ] **Step 2: Build the test + run to verify it fails**

Run: `cd core && export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH && npm run build:test && node --test dist-test/__tests__/bootstrap-os-aware.test.js`
Expected: FAIL — neither string is present yet.

- [ ] **Step 3a: Make the `install` guide OS-aware**

In `core/src/mcp-server/tools/guide.ts`, find the SOURCE line of the `install` topic (it starts `SOURCE: github.com/langmartai/lm-assist — an npm-WORKSPACE monorepo`). Immediately AFTER that line (after the `…resolves from core/dist).` and before the blank line preceding `DEV (repo ports …`), insert this block (inside the same template literal):

```
ONE-COMMAND (recommended) — runs a PREFLIGHT first (Node>=20.9, git/npm, chokidar pin), then a prod install (CLI + services on :3100/:3848); add --dev for the repo dev ports :3200/:3948:
  • Linux/macOS:  curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash
  • Windows:      irm https://raw.githubusercontent.com/langmartai/lm-assist/main/install.ps1 | iex
DIAGNOSE anytime:  lm-assist doctor  (runs the same preflight; --json for machine output).
WINDOWS command map (no bash / no core.sh): use lm-assist start|status|stop (NOT ./core.sh) and PowerShell irm|iex (NOT curl|bash). Too-old Node → the preflight prints the nvm-windows command (nvm install 20.19.6 ; nvm use 20.19.6).
```

(The existing DEV/PROD manual steps below remain — they are the from-scratch detail the one-command path automates.)

- [ ] **Step 3b: Add the Windows branch to the cloud self-heal instruction**

In `core/src/terminal/ccr-cloud.ts`, find the `lines.push(` that begins `'', \`This gives you LOCAL lm-assist on :${apiPort}` (line ~129). Immediately BEFORE that `lines.push(`, insert:

```ts
  lines.push(
    '       (WINDOWS host? install via PowerShell instead of bash — irm https://raw.githubusercontent.com/langmartai/lm-assist/main/install.ps1 | iex — then use `lm-assist start` / `lm-assist status` (NOT ./core.sh / curl). `lm-assist doctor` checks Node>=20.9 + the chokidar pin.)',
  );
```

- [ ] **Step 4: Build the test + run to verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/bootstrap-os-aware.test.js`
Expected: PASS — both tests green.

- [ ] **Step 5: Build core + commit**

```bash
cd core && npm run build && cd ..
git add core/src/mcp-server/tools/guide.ts core/src/terminal/ccr-cloud.ts core/src/__tests__/bootstrap-os-aware.test.ts
git commit -m "feat(guide): OS-aware install guidance + Windows cloud self-heal path"
```

---

### Task 6: `install.sh` corrections + Linux e2e

**Files:**
- Modify (rewrite): `install.sh`
- Verify: isolated Linux e2e run (no fleet impact)

**Interfaces:**
- Consumes: `scripts/preflight.js` (Tasks 1-2), `lm-assist` CLI (prod global install), `./core.sh start` (dev mode).
- Produces: a one-command Linux installer with `--dev`/`--prod` (default prod) that gates on the preflight.

- [ ] **Step 1: Rewrite `install.sh`**

Replace the ENTIRE contents of `install.sh` with:

```bash
#!/bin/bash
# install.sh — One-command installer for lm-assist (Linux/macOS)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash -s -- --dev
#
# What it does:
#   1. Bare prereq gate (git/node/npm/claude present; node major >= 20)
#   2. Installs the lm-assist plugin (skills, commands, MCP, hooks)
#   3. Clones the repo, runs the authoritative PREFLIGHT (Node>=20.9, chokidar pin)
#   4. prod (default): npm pack -> npm install -g ./tgz (CLI + services :3100/:3848)
#      --dev:          npm install --ignore-scripts -> build -> ./core.sh start (:3200/:3948)
#
# Requirements: git, node >= 20.9, npm, claude (Claude Code CLI)

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}[lm-assist]${NC} $*"; }
ok()    { echo -e "${GREEN}[lm-assist]${NC} $*"; }
warn()  { echo -e "${YELLOW}[lm-assist]${NC} $*"; }
fail()  { echo -e "${RED}[lm-assist]${NC} $*"; exit 1; }

INSTALL_DIR="${LM_ASSIST_DIR:-$HOME/lm-assist}"

MODE="prod"
for arg in "$@"; do
  case "$arg" in
    --dev)  MODE="dev" ;;
    --prod) MODE="prod" ;;
    *) warn "Ignoring unknown argument: $arg" ;;
  esac
done

# ─── Prerequisites (bare gate; the post-clone preflight is authoritative) ───
info "Checking prerequisites..."
command -v git    >/dev/null 2>&1 || fail "git is required but not installed"
command -v node   >/dev/null 2>&1 || fail "node is required (>= 20.9). Install from https://nodejs.org or via nvm: nvm install 20 && nvm use 20"
command -v npm    >/dev/null 2>&1 || fail "npm is required but not installed"
command -v claude >/dev/null 2>&1 || fail "claude (Claude Code CLI) is required: https://docs.anthropic.com/en/docs/claude-code"

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js >= 20.9 is required (found $(node -v)). Upgrade Node (e.g. nvm install 20 && nvm use 20) and re-run."
fi
ok "Prereqs present (node $(node -v), claude $(claude --version 2>/dev/null | head -1 || echo installed)) — mode: $MODE"

# ─── Step 1: Plugin ───
info "Adding langmartai marketplace + installing plugin..."
claude plugin marketplace add langmartai/lm-assist 2>/dev/null || warn "Marketplace may already be added"
claude plugin install lm-assist@langmartai 2>&1 || warn "Plugin install returned non-zero (may already be installed)"

# ─── Step 2: Clone / pull ───
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing checkout at $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || warn "Could not fast-forward (local changes?) — continuing"
else
  info "Cloning lm-assist to $INSTALL_DIR..."
  git clone https://github.com/langmartai/lm-assist.git "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ─── Step 3: Install deps (--ignore-scripts: onnxruntime postinstall would die) + PREFLIGHT ───
info "Installing dependencies (this can take a minute)..."
npm install --ignore-scripts --no-audit --no-fund 2>&1 | tail -1

info "Running preflight (authoritative environment check)..."
if ! node scripts/preflight.js --phase=post-clone --repo="$INSTALL_DIR"; then
  fail "Preflight failed — resolve the issues above and re-run."
fi

# ─── Step 4: Build + start by mode ───
if [ "$MODE" = "dev" ]; then
  info "Building (dev)..."
  npm run build 2>&1 | tail -3
  ok "Build complete (dev). Start with: cd $INSTALL_DIR && ./core.sh start   (API :3200, Web :3948)"
else
  info "Packing + installing globally (prod)..."
  npm pack 2>&1 | tail -1
  TGZ=$(ls -t lm-assist-*.tgz | head -1)
  [ -n "$TGZ" ] || fail "npm pack did not produce a tgz"
  info "Installing $TGZ globally (compiles better-sqlite3; postinstall auto-starts services)..."
  npm install -g "./$TGZ" 2>&1 | tail -3
  ok "Installed lm-assist CLI (prod). Services start on :3100 (API) / :3848 (Web)."
fi

# ─── .env ───
if [ ! -f "$INSTALL_DIR/.env" ] && [ -f "$INSTALL_DIR/.env.example" ]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  warn "Created .env from .env.example — edit to add ANTHROPIC_API_KEY"
fi

echo ""
echo -e "${GREEN}lm-assist installed (${MODE}).${NC}"
echo "  Source: $INSTALL_DIR"
echo "  Next:"
if [ "$MODE" = "dev" ]; then
  echo "    1. cd $INSTALL_DIR && ./core.sh start"
  echo "    2. ./core.sh status      # API :3200 / Web :3948"
else
  echo "    1. lm-assist status      # API :3100 / Web :3848 (auto-started)"
  echo "    2. lm-assist doctor      # re-check the environment anytime"
fi
echo "    3. Open a NEW Claude Code session (activates MCP/hooks), then run /assist-setup"
echo "    (Connecting to a hub is a separate, optional step: lm-assist setup --key <KEY>)"
```

- [ ] **Step 2: Syntax-check the script**

Run: `bash -n install.sh && echo "syntax ok"`
Expected: `syntax ok`. (If `shellcheck` is available: `shellcheck install.sh` — warnings acceptable, no errors.)

- [ ] **Step 3: Linux e2e — too-old-Node guidance (isolated, no clone)**

Create a throwaway PATH shim that makes `node -v` report v18, and confirm the bare gate fails fast:

```bash
SHIM=$(mktemp -d)
cat > "$SHIM/node" <<'EOF'
#!/bin/bash
if [ "$1" = "-v" ]; then echo "v18.20.4"; else exec /usr/bin/env -i true; fi
EOF
chmod +x "$SHIM/node"
# Put the shim first; keep git/npm/claude from the real PATH.
PATH="$SHIM:$PATH" bash install.sh; echo "exit=$?"
rm -rf "$SHIM"
```

Expected: prints `Node.js >= 20.9 is required (found v18.20.4)...` and `exit=1` — **before any clone**.

- [ ] **Step 4: Linux e2e — full `--dev` install (isolated; free ports 3200/3948)**

This exercises clone → preflight → `--ignore-scripts` install → build → `./core.sh start` WITHOUT touching the prod fleet node (dev ports are free; data dir isolated):

```bash
export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH
TESTROOT=$(mktemp -d)
export LM_ASSIST_DIR="$TESTROOT/clone"
export LM_ASSIST_DATA_DIR="$TESTROOT/data"
# Use the LOCAL feature-branch checkout as the clone source (so we test THIS install.sh + preflight):
git clone -b feat/guided-cross-platform-bootstrap /home/ubuntu/lm-assist "$LM_ASSIST_DIR"
# Run the in-repo install.sh's Step 3+4 dev path directly against the clone:
cd "$LM_ASSIST_DIR"
npm install --ignore-scripts --no-audit --no-fund 2>&1 | tail -1
node scripts/preflight.js --phase=post-clone --repo="$LM_ASSIST_DIR"; echo "preflight exit=$?"
npm run build 2>&1 | tail -3
./core.sh start 2>&1 | tail -8 || true
sleep 3
curl -s localhost:3200/health | grep -o '"runningFrom":"[^"]*"' || echo "no health"
curl -s -o /dev/null -w 'web :3948 http=%{http_code}\n' localhost:3948 || true
./core.sh stop 2>&1 | tail -3 || true
cd /home/ubuntu/lm-assist
rm -rf "$TESTROOT"
unset LM_ASSIST_DIR LM_ASSIST_DATA_DIR
```

Expected: `preflight exit=0`; build completes; `"runningFrom":"dev-repo"`; `web :3948 http=307`. (The 307 is healthy — `/` redirects to `/sessions`.) Then dev services stop. **Prod :3100/:3848 untouched** — verify: `curl -s localhost:3100/health | grep -o '"status":"[^"]*"'` still `healthy`.

- [ ] **Step 5: Linux e2e — prod install MECHANICS in an isolated npm prefix (no :3100 bind)**

Confirm the prod pack+global-install path produces a working CLI without clobbering the live prod global or binding :3100:

```bash
export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH
TESTROOT=$(mktemp -d)
git clone -b feat/guided-cross-platform-bootstrap /home/ubuntu/lm-assist "$TESTROOT/clone"
cd "$TESTROOT/clone"
npm install --ignore-scripts --no-audit --no-fund 2>&1 | tail -1
npm pack 2>&1 | tail -1
TGZ=$(ls -t lm-assist-*.tgz | head -1); echo "tgz=$TGZ"
export npm_config_prefix="$TESTROOT/prefix"     # global install lands HERE, not the system
npm install -g "./$TGZ" --ignore-scripts 2>&1 | tail -3   # --ignore-scripts here to skip postinstall auto-start (would bind :3100)
"$TESTROOT/prefix/bin/lm-assist" doctor --json | head -20
"$TESTROOT/prefix/bin/lm-assist" version 2>&1 | head -3 || true
cd /home/ubuntu/lm-assist
rm -rf "$TESTROOT"; unset npm_config_prefix
```

Expected: `tgz=lm-assist-<ver>.tgz`; the isolated `lm-assist doctor --json` prints `"ok": true`; the CLI runs. (Note: this asserts the install MECHANICS; the prod service bind on :3100 is already proven by the live fleet, so we deliberately skip the auto-start with `--ignore-scripts` to avoid an EADDRINUSE clash with prod.)

- [ ] **Step 6: Commit**

```bash
git add install.sh
git commit -m "fix(install.sh): preflight gate, --ignore-scripts, prod/--dev modes (node>=20.9)"
```

---

### Task 7: `install.ps1` (Windows) + Windows e2e

**Files:**
- Create: `install.ps1`
- Verify: Windows e2e on the `claude-code-windows-setup` host (or isolated on 107)

**Interfaces:**
- Consumes: `scripts/preflight.js`, the `lm-assist` CLI / `npm`.
- Produces: a PowerShell one-command installer mirroring `install.sh` (default prod, `-Dev` switch).

- [ ] **Step 1: Create `install.ps1`**

Create `install.ps1`:

```powershell
# install.ps1 — One-command installer for lm-assist (Windows)
#
# Usage:
#   irm https://raw.githubusercontent.com/langmartai/lm-assist/main/install.ps1 | iex
#   # dev mode:  $env:LM_ASSIST_MODE='dev'; irm https://.../install.ps1 | iex
#   # (as a file)  powershell -ExecutionPolicy Bypass -File install.ps1 -Dev
#
# Mirrors install.sh: bare gate -> plugin -> clone -> PREFLIGHT -> build -> start.
# prod (default): npm pack -> npm install -g .\tgz (CLI + services :3100/:3848).
# -Dev:           npm install --ignore-scripts -> build -> node bin\lm-assist.js (dev :3200/:3948).

param([switch]$Dev)
$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "[lm-assist] $m" -ForegroundColor Blue }
function Ok($m)   { Write-Host "[lm-assist] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[lm-assist] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[lm-assist] $m" -ForegroundColor Red; exit 1 }

$Mode = if ($Dev -or $env:LM_ASSIST_MODE -eq 'dev') { 'dev' } else { 'prod' }
$InstallDir = if ($env:LM_ASSIST_DIR) { $env:LM_ASSIST_DIR } else { Join-Path $env:USERPROFILE 'lm-assist' }

# ─── Prerequisites (bare gate) ───
Info 'Checking prerequisites...'
foreach ($c in @('git','node','npm','claude')) {
  if (-not (Get-Command $c -ErrorAction SilentlyContinue)) {
    if ($c -eq 'node') { Fail 'node is required (>= 20.9). Install from https://nodejs.org or nvm-windows: nvm install 20.19.6 ; nvm use 20.19.6' }
    elseif ($c -eq 'claude') { Fail 'claude (Claude Code CLI) is required: https://docs.anthropic.com/en/docs/claude-code' }
    else { Fail "$c is required but not installed" }
  }
}
$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { Fail "Node.js >= 20.9 is required (found $(node -v)). Upgrade (nvm install 20.19.6 ; nvm use 20.19.6) and re-run." }
Ok "Prereqs present (node $(node -v)) — mode: $Mode"

# ─── Step 1: Plugin ───
Info 'Adding marketplace + installing plugin...'
try { claude plugin marketplace add langmartai/lm-assist 2>$null } catch { Warn 'Marketplace may already be added' }
try { claude plugin install lm-assist@langmartai } catch { Warn 'Plugin install returned non-zero (may already be installed)' }

# ─── Step 2: Clone / pull ───
if (Test-Path (Join-Path $InstallDir '.git')) {
  Info "Updating existing checkout at $InstallDir..."
  git -C $InstallDir pull --ff-only 2>$null
} else {
  Info "Cloning lm-assist to $InstallDir..."
  git clone https://github.com/langmartai/lm-assist.git $InstallDir
}
Set-Location $InstallDir

# ─── Step 3: Install deps (--ignore-scripts) + PREFLIGHT ───
Info 'Installing dependencies (this can take a minute)...'
npm install --ignore-scripts --no-audit --no-fund | Select-Object -Last 1
Info 'Running preflight (authoritative environment check)...'
node scripts\preflight.js --phase=post-clone --repo="$InstallDir"
if ($LASTEXITCODE -ne 0) { Fail 'Preflight failed — resolve the issues above and re-run.' }

# ─── Step 4: Build + start by mode ───
if ($Mode -eq 'dev') {
  Info 'Building (dev)...'
  npm run build | Select-Object -Last 3
  Ok "Build complete (dev). Start with: node bin\lm-assist.js start   (dev API :3200 / Web :3948)"
} else {
  Info 'Packing + installing globally (prod)...'
  npm pack | Select-Object -Last 1
  $tgz = Get-ChildItem -Filter 'lm-assist-*.tgz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $tgz) { Fail 'npm pack did not produce a tgz' }
  Info "Installing $($tgz.Name) globally (compiles better-sqlite3; postinstall auto-starts services)..."
  npm install -g ".\$($tgz.Name)" | Select-Object -Last 3
  Ok 'Installed lm-assist CLI (prod). Services start on :3100 (API) / :3848 (Web).'
}

# ─── .env ───
if (-not (Test-Path (Join-Path $InstallDir '.env')) -and (Test-Path (Join-Path $InstallDir '.env.example'))) {
  Copy-Item (Join-Path $InstallDir '.env.example') (Join-Path $InstallDir '.env')
  Warn 'Created .env from .env.example — edit to add ANTHROPIC_API_KEY'
}

Write-Host ''
Ok "lm-assist installed ($Mode). Source: $InstallDir"
if ($Mode -eq 'dev') {
  Write-Host '  Next: node bin\lm-assist.js start   (dev API :3200 / Web :3948)'
} else {
  Write-Host '  Next: lm-assist status   (API :3100 / Web :3848, auto-started); lm-assist doctor to re-check.'
}
Write-Host '  Then open a NEW Claude Code session (activates MCP/hooks) and run /assist-setup.'
Write-Host '  (Connecting to a hub is a separate, optional step: lm-assist setup --key <KEY>)'
```

- [ ] **Step 2: Determine the Windows e2e target (no fleet disruption)**

Confirm whether `claude-code-windows-setup` is a **dedicated fresh box** (real prod install OK) or whether to use 107 in **isolated** mode. Check what's reachable:

```bash
# Is there a distinct windows-setup host? Ask/confirm; otherwise use 107 isolated.
ssh -i ~/.ssh/langmart_admin_key -o StrictHostKeyChecking=no admin@192.0.2.7 'powershell -NoProfile -Command "hostname; node -v"' 2>&1
```
Expected: prints `windows-node` + a node version. **If using 107, you MUST isolate** (next step) — a real `npm install -g` there overwrites the live prod fleet CLI.

- [ ] **Step 2b: Commit `install.ps1` (so the artifact under test is the committed one)**

```bash
git add install.ps1
git commit -m "feat(install.ps1): Windows one-command installer (preflight + prod/-Dev)"
```

- [ ] **Step 3: Stage the working tree onto the Windows host (tarball, not a GitHub clone — the branch isn't pushed)**

```bash
cd /home/ubuntu/lm-assist
tar czf /tmp/lmtest-src.tgz --exclude=node_modules --exclude=.git --exclude='web/.next' \
  --exclude='core/dist' --exclude='core/dist-test' -C /home/ubuntu/lm-assist .
scp -i ~/.ssh/langmart_admin_key -o StrictHostKeyChecking=no /tmp/lmtest-src.tgz admin@192.0.2.7:'C:/Users/admin/lmtest-src.tgz'
```
Expected: scp exit 0. (On a dedicated fresh box, use its own key/path. `git archive` is unsuitable here because it omits the just-written, possibly-uncommitted files; the working-tree tarball captures exactly what's under test.)

- [ ] **Step 4: Windows e2e — extract + preflight (proves preflight.js + the chokidar check on win32)**

Stage a helper script (avoids SSH→PowerShell quoting pitfalls — the same pattern used for fleet web deploys):

```bash
cat > /tmp/lmtest-win-preflight.ps1 <<'PS1'
$ErrorActionPreference = 'Stop'
$d = Join-Path $env:TEMP 'lmtest'
if (Test-Path $d) { Remove-Item -Recurse -Force $d }
New-Item -ItemType Directory -Path $d | Out-Null
tar -xzf "$env:USERPROFILE\lmtest-src.tgz" -C $d
Set-Location $d
npm install --ignore-scripts --no-audit --no-fund | Select-Object -Last 1
node scripts\preflight.js --phase=post-clone --repo=$d --json | Out-Host
Write-Output ("preflight exit=" + $LASTEXITCODE)
# Prove install.ps1 PARSES (AST) without running it:
$errs = $null; [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $d 'install.ps1'), [ref]$null, [ref]$errs) | Out-Null
Write-Output ("install.ps1 parse errors: " + (@($errs).Count))
PS1
scp -i ~/.ssh/langmart_admin_key -o StrictHostKeyChecking=no /tmp/lmtest-win-preflight.ps1 admin@192.0.2.7:'C:/Users/admin/lmtest-win-preflight.ps1'
ssh -i ~/.ssh/langmart_admin_key -o StrictHostKeyChecking=no admin@192.0.2.7 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\admin\lmtest-win-preflight.ps1' 2>&1
```
Expected: the preflight JSON shows `"ok": true` with a `chokidar` check at `3.6.x`; `preflight exit=0`; `install.ps1 parse errors: 0`.

- [ ] **Step 5: Windows e2e — install.ps1 install path (isolated on 107, OR full prod on a dedicated fresh box)**

**Decision:** if `claude-code-windows-setup` is a **dedicated fresh box**, run the full prod installer there and verify live services. On the **107 fleet node**, you MUST isolate (a real `npm install -g` / service start would clobber/restart the live prod node), so validate the install *mechanics* only — no global install, no :3100 bind.

Isolated 107 path (stage + run a helper):

```bash
cat > /tmp/lmtest-win-install.ps1 <<'PS1'
$ErrorActionPreference = 'Stop'
$d = Join-Path $env:TEMP 'lmtest'
Set-Location $d
# Mechanics only: build the tgz, install it into an ISOLATED global prefix, run doctor. No service start.
npm pack | Select-Object -Last 1
$tgz = Get-ChildItem -Filter 'lm-assist-*.tgz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Output ("tgz=" + $tgz.Name)
$prefix = Join-Path $env:TEMP 'lmtest-prefix'
if (Test-Path $prefix) { Remove-Item -Recurse -Force $prefix }
$env:npm_config_prefix = $prefix
npm install -g ".\$($tgz.Name)" --ignore-scripts | Select-Object -Last 3   # --ignore-scripts skips postinstall auto-start (would bind :3100)
& (Join-Path $prefix 'lm-assist.cmd') doctor --json | Select-String '"ok"'
Write-Output ("doctor exit=" + $LASTEXITCODE)
PS1
scp -i ~/.ssh/langmart_admin_key -o StrictHostKeyChecking=no /tmp/lmtest-win-install.ps1 admin@192.0.2.7:'C:/Users/admin/lmtest-win-install.ps1'
ssh -i ~/.ssh/langmart_admin_key -o StrictHostKeyChecking=no admin@192.0.2.7 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\admin\lmtest-win-install.ps1' 2>&1
# Cleanup staging on 107:
ssh -i ~/.ssh/langmart_admin_key -o StrictHostKeyChecking=no admin@192.0.2.7 'powershell -NoProfile -Command "Remove-Item -Recurse -Force $env:TEMP\lmtest,$env:TEMP\lmtest-prefix,$env:USERPROFILE\lmtest-src.tgz,$env:USERPROFILE\lmtest-win-preflight.ps1,$env:USERPROFILE\lmtest-win-install.ps1 -ErrorAction SilentlyContinue; Write-Output cleaned"' 2>&1
```
Expected: `tgz=lm-assist-<ver>.tgz`; the isolated `doctor` prints `"ok": true`; `doctor exit=0`; `cleaned`. **107 prod stays healthy** — verify after: `curl -s http://192.0.2.7:3100/health | grep -o '"status":"[^"]*"'` → `healthy`, uptime unchanged.

(Dedicated-box path: copy `install.ps1` over, run `powershell -ExecutionPolicy Bypass -File install.ps1`, then `lm-assist status` → API :3100 / Web :3848 up; `lm-assist doctor` → ok.)

- [ ] **Step 6: Final commit for the task (install.ps1 already committed in 2b; commit any e2e helper if kept)**

No code change beyond 2b. If you added a committed e2e helper, commit it; otherwise this task is complete.

---

### Task 8: Full suite, docs sync, final commit

**Files:**
- Modify: `CLAUDE.md` (Bootstrapping section — document the installers + `doctor` + Node 20.9 floor)
- Verify: full core test suite (0 regressions) + the new `scripts/__tests__` suite

**Interfaces:** none new.

- [ ] **Step 1: Run the new script test suite**

Run: `export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH && node --test scripts/__tests__/`
Expected: all of `preflight.test.js`, `doctor-cli.test.js`, `engines.test.js` PASS.

- [ ] **Step 2: Run the full core suite — confirm 0 regressions**

Run: `cd core && export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH && npm run build:test && node --test dist-test/__tests__/ 2>&1 | tail -25`
Expected: the new `bootstrap-os-aware.test.js` passes; the pre-existing environmental failures (better-sqlite3 `ERR_DLOPEN_FAILED`, `fetch failed`, OAuth, session-resolver timeout) are unchanged in count — **no NEW failures** attributable to this work.

- [ ] **Step 3: Document the bootstrap in CLAUDE.md**

In `/home/ubuntu/lm-assist/CLAUDE.md`, in the "Bootstrapping from the repo on a fresh host" section, add a short subsection near the top:

```markdown
**One-command (recommended), per OS** — both run `scripts/preflight.js` first (Node>=20.9, git/npm, chokidar pin) then a prod install (CLI + services :3100/:3848); add `--dev`/`-Dev` for the dev ports (3200/3948):
- Linux/macOS: `curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash`
- Windows: `irm https://raw.githubusercontent.com/langmartai/lm-assist/main/install.ps1 | iex`
- Diagnose anytime: `lm-assist doctor` (runs the same preflight; `--json` for machine output).
- Node policy is **guidance-only**: too-old Node prints the nvm / nvm-windows / fnm upgrade command and stops — it never changes your Node.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): document the guided one-command bootstrap + lm-assist doctor"
```

- [ ] **Step 5: Activation note (NOT executed by this plan)**

The `irm … | iex` / `curl … | bash` one-liners fetch from `…/main/…`, and the bumped `engines` only ship once merged. **Merging to `main`, version bump, and `npm publish` are a separate, user-gated step** (this plan stops at a green feature branch). When the user approves: bump version in the three files (`package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`), merge, push, publish.

---

## Self-Review

Run after the plan is written (checklist, not a subagent dispatch):

**1. Spec coverage** — every spec section maps to a task:
- §4.1 preflight.js → Tasks 1–2. §4.2 install modes → Tasks 6–7. §4.3 install.sh → Task 6. §4.4 install.ps1 → Task 7. §4.5 doctor → Task 3. §4.6 engines → Task 4. §4.7 guide+bootstrap → Task 5. §7 testing → Tasks 1–3 (unit), 6 (Linux e2e), 7 (Windows e2e), 8 (full suite). ✓ No gaps.

**2. Placeholder scan** — every code step shows complete code; every run step has an exact command + expected output; the only deferrals are byte-exact remote commands settled at execution (the e2e steps give runnable commands). ✓

**3. Type/name consistency** — `MIN_NODE`, `parseNodeVersion`, `nodeMeetsMinimum`, `nodeUpgradeGuidance`, `evaluate` are defined in Task 1 and reused verbatim in Tasks 2/3/5 tests; the CLI flags (`--json`, `--phase=`, `--repo=`) match between Task 2 (impl), Task 3 (doctor dispatch), and Tasks 6/7 (installers). `GUIDE_HANDLERS` / `buildBootstrapInstruction` match their real exports. ✓

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-24-guided-cross-platform-bootstrap.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — I execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**