# Rule Auto-Sync + per-OS scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development — dispatch each task below to a fresh subagent in order, TDD (failing test first), review between tasks. Do not batch tasks.

**Goal:** USER rules (`~/.claude/rules/*.md`) auto-converge across the fleet — a faithful per-host-mirror parallel of memory's cross-node sync (pull-based reconcile, ON by default) — with a new `os:` frontmatter dimension so a platform-specific rule replicates to every node but only *activates* on a matching platform. Because rule injection is NATIVE Claude Code (lm-assist cannot filter at injection time), OS-applicability is decided at **placement time** on ingest: a synced rule that applies to the receiving node's `os.platform()` lands ACTIVE at `~/.claude/rules/synced.<sourceHost>.<name>.md`; a wrong-OS rule lands INERT at `~/.lm-assist/rules-mirror/<sourceHost>/<name>.md` (map-indexed only). Plus a full memory-parallel READ-only MCP surface.

**Architecture:** Source of truth = `docs/superpowers/specs/2026-06-30-rule-auto-sync-and-os-scoping-design.md`. We mirror memory module-for-module: `rules/autosync.ts` ← `memory/autosync.ts`; `rules/rule-sync.ts` ← `memory/ingest.ts`+export; `routes/core/rule-sync.routes.ts` ← `memory-sync.routes.ts`; reuse `memory/{mcp-transport,node-mode,sync-select}.ts`. Host-namespacing (`synced.<host>.*`) means two peers never write the same file, so memory's convergent-merge stack (`merge3`/`llm-merge`/`merge-ingest`) is intentionally omitted. Sync is PULL-only (the `dataset_updated` push path is dead): the daemon pulls every ONLINE FLEET node's `/rules/export` and applies locally through the OS router; removal is tombstone-free set-diff (export returns the full current own-rule set; ingest deletes synced/mirror files not in it).

**Tech Stack:** TypeScript (CommonJS build, `./core.sh build` → `core/dist`), Node.js raw HTTP routes, chokidar v3 file watcher, `node:test` test runner (`cd core && npm test`), MCP StreamableHTTP + stdio (shared `configure.ts`/`expanded.ts`). Cross-node transport rides the hub `/machines/<id>/proxy` (key-in-body, since the proxy drops `x-lm-access-key`).

## Global Constraints

- chokidar MUST be the v3 API (`import chokidar` + `chokidar.watch`); core builds CommonJS — never an ESM-only import.
- MCP number/bool tool args arrive as STRINGS over the connector — any numeric tool param must coerce (see `numArg` in `core/src/mcp-server/tools/data-tools-format.ts`).
- Every new MCP tool needs a `TOOL_SCOPES` entry (missing → Core crash via `assertScopesCoverTools`) AND wires in exactly 3 places (`EXPANDED_TOOL_DEFS` + `EXPANDED_HANDLERS` + `TOOL_SCOPES`); no explicit `case` in `mcp-server/index.ts` or `mcp.routes.ts`.
- Synced rule files are written BYTE-IDENTICAL to origin (no provenance banner — it would break contentHash dedup); provenance is the `synced.<host>.` filename + the map `source` field.
- Ingest writes are path-confined to `~/.claude/rules/synced.<host>.*` and `~/.lm-assist/rules-mirror/<host>/` ONLY; never overwrite a hand-authored (non-`synced.`) local rule.
- Sync is pull-based (the `dataset_updated`/push path is dead) and fleet-wide (use the UNFILTERED online-node list, not the cluster-filtered one).
- Core builds with `./core.sh build`; tests run `cd core && npm test` (node:test). Use the repo's existing test style.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `core/src/rules/rule-extract.ts` | **Modify** | Add `parseOs` + `normalizeOsList` (mirror `parsePaths`); `extractRule` gains `os`/`osDependent`/`active` (+ optional `platform` input on `ExtractInput`). |
| `core/src/rules/rule-sync.ts` | **Create** | Pure-ish write side: `readOwnRules`, `selfHostId`, `sanitizeBasename`, `sanitizeHost`, `routePlacement`, `applyIngest` (path-confined writes + set-diff removal + 64 KB cap), `ensureMirrorReadme`. |
| `core/src/rules/autosync.ts` | **Create** | Pull-based reconcile daemon (mirror `memory/autosync.ts`): own chokidar v3 watch of `~/.claude/rules/*.md` (excl `synced.*`) + timer + on-demand; gated on `ruleSyncEnabled`; fleet-wide. |
| `core/src/routes/core/rule-sync.routes.ts` | **Create** | `POST /rules/export`, `POST /rules/ingest`, `GET /rules/sync/status`, `GET /rules/autosync/status` (memory-sync auth: key-in-body for relayed calls). |
| `core/src/memory/mcp-transport.ts` | **Modify (reuse+extend)** | Add `rulesExportBody` + `pullRulesExport(node, key)` next to `pullFromHome`/`pushToHome`; reuse existing private `relayPost` + exported `listFleetNodes`. |
| `core/scripts/rule-map.js` | **Modify** | Scan `~/.lm-assist/rules-mirror/**` (active:false, source `repo:<host>`); detect `synced.<host>.*` in the live dir (node/source rewrite); emit `os`/`osDependent`/`active`; add `--os`/`--os-dependent`/`--active`. |
| `core/src/project-settings.ts` | **Modify** | Add `ruleSyncEnabled: boolean` (default **true**) to interface/DEFAULTS/get/save. |
| `core/src/routes/core/project-settings.routes.ts` | **Modify** | Pass `ruleSyncEnabled` through PUT + live-apply `getRuleAutoSyncDaemon().refreshMode()`. |
| `core/src/hub-client/api-relay-handler.ts` | **Modify** | Add `'/rules'` to `ALLOWED_API_PREFIXES`. |
| `core/src/routes/core/index.ts` | **Modify** | Register `createRuleSyncRoutes`. |
| `core/src/rest-server.ts` | **Modify** | Start `getRuleAutoSyncDaemon()` on boot (next to the memory autosync daemon block). |
| `core/src/mcp-server/tools/expanded.ts` | **Modify** | 5 new tool DEFS + HANDLERS (`rule_record`, `rule_sync_status`, `rule_cross_host`, `rule_import_candidates`, `rule_projects`); update `rule_map` desc (os/active). |
| `core/src/mcp-server/configure.ts` | **Modify** | 5 `TOOL_SCOPES` `read` entries. |
| `core/src/__tests__/rule-os-extract.test.ts` | **Create** | Task 1 unit tests. |
| `core/src/__tests__/rule-sync.test.ts` | **Create** | Task 2 unit tests. |
| `core/src/__tests__/rule-sync-routes.test.ts` + `relay-rules-allow.test.ts` | **Create** | Task 3 route + relay-allow tests. |
| `core/src/__tests__/rule-autosync.test.ts` + `rule-sync-enabled-setting.test.ts` | **Create** | Task 4 daemon + setting tests. |
| `core/scripts/__tests__/memory-rules-e2e.js` | **Modify** + `core/src/__tests__/rule-map-os.test.ts` **Create** | Task 5 CLI tests. |
| `core/src/__tests__/rule-mcp-tools.test.ts` | **Create** | Task 6 MCP-surface tests. |

---

### Task 1: `os:` dimension in `rule-extract.ts`

**Files:**
- Modify: `core/src/rules/rule-extract.ts`
- Test: `core/src/__tests__/rule-os-extract.test.ts` (Create)

**Interfaces:**
- Produces: `export function parseOs(content: string): string[]` — raw `os:` tokens (block list / inline `[..]` / scalar), mirroring `parsePaths`.
- Produces: `export function normalizeOsList(tokens: string[]): string[]` — canonical dedup list (`windows|win|win32→win32`, `mac|macos|osx|darwin→darwin`, `linux→linux`; unknown kept verbatim, lowercased).
- Produces: `ExtractInput` gains optional `platform?: string` (default `os.platform()`).
- Produces: `RuleRecord` gains `os: string[]`, `osDependent: boolean`, `active: boolean`.
- Consumes: existing `parseFrontmatter`, `parsePaths` (unchanged).

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/rule-os-extract.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOs, normalizeOsList, extractRule, ExtractInput } from '../rules/rule-extract';

function inp(content: string, platform?: string): ExtractInput {
  return { node: 'n', project: '(user)', source: 'live', scope: 'user', relpath: 'r.md',
    content, mtimeMs: 1, size: content.length, platform };
}

test('parseOs reads a block list', () => {
  assert.deepEqual(parseOs('---\nname: x\nos:\n  - windows\n  - linux\n---\nbody'), ['windows', 'linux']);
});
test('parseOs reads an inline flow list', () => {
  assert.deepEqual(parseOs('---\nos: [mac, "linux"]\n---\nb'), ['mac', 'linux']);
});
test('parseOs reads a scalar', () => {
  assert.deepEqual(parseOs('---\nos: windows\n---\nb'), ['windows']);
});
test('parseOs absent → []', () => {
  assert.deepEqual(parseOs('---\nname: x\n---\nb'), []);
  assert.deepEqual(parseOs('no frontmatter at all'), []);
});
test('normalizeOsList maps friendly → canonical + dedups', () => {
  assert.deepEqual(normalizeOsList(['Windows', 'win', 'win32']), ['win32']);
  assert.deepEqual(normalizeOsList(['mac', 'macos', 'osx', 'darwin']), ['darwin']);
  assert.deepEqual(normalizeOsList(['linux']), ['linux']);
});
test('normalizeOsList keeps an unknown token verbatim (lowercased)', () => {
  assert.deepEqual(normalizeOsList(['FreeBSD']), ['freebsd']);
});
test('extractRule: absent os → applies to all platforms (active everywhere, not osDependent)', () => {
  for (const p of ['win32', 'darwin', 'linux']) {
    const r = extractRule(inp('---\nname: x\n---\nbody', p));
    assert.deepEqual(r.os, []);
    assert.equal(r.osDependent, false);
    assert.equal(r.active, true, `should be active on ${p}`);
  }
});
test('extractRule: os: windows is active only on win32', () => {
  const c = '---\nname: x\nos: windows\n---\nbody';
  assert.equal(extractRule(inp(c, 'win32')).active, true);
  assert.equal(extractRule(inp(c, 'linux')).active, false);
  assert.equal(extractRule(inp(c, 'darwin')).active, false);
  assert.equal(extractRule(inp(c, 'win32')).osDependent, true);
  assert.deepEqual(extractRule(inp(c, 'win32')).os, ['win32']);
});
test('extractRule: multi-os linux+darwin active on either, inert on win32', () => {
  const c = '---\nos:\n  - linux\n  - osx\n---\nbody';
  assert.equal(extractRule(inp(c, 'linux')).active, true);
  assert.equal(extractRule(inp(c, 'darwin')).active, true);
  assert.equal(extractRule(inp(c, 'win32')).active, false);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd core && npm test 2>&1 | grep -A2 rule-os-extract` (fails: `parseOs`/`normalizeOsList` not exported, `active`/`os` undefined).

- [ ] **Step 3: implement** — in `core/src/rules/rule-extract.ts`:
  - Add `import * as os from 'os';` to the imports (top of file, after `import { createHash } from 'crypto';`).
  - Add `platform?: string;` to `ExtractInput` (after `size: number;`), with a doc comment: `/** serving platform for the active computation; default os.platform() */`.
  - Add to `RuleRecord` (after `loadCondition: LoadCondition;`):
```ts
  // OS-applicability dimension (sync placement decided against the serving platform)
  os: string[];           // canonical platform list ([] = all platforms)
  osDependent: boolean;   // os.length > 0 — the per-rule "OS-dependent or not" tag
  active: boolean;        // os.length === 0 || os.includes(servingPlatform)
```
  - Add the parse + normalize helpers (place directly after `parsePaths`):
```ts
/** Friendly → canonical (Node os.platform()) OS normalization map. */
const OS_NORMALIZE: Record<string, string> = {
  windows: 'win32', win: 'win32', win32: 'win32',
  mac: 'darwin', macos: 'darwin', osx: 'darwin', darwin: 'darwin',
  linux: 'linux',
};

/** Canonicalize one token; unknown tokens are kept verbatim (lowercased) for forward-compat. */
function normalizeOsToken(t: string): string {
  const k = t.trim().toLowerCase();
  return OS_NORMALIZE[k] || k;
}

/** Canonical, de-duplicated platform list from raw os: tokens. */
export function normalizeOsList(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    const v = normalizeOsToken(t);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Parse the `os:` YAML list out of the raw frontmatter block — IDENTICAL shape to parsePaths
 * (block list, inline flow list `os: [a, b]`, single scalar `os: windows`). parseFrontmatter()
 * collapses unknown keys to a scalar string, so we parse it ourselves from the raw block.
 */
export function parseOs(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const stripped = normalized.startsWith('﻿') ? normalized.slice(1) : normalized;
  if (!stripped.startsWith('---\n') && !stripped.startsWith('---\r')) return [];
  const lines = stripped.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '---\r') { end = i; break; }
  }
  if (end === -1) return [];
  const fm = lines.slice(1, end);

  const clean = (s: string): string => {
    let v = s.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v.trim();
  };

  const out: string[] = [];
  for (let i = 0; i < fm.length; i++) {
    const line = fm[i].replace(/\r$/, '');
    const m = line.match(/^(\s*)os\s*:\s*(.*)$/);
    if (!m) continue;
    const inline = m[2].trim();
    if (inline) {
      if (inline.startsWith('[') && inline.endsWith(']')) {
        for (const part of inline.slice(1, -1).split(',')) {
          const v = clean(part);
          if (v) out.push(v);
        }
      } else {
        const v = clean(inline);
        if (v) out.push(v);
      }
      return out;
    }
    const baseIndent = m[1].length;
    for (let j = i + 1; j < fm.length; j++) {
      const bl = fm[j].replace(/\r$/, '');
      if (!bl.trim()) continue;
      const indent = bl.length - bl.trimStart().length;
      const item = bl.trim();
      if (item.startsWith('- ') || item === '-') {
        const v = clean(item.replace(/^-\s*/, ''));
        if (v) out.push(v);
        continue;
      }
      if (indent <= baseIndent) break;
    }
    return out;
  }
  return out;
}
```
  - In `extractRule`, compute the new fields and add them to the returned object. After `const paths = parsePaths(inp.content);` add:
```ts
  const osList = normalizeOsList(parseOs(inp.content));
  const servingPlatform = inp.platform || os.platform();
  const active = osList.length === 0 || osList.includes(servingPlatform);
```
  and in the returned literal add (e.g. after `loadCondition,`): `os: osList, osDependent: osList.length > 0, active,`.

- [ ] **Step 4: run, expect PASS** — `cd core && npm test 2>&1 | grep -E 'rule-os-extract|fail'` (all pass; whole suite green).

- [ ] **Step 5: Commit** —
```bash
git add core/src/rules/rule-extract.ts core/src/__tests__/rule-os-extract.test.ts
git commit -m "feat(rules): add os: dimension (os/osDependent/active) to rule-extract

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: rule-sync core (`core/src/rules/rule-sync.ts`)

**Files:**
- Create: `core/src/rules/rule-sync.ts`
- Test: `core/src/__tests__/rule-sync.test.ts` (Create)

**Interfaces:**
- Produces:
  - `export interface OwnRule { file: string; content: string; contentHash: string; os: string[]; osDependent: boolean }`
  - `export interface IngestRule { file: string; content: string; contentHash: string; os?: string[] }`
  - `export interface IngestResult { applied: number; active: number; inert: number; removed: number }`
  - `export function readOwnRules(rulesDir?: string): OwnRule[]` (default `path.join(getClaudeConfigDir(), 'rules')`) — recursive, EXCLUDE `synced.*` + credential-shaped names; contentHash = sha256 of the whole file.
  - `export function selfHostId(): string` — `LM_HOST_ID` || hub gatewayId || `os.hostname()`.
  - `export function sanitizeHost(host: string): string | null` — `[A-Za-z0-9_-]+` (dots/others → `-`), dot-free for the `synced.<host>.` parse; null if empty.
  - `export function sanitizeBasename(file: string): string | null` — reject absolute / `..` / NUL; flatten separators to `-`; must end `.md` and match `^[A-Za-z0-9._-]+$`.
  - `export function routePlacement(ruleOs: string[], localPlatform: string): 'active' | 'mirror'` — `os.length===0 || os.includes(localPlatform)` → `'active'`, else `'mirror'`.
  - `export function applyIngest(sourceHost, sourcePlatform, rules, localPlatform, opts?): IngestResult` where `opts?: { rulesDir?: string; mirrorRoot?: string }` (defaults `getClaudeConfigDir()/rules` and `getDataDir()/rules-mirror`).
- Consumes: `parseOs`/`normalizeOsList` (Task 1), `getClaudeConfigDir`/`getDataDir` (path-utils), `createHash` (crypto).

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/rule-sync.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  readOwnRules, sanitizeBasename, sanitizeHost, routePlacement, applyIngest,
} from '../rules/rule-sync';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function tmp(prefix: string) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test('readOwnRules excludes synced.* + credential-shaped names, hashes the whole file', () => {
  const dir = tmp('ror-');
  fs.writeFileSync(path.join(dir, 'panic-mode.md'), '---\nname: p\nos: linux\n---\nbody');
  fs.writeFileSync(path.join(dir, 'synced.host-a.foo.md'), '---\nname: f\n---\nx'); // excluded (already synced)
  fs.writeFileSync(path.join(dir, 'api_token.md'), 'secret');                       // excluded (credential)
  const got = readOwnRules(dir);
  assert.deepEqual(got.map(r => r.file), ['panic-mode.md']);
  assert.deepEqual(got[0].os, ['linux']);
  assert.equal(got[0].osDependent, true);
  assert.equal(got[0].contentHash, sha('---\nname: p\nos: linux\n---\nbody'));
});

test('sanitizeBasename flattens separators, rejects traversal/absolute', () => {
  assert.equal(sanitizeBasename('foo.md'), 'foo.md');
  assert.equal(sanitizeBasename('sub/foo.md'), 'sub-foo.md');
  assert.equal(sanitizeBasename('../escape.md'), null);
  assert.equal(sanitizeBasename('/etc/passwd.md'), null);
  assert.equal(sanitizeBasename('nope.txt'), null);
});

test('sanitizeHost is dot-free (so synced.<host>. parses)', () => {
  assert.equal(sanitizeHost('gw-117'), 'gw-117');
  assert.equal(sanitizeHost('host.example.com'), 'host-example-com');
  assert.equal(sanitizeHost(''), null);
});

test('routePlacement: empty os or matching platform → active; mismatch → mirror', () => {
  assert.equal(routePlacement([], 'win32'), 'active');
  assert.equal(routePlacement(['win32'], 'win32'), 'active');
  assert.equal(routePlacement(['win32'], 'linux'), 'mirror');
});

test('applyIngest routes a matching-OS rule ACTIVE and a wrong-OS rule INERT', () => {
  const rulesDir = tmp('ai-active-'); const mirrorRoot = tmp('ai-mirror-');
  const rules = [
    { file: 'lin.md', content: '---\nos: linux\n---\nL', contentHash: sha('---\nos: linux\n---\nL'), os: ['linux'] },
    { file: 'win.md', content: '---\nos: windows\n---\nW', contentHash: sha('---\nos: windows\n---\nW'), os: ['win32'] },
    { file: 'all.md', content: '---\nname: a\n---\nA', contentHash: sha('---\nname: a\n---\nA'), os: [] },
  ];
  const res = applyIngest('117', 'linux', rules, 'linux', { rulesDir, mirrorRoot });
  assert.equal(res.applied, 3);
  assert.equal(res.active, 2);  // lin + all
  assert.equal(res.inert, 1);   // win
  assert.ok(fs.existsSync(path.join(rulesDir, 'synced.117.lin.md')));
  assert.ok(fs.existsSync(path.join(rulesDir, 'synced.117.all.md')));
  assert.ok(fs.existsSync(path.join(mirrorRoot, '117', 'win.md')));
  // byte-identical
  assert.equal(fs.readFileSync(path.join(rulesDir, 'synced.117.lin.md'), 'utf-8'), '---\nos: linux\n---\nL');
});

test('applyIngest never clobbers a hand-authored local rule of the same basename', () => {
  const rulesDir = tmp('ai-coexist-'); const mirrorRoot = tmp('ai-coexist-m-');
  fs.writeFileSync(path.join(rulesDir, 'panic-mode.md'), 'LOCAL HAND-AUTHORED');
  applyIngest('117', 'linux', [
    { file: 'panic-mode.md', content: 'FROM 117', contentHash: sha('FROM 117'), os: [] },
  ], 'linux', { rulesDir, mirrorRoot });
  assert.equal(fs.readFileSync(path.join(rulesDir, 'panic-mode.md'), 'utf-8'), 'LOCAL HAND-AUTHORED');
  assert.equal(fs.readFileSync(path.join(rulesDir, 'synced.117.panic-mode.md'), 'utf-8'), 'FROM 117');
});

test('applyIngest removal is set-diff: a file dropped from the source set is deleted (active + mirror)', () => {
  const rulesDir = tmp('ai-rm-'); const mirrorRoot = tmp('ai-rm-m-');
  // first cycle: two rules from 117 (one active, one inert)
  applyIngest('117', 'linux', [
    { file: 'a.md', content: 'A', contentHash: sha('A'), os: [] },
    { file: 'b.md', content: '---\nos: windows\n---\nB', contentHash: sha('---\nos: windows\n---\nB'), os: ['win32'] },
  ], 'linux', { rulesDir, mirrorRoot });
  assert.ok(fs.existsSync(path.join(rulesDir, 'synced.117.a.md')));
  assert.ok(fs.existsSync(path.join(mirrorRoot, '117', 'b.md')));
  // second cycle: 117 now only exports a.md → b.md must be removed from BOTH locations
  const res = applyIngest('117', 'linux', [
    { file: 'a.md', content: 'A', contentHash: sha('A'), os: [] },
  ], 'linux', { rulesDir, mirrorRoot });
  assert.equal(res.removed, 1);
  assert.ok(fs.existsSync(path.join(rulesDir, 'synced.117.a.md')));
  assert.ok(!fs.existsSync(path.join(mirrorRoot, '117', 'b.md')));
});

test('applyIngest only ever touches THIS source-host namespace (other hosts untouched)', () => {
  const rulesDir = tmp('ai-ns-'); const mirrorRoot = tmp('ai-ns-m-');
  fs.writeFileSync(path.join(rulesDir, 'synced.other.keep.md'), 'KEEP');
  applyIngest('117', 'linux', [], 'linux', { rulesDir, mirrorRoot }); // empty export from 117
  assert.ok(fs.existsSync(path.join(rulesDir, 'synced.other.keep.md')), 'other host not swept');
});

test('applyIngest rejects oversize (>64 KB) and traversal filenames', () => {
  const rulesDir = tmp('ai-cap-'); const mirrorRoot = tmp('ai-cap-m-');
  const big = 'x'.repeat(64 * 1024 + 1);
  const res = applyIngest('117', 'linux', [
    { file: 'big.md', content: big, contentHash: sha(big), os: [] },
    { file: '../evil.md', content: 'E', contentHash: sha('E'), os: [] },
  ], 'linux', { rulesDir, mirrorRoot });
  assert.equal(res.applied, 0);
  assert.ok(!fs.existsSync(path.join(rulesDir, 'synced.117.big.md')));
});

test('applyIngest dedups byte-identical re-ingest (no rewrite churn)', () => {
  const rulesDir = tmp('ai-dedup-'); const mirrorRoot = tmp('ai-dedup-m-');
  const rule = { file: 'a.md', content: 'A', contentHash: sha('A'), os: [] as string[] };
  applyIngest('117', 'linux', [rule], 'linux', { rulesDir, mirrorRoot });
  const dest = path.join(rulesDir, 'synced.117.a.md');
  const mtime1 = fs.statSync(dest).mtimeMs;
  const res = applyIngest('117', 'linux', [rule], 'linux', { rulesDir, mirrorRoot });
  assert.equal(res.applied, 1); // counted as present
  assert.equal(fs.statSync(dest).mtimeMs, mtime1, 'unchanged file not rewritten');
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd core && npm test 2>&1 | grep -A2 rule-sync.test` (fails: module `../rules/rule-sync` not found).

- [ ] **Step 3: implement** — create `core/src/rules/rule-sync.ts`:
```ts
/**
 * Rule sync core — the write side of cross-node USER-rule sync (sibling of memory/ingest.ts).
 *
 *  - readOwnRules(): this node's own USER rules (excludes synced.* + credential-shaped names).
 *  - applyIngest(): place a peer's rules via the OS router — matching/empty-OS rules land ACTIVE at
 *    ~/.claude/rules/synced.<host>.<name>.md (native CC injects them); wrong-OS rules land INERT at
 *    ~/.lm-assist/rules-mirror/<host>/<name>.md (map-indexed only). Set-diff removal: files in the
 *    <host> namespace not in the incoming set are deleted (tombstone-free). Byte-identical writes.
 *
 * See docs/superpowers/specs/2026-06-30-rule-auto-sync-and-os-scoping-design.md
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { getClaudeConfigDir, getDataDir } from '../utils/path-utils';
import { parseOs, normalizeOsList } from './rule-extract';

export interface OwnRule { file: string; content: string; contentHash: string; os: string[]; osDependent: boolean; }
export interface IngestRule { file: string; content: string; contentHash: string; os?: string[]; }
export interface IngestResult { applied: number; active: number; inert: number; removed: number; }

const MAX_RULE_BYTES = 64 * 1024;
/** Credential-shaped filenames are never read/exported (mirrors memory's export guard). */
const CREDENTIAL_PATTERNS: RegExp[] = [/token/i, /\bkey\b/i, /cookie/i, /password/i, /secret/i, /credential/i];

function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }

export function rulesRoot(rulesDir?: string): string { return rulesDir || path.join(getClaudeConfigDir(), 'rules'); }
export function mirrorRootDir(mirrorRoot?: string): string { return mirrorRoot || path.join(getDataDir(), 'rules-mirror'); }

/** LM_HOST_ID > hub gatewayId > hostname. Used to attribute this node's exported rules. */
export function selfHostId(): string {
  if (process.env.LM_HOST_ID) return process.env.LM_HOST_ID;
  try {
    const id = require('../hub-client').getHubClient().getStatus().gatewayId;
    if (id) return String(id);
  } catch { /* hub not up */ }
  return os.hostname();
}

/** Dot-free host segment so `synced.<host>.<name>` parses unambiguously. null if it sanitizes to empty. */
export function sanitizeHost(host: string): string | null {
  const s = String(host || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s.length ? s : null;
}

/** A safe, flat *.md basename. Rejects absolute / traversal; flattens separators to '-'. null if unsafe. */
export function sanitizeBasename(file: string): string | null {
  const f = String(file || '');
  if (!f || f.includes('\0') || f.includes('..') || path.isAbsolute(f)) return null;
  const flat = f.replace(/[\\/]+/g, '-').replace(/^\.+/, '');
  if (!flat.endsWith('.md') || !/^[A-Za-z0-9._-]+$/.test(flat)) return null;
  return flat;
}

/** Recursively read this node's own USER rules. Excludes synced.* + credential-shaped names. */
export function readOwnRules(rulesDir?: string): OwnRule[] {
  const root = rulesRoot(rulesDir);
  const out: OwnRule[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp); continue; }
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      if (e.name.startsWith('synced.')) continue;            // never re-export a synced copy → no echo loop
      if (CREDENTIAL_PATTERNS.some((re) => re.test(e.name))) continue;
      let content: string;
      try { content = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
      if (Buffer.byteLength(content, 'utf-8') > MAX_RULE_BYTES) continue;
      const relpath = path.relative(root, fp).split(path.sep).join('/');
      const osList = normalizeOsList(parseOs(content));
      out.push({ file: relpath, content, contentHash: sha256(content), os: osList, osDependent: osList.length > 0 });
    }
  };
  walk(root);
  return out;
}

/** Active (native-injected) vs mirror (inert) placement for one rule on this platform. */
export function routePlacement(ruleOs: string[], localPlatform: string): 'active' | 'mirror' {
  return ruleOs.length === 0 || ruleOs.includes(localPlatform) ? 'active' : 'mirror';
}

function ensureMirrorReadme(root: string): void {
  try {
    fs.mkdirSync(root, { recursive: true });
    const readme = path.join(root, 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme,
        '# rules-mirror\n\nInert (wrong-OS) copies of fleet rules, indexed by the rule-map only — ' +
        'NOT injected into sessions. Do not hand-edit; edit a rule on its source host. ' +
        'Active copies live in ~/.claude/rules/synced.<host>.*.\n');
    }
  } catch { /* best-effort */ }
}

/**
 * Place a peer's CURRENT rule set via the OS router + tombstone-free set-diff removal.
 * Writes are confined to ~/.claude/rules/synced.<host>.* and ~/.lm-assist/rules-mirror/<host>/.
 * sourcePlatform is accepted for symmetry/logging but routing uses each rule's own os vs localPlatform.
 */
export function applyIngest(
  sourceHost: string,
  _sourcePlatform: string,
  rules: IngestRule[],
  localPlatform: string,
  opts: { rulesDir?: string; mirrorRoot?: string } = {},
): IngestResult {
  const res: IngestResult = { applied: 0, active: 0, inert: 0, removed: 0 };
  const host = sanitizeHost(sourceHost);
  if (!host) return res;

  const activeDir = rulesRoot(opts.rulesDir);
  const mirrorBase = mirrorRootDir(opts.mirrorRoot);
  const mirrorDir = path.join(mirrorBase, host);

  const wantActive = new Set<string>();   // synced.<host>.<name> basenames we keep this cycle
  const wantMirror = new Set<string>();   // <name> basenames in the host's mirror dir we keep

  for (const r of rules) {
    const name = sanitizeBasename(r.file);
    if (!name) continue;
    if (Buffer.byteLength(r.content || '', 'utf-8') > MAX_RULE_BYTES) continue;
    const ruleOs = Array.isArray(r.os) ? r.os : [];
    const place = routePlacement(ruleOs, localPlatform);

    if (place === 'active') {
      const fname = `synced.${host}.${name}`;
      const dest = path.join(activeDir, fname);
      if (path.dirname(path.resolve(dest)) !== path.resolve(activeDir)) continue; // defense-in-depth
      writeIfChanged(dest, r.content);
      wantActive.add(fname);
      res.applied++; res.active++;
    } else {
      ensureMirrorReadme(mirrorBase);
      const dest = path.join(mirrorDir, name);
      try { fs.mkdirSync(mirrorDir, { recursive: true }); } catch { /* */ }
      if (path.dirname(path.resolve(dest)) !== path.resolve(mirrorDir)) continue; // defense-in-depth
      writeIfChanged(dest, r.content);
      wantMirror.add(name);
      res.applied++; res.inert++;
    }
  }

  // ── tombstone-free removal: drop this host's synced/mirror files NOT in the current set ──
  res.removed += sweep(activeDir, (n) => n.startsWith(`synced.${host}.`) && !wantActive.has(n));
  res.removed += sweep(mirrorDir, (n) => n.endsWith('.md') && n !== 'README.md' && !wantMirror.has(n));
  return res;
}

/** Write only if absent or byte-different (preserves mtime → no churn, keeps contentHash dedup honest). */
function writeIfChanged(dest: string, content: string): void {
  try {
    if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf-8') === content) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  } catch { /* unwritable — skip */ }
}

/** Delete files in dir whose basename matches pred. Returns count removed. */
function sweep(dir: string, pred: (name: string) => boolean): number {
  let removed = 0;
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const n of names) {
    if (!pred(n)) continue;
    try { fs.unlinkSync(path.join(dir, n)); removed++; } catch { /* */ }
  }
  return removed;
}
```

- [ ] **Step 4: run, expect PASS** — `cd core && npm test 2>&1 | grep -E 'rule-sync.test|fail'`.

- [ ] **Step 5: Commit** —
```bash
git add core/src/rules/rule-sync.ts core/src/__tests__/rule-sync.test.ts
git commit -m "feat(rules): rule-sync core — readOwnRules + OS-router applyIngest (confined, set-diff)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: routes (`core/src/routes/core/rule-sync.routes.ts`)

**Files:**
- Create: `core/src/routes/core/rule-sync.routes.ts`
- Modify: `core/src/routes/core/index.ts` (register), `core/src/hub-client/api-relay-handler.ts` (allow-list)
- Test: `core/src/__tests__/rule-sync-routes.test.ts`, `core/src/__tests__/relay-rules-allow.test.ts` (Create)

**Interfaces:**
- Produces: `export function createRuleSyncRoutes(_ctx: RouteContext): RouteHandler[]` — 4 handlers.
  - `POST /rules/export` `{ key? }` → `{ host, platform, rules: OwnRule[] }`.
  - `POST /rules/ingest` `{ sourceHost, sourcePlatform, rules[], key? }` → `{ applied, active, inert, removed }`.
  - `GET /rules/sync/status` → `{ config: { ruleSyncEnabled, nodeMode }, daemon }`.
  - `GET /rules/autosync/status` → daemon `getStatus()`.
- Consumes: `readOwnRules`/`selfHostId`/`applyIngest` (Task 2), `getRuleAutoSyncDaemon` (Task 4), `getProjectSettings`, `readMemorySyncConfig` (reuse node-mode), `wrapResponse`/`wrapError`, `isLoopbackAddress`.
- Auth helper mirrors `memory-sync.routes.ts` `authorized(req, bodyKey)`.

- [ ] **Step 1: Write the failing tests** —

`core/src/__tests__/relay-rules-allow.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiRelayHandler } from '../hub-client/api-relay-handler';

function check(path: string): string | null {
  const h = new ApiRelayHandler({ localApiPort: 3200 } as any);
  return (h as any).validateRequest({ type: 'api_relay', requestId: 'r1', method: 'POST', path });
}
test('/rules/export is relay-allowed', () => assert.equal(check('/rules/export'), null));
test('/rules/ingest is relay-allowed', () => assert.equal(check('/rules/ingest'), null));
test('/rules/map (existing CLI route) is now relay-allowed too', () => assert.equal(check('/rules/map'), null));
```

`core/src/__tests__/rule-sync-routes.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Hermetic claude rules dir + lm-assist data dir BEFORE importing the routes (read at call time).
const CLAUDE = fs.mkdtempSync(path.join(os.tmpdir(), 'rsr-claude-'));
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsr-data-'));

import { createRuleSyncRoutes } from '../routes/core/rule-sync.routes';
import type { ParsedRequest } from '../routes/index';

function rulesDir() { return path.join(CLAUDE, 'rules'); }
function seed() {
  fs.mkdirSync(rulesDir(), { recursive: true });
  fs.writeFileSync(path.join(rulesDir(), 'always.md'), '---\nname: a\n---\nbody');
  fs.writeFileSync(path.join(rulesDir(), 'winonly.md'), '---\nos: windows\n---\nW');
  fs.writeFileSync(path.join(rulesDir(), 'synced.peer.x.md'), '---\nname: x\n---\nx'); // must NOT export
  fs.writeFileSync(path.join(rulesDir(), 'api_key.md'), 'secret');                      // must NOT export
}
function routes() { return createRuleSyncRoutes({} as any); }
function route(method: string, re: RegExp) { return routes().find(r => r.method === method && re.test(r.pattern.source))!; }
function localReq(p: string, body: any): ParsedRequest {
  return { method: 'POST', path: p, params: {}, query: {}, body, headers: {}, clientIp: '127.0.0.1' } as ParsedRequest;
}

test('exposes the 4 rule-sync routes', () => {
  const paths = routes().map(r => `${r.method} ${r.pattern.source}`);
  assert.ok(paths.some(p => p.startsWith('POST') && /rules.{1,3}export/.test(p)), paths.join(','));
  assert.ok(paths.some(p => p.startsWith('POST') && /rules.{1,3}ingest/.test(p)), paths.join(','));
  assert.ok(paths.some(p => p.startsWith('GET') && /rules.{1,3}sync.{1,3}status/.test(p)), paths.join(','));
  assert.ok(paths.some(p => p.startsWith('GET') && /rules.{1,3}autosync.{1,3}status/.test(p)), paths.join(','));
});

test('export returns own rules only (excludes synced.* + credential names) with os fields', async () => {
  seed();
  const r: any = await route('POST', /export/).handler(localReq('/rules/export', {}), {} as any);
  assert.equal(r.success, true);
  const files = r.data.rules.map((x: any) => x.file).sort();
  assert.deepEqual(files, ['always.md', 'winonly.md']);
  assert.equal(typeof r.data.host, 'string');
  assert.equal(typeof r.data.platform, 'string');
  const win = r.data.rules.find((x: any) => x.file === 'winonly.md');
  assert.deepEqual(win.os, ['win32']);
  assert.equal(win.osDependent, true);
});

test('unauthorized (not loopback, not relayed) export is rejected', async () => {
  const req = { method: 'POST', path: '/rules/export', params: {}, query: {}, body: {}, headers: {}, clientIp: '10.0.0.9' } as ParsedRequest;
  const r: any = await route('POST', /export/).handler(req, {} as any);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'FORBIDDEN');
});

test('relayed export (loopback + x-relay-source:hub) requires a body key', async () => {
  const noKey = { method: 'POST', path: '/rules/export', params: {}, query: {}, body: {}, headers: { 'x-relay-source': 'hub' }, clientIp: '127.0.0.1' } as ParsedRequest;
  assert.equal((await route('POST', /export/).handler(noKey, {} as any) as any).error.code, 'FORBIDDEN');
  const withKey = { ...noKey, body: { key: 'sk-x' } } as ParsedRequest;
  assert.equal((await route('POST', /export/).handler(withKey, {} as any) as any).success, true);
});

test('ingest places rules via the OS router (active vs mirror) and is confined', async () => {
  const sha = (s: string) => require('crypto').createHash('sha256').update(s).digest('hex');
  const body = { sourceHost: '117', sourcePlatform: 'linux', rules: [
    { file: 'shared.md', content: 'S', contentHash: sha('S') },                                   // os:[] → active
    { file: 'lin.md', content: '---\nos: linux\n---\nL', contentHash: sha('---\nos: linux\n---\nL'), os: ['linux'] },
    { file: '../evil.md', content: 'E', contentHash: sha('E') },                                  // rejected
  ] };
  const r: any = await route('POST', /ingest/).handler(localReq('/rules/ingest', body), {} as any);
  assert.equal(r.success, true);
  assert.equal(r.data.applied, 2);
  assert.ok(!fs.existsSync(path.join(CLAUDE, 'rules', 'synced.117.-evil.md')));
});

test('ingest validates required fields', async () => {
  const r: any = await route('POST', /ingest/).handler(localReq('/rules/ingest', { sourceHost: '117' }), {} as any);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'INVALID_INPUT');
});

test('GET /rules/sync/status returns config + daemon shape', async () => {
  const r: any = await route('GET', /sync.{1,3}status/).handler({ params: {}, query: {} } as any, {} as any);
  assert.equal(r.success, true);
  assert.equal(typeof r.data.config.ruleSyncEnabled, 'boolean');
  assert.ok(r.data.daemon && typeof r.data.daemon.mode === 'string');
});
```
Note: the ingest test asserts a `routePlacement` rule (`lin.md`) lands active on a linux test host. On a non-linux CI host it lands inert — to stay platform-stable the test asserts `applied===2` (both valid rules placed, evil rejected) rather than the active/inert split (Task 2 already covers the split deterministically with an explicit `localPlatform`).

- [ ] **Step 2: Run it, expect FAIL** — `cd core && npm test 2>&1 | grep -E 'rule-sync-routes|relay-rules'` (module not found; `/rules` not allow-listed).

- [ ] **Step 3: implement** —

Create `core/src/routes/core/rule-sync.routes.ts`:
```ts
/**
 * Cross-node RULE sync routes — direct-MCP transport (sibling of memory-sync.routes.ts).
 *
 *   POST /rules/export  { key? }                                  -> this node's own USER rules
 *   POST /rules/ingest  { sourceHost, sourcePlatform, rules[], key? } -> OS-route + place a peer's set
 *   GET  /rules/sync/status                                       -> config + daemon
 *   GET  /rules/autosync/status                                   -> daemon only
 *
 * Both POSTs carry the access-key in the BODY: the hub machine-proxy drops x-lm-access-key.
 * Authorization mirrors memory-sync: loopback-only; a relayed (x-relay-source:hub) call needs the key.
 */
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { readOwnRules, selfHostId, applyIngest, IngestRule } from '../../rules/rule-sync';
import { getProjectSettings } from '../../project-settings';
// NOTE: the Task-4 daemon is loaded via a RUNTIME require() inside the status handlers
// (exactly like memory-autosync.routes.ts) — NOT a top-level import — so this routes file
// COMPILES in Task 3 before core/src/rules/autosync.ts exists. No stub needed.
import { readMemorySyncConfig } from '../../memory/node-mode';
import { isLoopbackAddress } from '../../auth/enroll-exempt';
import * as os from 'os';

function relaySource(req: ParsedRequest): string | undefined {
  const v = req.headers?.['x-relay-source'];
  return Array.isArray(v) ? v[0] : v;
}

/** Loopback-only; a relayed call (x-relay-source:hub) must carry the node key in the body. */
function authorized(req: ParsedRequest, bodyKey: unknown): boolean {
  if (!isLoopbackAddress(req.clientIp)) return false;
  if (relaySource(req) === 'hub') return typeof bodyKey === 'string' && bodyKey.length > 0;
  return true;
}

export function createRuleSyncRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'POST',
      pattern: /^\/rules\/export$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const b = (req.body || {}) as { key?: string };
        if (!authorized(req, b.key)) return wrapError('FORBIDDEN', 'not authorized for rule sync', start);
        return wrapResponse({ host: selfHostId(), platform: os.platform(), rules: readOwnRules() }, start);
      },
    },
    {
      method: 'POST',
      pattern: /^\/rules\/ingest$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const b = (req.body || {}) as { sourceHost?: string; sourcePlatform?: string; rules?: IngestRule[]; key?: string };
        if (!authorized(req, b.key)) return wrapError('FORBIDDEN', 'not authorized for rule sync', start);
        if (!b.sourceHost || !Array.isArray(b.rules)) {
          return wrapError('INVALID_INPUT', 'sourceHost and rules[] are required', start);
        }
        const result = applyIngest(b.sourceHost, b.sourcePlatform || '', b.rules, os.platform());
        return wrapResponse(result, start);
      },
    },
    {
      method: 'GET',
      pattern: /^\/rules\/sync\/status$/,
      handler: async () => {
        const start = Date.now();
        try {
          const { getRuleAutoSyncDaemon } = require('../../rules/autosync');
          return wrapResponse({
            config: { ruleSyncEnabled: getProjectSettings().ruleSyncEnabled, nodeMode: readMemorySyncConfig().nodeMode },
            daemon: getRuleAutoSyncDaemon().getStatus(),
          }, start);
        } catch (e) {
          return wrapError('RULE_SYNC_STATUS_FAILED', String(e), start);
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/rules\/autosync\/status$/,
      handler: async () => {
        const start = Date.now();
        try {
          const { getRuleAutoSyncDaemon } = require('../../rules/autosync');
          return wrapResponse(getRuleAutoSyncDaemon().getStatus(), start);
        } catch (e) {
          return wrapError('RULE_AUTOSYNC_STATUS_FAILED', String(e), start);
        }
      },
    },
  ];
}
```
Note: the export response key is `rules` (per spec §4: `{ host, platform, rules: [...] }`); each element is an `OwnRule` (`{ file, content, contentHash, os, osDependent }`). `pullRulesExport` (Task 4) reads `raw.rules`.

In `core/src/routes/core/index.ts`: add `import { createRuleSyncRoutes } from './rule-sync.routes';` (after the `createRuleMapRoutes` import) and `...createRuleSyncRoutes(ctx),` in the returned array (after `...createRuleMapRoutes(ctx),`).

In `core/src/hub-client/api-relay-handler.ts`: add `'/rules',` to `ALLOWED_API_PREFIXES` (right after the `'/memory',` line) with a comment: `// cross-node rule sync + rule-map (export/ingest; access-key in body when relayed)`.

- [ ] **Step 4: run, expect PASS** — `cd core && npm test 2>&1 | grep -E 'rule-sync-routes|relay-rules|fail'`. The two status handlers lazy-`require('../../rules/autosync')` at RUNTIME (like `memory-autosync.routes.ts`), so this routes file COMPILES now without the Task-4 daemon, and the try/catch returns a graceful error until it exists. **This task's tests cover EXPORT/INGEST + the relay allow-list only**; the `/rules/sync/status` + `/rules/autosync/status` routes are integration-tested in Task 4 once the daemon is wired.

- [ ] **Step 5: Commit** —
```bash
git add core/src/routes/core/rule-sync.routes.ts core/src/routes/core/index.ts core/src/hub-client/api-relay-handler.ts core/src/__tests__/rule-sync-routes.test.ts core/src/__tests__/relay-rules-allow.test.ts
git commit -m "feat(rules): rule-sync routes (export/ingest/status) + /rules relay allow-list

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: daemon (`core/src/rules/autosync.ts`)

**Files:**
- Create: `core/src/rules/autosync.ts`
- Modify: `core/src/memory/mcp-transport.ts` (add `rulesExportBody` + `pullRulesExport`), `core/src/rest-server.ts` (boot wiring), `core/src/project-settings.ts` + `core/src/routes/core/project-settings.routes.ts` (`ruleSyncEnabled`)
- Test: `core/src/__tests__/rule-autosync.test.ts`, `core/src/__tests__/rule-sync-enabled-setting.test.ts` (Create)

**Interfaces:**
- Produces (`autosync.ts`):
  - `export type RuleSyncMode = 'off' | 'observe' | 'on'`
  - `export function resolveMode(): RuleSyncMode` (env `RULE_AUTOSYNC` wins; else `ruleSyncEnabled ? 'on' : 'off'`; catch → `'observe'`).
  - `export class RuleAutoSyncDaemon { start(); getMode(); refreshMode(); getStatus(); reconcile(): Promise<void> }`
  - `export function getRuleAutoSyncDaemon(): RuleAutoSyncDaemon`
- Produces (`mcp-transport.ts`): `export function rulesExportBody(key: string)`, `export async function pullRulesExport(node, key): Promise<{ host; platform; rules: IngestRule[] } | null>`.
- Consumes: `applyIngest` (Task 2), `listFleetNodes` (mcp-transport), `getHubConfig`, `chokidar` v3, `getClaudeConfigDir`.

- [ ] **Step 1: Write the failing tests** —

`core/src/__tests__/rule-sync-enabled-setting.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function freshSettings(dataDir: string): any {
  process.env.LM_ASSIST_DATA_DIR = dataDir;
  delete require.cache[require.resolve('../project-settings')];
  return require('../project-settings');
}
test('ruleSyncEnabled defaults to true', () => {
  const { getProjectSettings } = freshSettings(fs.mkdtempSync(path.join(os.tmpdir(), 'rse-')));
  assert.equal(getProjectSettings().ruleSyncEnabled, true);
});
test('ruleSyncEnabled reads false from the settings file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rse2-'));
  fs.writeFileSync(path.join(dir, 'project-settings.json'), JSON.stringify({ ruleSyncEnabled: false }));
  const { getProjectSettings } = freshSettings(dir);
  assert.equal(getProjectSettings().ruleSyncEnabled, false);
});
test('saveProjectSettings round-trips ruleSyncEnabled', () => {
  const { getProjectSettings, saveProjectSettings } = freshSettings(fs.mkdtempSync(path.join(os.tmpdir(), 'rse3-')));
  saveProjectSettings({ ruleSyncEnabled: false });
  assert.equal(getProjectSettings().ruleSyncEnabled, false);
});
```

`core/src/__tests__/rule-autosync.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-data-'));

test('resolveMode follows RULE_AUTOSYNC env over the setting', () => {
  const mod = require('../rules/autosync');
  const prev = process.env.RULE_AUTOSYNC;
  process.env.RULE_AUTOSYNC = 'off';   assert.equal(mod.resolveMode(), 'off');
  process.env.RULE_AUTOSYNC = 'observe'; assert.equal(mod.resolveMode(), 'observe');
  process.env.RULE_AUTOSYNC = 'on';    assert.equal(mod.resolveMode(), 'on');
  if (prev === undefined) delete process.env.RULE_AUTOSYNC; else process.env.RULE_AUTOSYNC = prev;
});

test('daemon getStatus has the expected shape; getMode is one of off/observe/on', () => {
  const { getRuleAutoSyncDaemon } = require('../rules/autosync');
  const d = getRuleAutoSyncDaemon();
  const s = d.getStatus();
  assert.ok(['off', 'observe', 'on'].includes(s.mode));
  assert.equal(typeof s.running, 'boolean');
  assert.ok(s.counts && typeof s.counts.fetched === 'number' && typeof s.counts.errors === 'number');
  assert.ok(Array.isArray(s.recentEvents));
});

test('reconcile applies a mocked peer export through the OS router', async () => {
  process.env.RULE_AUTOSYNC = 'on';
  const CLAUDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-claude-'));
  process.env.CLAUDE_CONFIG_DIR = CLAUDE;
  const sha = (s: string) => require('crypto').createHash('sha256').update(s).digest('hex');

  // Inject fake transport + fleet so reconcile() does no real network.
  const transport = require('../memory/mcp-transport');
  const origList = transport.listFleetNodes;
  const origPull = transport.pullRulesExport;
  transport.listFleetNodes = async () => ['117'];
  transport.pullRulesExport = async () => ({ host: '117', platform: 'linux', rules: [
    { file: 'shared.md', content: 'S', contentHash: sha('S') },               // os:[] → active everywhere
  ] });
  // a hub key must be present for reconcile to proceed
  const hubcfg = require('../hub-client/hub-config');
  const origCfg = hubcfg.getHubConfig;
  hubcfg.getHubConfig = () => ({ apiKey: 'sk-test', hubUrl: 'wss://h' });

  try {
    delete require.cache[require.resolve('../rules/autosync')];
    const { getRuleAutoSyncDaemon } = require('../rules/autosync');
    await getRuleAutoSyncDaemon().reconcile();
    assert.ok(fs.existsSync(path.join(CLAUDE, 'rules', 'synced.117.shared.md')), 'active synced file written');
  } finally {
    transport.listFleetNodes = origList; transport.pullRulesExport = origPull; hubcfg.getHubConfig = origCfg;
    delete process.env.RULE_AUTOSYNC;
  }
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd core && npm test 2>&1 | grep -E 'rule-autosync|rule-sync-enabled'`.

- [ ] **Step 3: implement** —

(a) In `core/src/memory/mcp-transport.ts`, add (after `pushMergeToPeer`, reusing the existing private `relayPost`):
```ts
import type { IngestRule } from '../rules/rule-sync';

export function rulesExportBody(key: string) { return { key }; }

/** Pull a peer node's own USER rules (relayed, key in body). Returns null on any failure. */
export async function pullRulesExport(node: string, key: string): Promise<{ host: string; platform: string; rules: IngestRule[] } | null> {
  const j = await relayPost(node, '/rules/export', rulesExportBody(key));
  const raw = j && (j.data || j);
  if (!raw || !Array.isArray(raw.rules)) return null;
  return { host: String(raw.host || node), platform: String(raw.platform || ''), rules: raw.rules };
}
```
(Type-only `import type { IngestRule }` is erased at compile — no runtime cycle.)

(b) Create `core/src/rules/autosync.ts`:
```ts
/**
 * Rule Auto-Sync Daemon — pull-based cross-node USER-rule convergence (sibling of memory/autosync.ts).
 *
 *   watch ~/.claude/rules/*.md (own; chokidar v3, excl synced.*) + 5-min timer + on-demand
 *     -> for each ONLINE FLEET node (unfiltered / fleet-wide): pull /rules/export -> applyIngest
 *        (OS router: active synced.<host>.* vs inert rules-mirror/<host>/, set-diff removal)
 *
 * MODE: `on` by DEFAULT (ruleSyncEnabled, default true; env RULE_AUTOSYNC overrides off/observe/on).
 * observe/off = detect + log a PLAN only, no writes. PULL-only (memory's dataset_updated push is dead).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import { getClaudeConfigDir } from '../utils/path-utils';
import { getHubConfig } from '../hub-client/hub-config';
import * as transport from '../memory/mcp-transport';
import { applyIngest } from './rule-sync';

export type RuleSyncMode = 'off' | 'observe' | 'on';

/** env RULE_AUTOSYNC wins; else ruleSyncEnabled (default true → on); fallback observe. */
export function resolveMode(): RuleSyncMode {
  const v = (process.env.RULE_AUTOSYNC || '').trim().toLowerCase();
  if (v === 'on') return 'on';
  if (v === 'off') return 'off';
  if (v === 'observe') return 'observe';
  try {
    return require('../project-settings').getProjectSettings().ruleSyncEnabled ? 'on' : 'off';
  } catch {
    return 'observe';
  }
}

const DEBOUNCE_MS = 1500;
const LOG_DIR = path.join(os.homedir(), '.cache', 'lm-assist');
const LOG_FILE = path.join(LOG_DIR, 'rule-autosync.log');
const RECENT_EVENT_CAP = 50;

export interface RuleSyncEvent { ts: number; mode: RuleSyncMode; decision: string; detail?: Record<string, unknown>; }
export interface RuleSyncStatus {
  mode: RuleSyncMode; running: boolean; hostId: string | null;
  counts: { reconciles: number; pulled: number; applied: number; removed: number; fetched: number; errors: number };
  recentEvents: RuleSyncEvent[]; logFile: string;
}

export class RuleAutoSyncDaemon {
  private mode: RuleSyncMode;
  private started = false;
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private recentEvents: RuleSyncEvent[] = [];
  private counts: RuleSyncStatus['counts'] = { reconciles: 0, pulled: 0, applied: 0, removed: 0, fetched: 0, errors: 0 };

  constructor(opts: { mode?: RuleSyncMode } = {}) { this.mode = opts.mode || resolveMode(); }

  getMode(): RuleSyncMode { return this.mode; }
  refreshMode(): RuleSyncMode { this.mode = resolveMode(); return this.mode; }

  /** Idempotent. Watches own rules + a periodic reconcile timer. Harmless in observe/off (no writes). */
  start(): void {
    if (this.started) return;
    if (this.mode === 'off') { this.log('daemon-off', { reason: 'RULE_AUTOSYNC=off / ruleSyncEnabled=false' }); this.started = true; return; }

    const rulesDir = path.join(getClaudeConfigDir(), 'rules');
    try {
      // chokidar v3 API (CommonJS). Ignore synced.* (own export excludes them → no self-trigger loop).
      this.watcher = chokidar.watch(rulesDir, {
        ignoreInitial: true,
        depth: 4,
        ignored: (p: string) => path.basename(p).startsWith('synced.'),
      });
      const onEvt = (p: string) => { if (p.endsWith('.md')) this.scheduleReconcile(); };
      this.watcher.on('add', onEvt).on('change', onEvt).on('unlink', onEvt);
    } catch (err) {
      this.counts.errors++; this.log('watch-init-failed', { error: String(err) });
    }

    const periodMs = Math.max(60_000, (Number(process.env.RULE_RECONCILE_SEC) || 300) * 1000);
    this.timer = setInterval(() => { void this.reconcile().catch(() => { /* best-effort */ }); }, periodMs);
    this.timer.unref?.();

    this.started = true;
    this.log('started', { mode: this.mode, rulesDir, periodMs });

    if (this.mode === 'on') {
      setTimeout(() => { void this.reconcile().catch(() => { /* best-effort */ }); }, 15_000).unref?.();
    }
  }

  private scheduleReconcile(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.debounce = null; void this.reconcile().catch(() => { /* */ }); }, DEBOUNCE_MS);
  }

  /** Pull every online fleet node's own rules and apply locally through the OS router. */
  async reconcile(): Promise<void> {
    if (this.mode !== 'on') { this.log('would-reconcile', { note: 'observe/off — no transport, no writes' }); return; }
    const key = getHubConfig().apiKey || '';
    if (!key) { this.log('skip-no-key', { note: 'node not enrolled (no hub apiKey)' }); return; }
    let fleet: string[] = [];
    try { fleet = await transport.listFleetNodes(); } catch (e) { this.counts.errors++; this.log('fleet-error', { error: String(e) }); return; }
    if (!fleet.length) { this.log('reconcile-no-peers', {}); return; }

    this.counts.reconciles++;
    const localPlatform = os.platform();
    for (const node of fleet) {
      try {
        const exp = await transport.pullRulesExport(node, key);
        if (!exp) { this.log('pull-empty', { node }); continue; }
        this.counts.pulled++;
        const res = applyIngest(exp.host || node, exp.platform, exp.rules, localPlatform);
        this.counts.applied += res.applied; this.counts.removed += res.removed; this.counts.fetched++;
        this.log('reconciled', { node: exp.host || node, ...res });
      } catch (e) { this.counts.errors++; this.log('reconcile-error', { node, error: String(e) }); }
    }
  }

  private resolveHostId(): string | null { return process.env.LM_HOST_ID || null; }

  private log(decision: string, detail?: Record<string, unknown>): void {
    const ev: RuleSyncEvent = { ts: Date.now(), mode: this.mode, decision, detail };
    this.recentEvents.push(ev);
    if (this.recentEvents.length > RECENT_EVENT_CAP) this.recentEvents.shift();
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, JSON.stringify(ev) + '\n'); } catch { /* never throw */ }
  }

  getStatus(): RuleSyncStatus {
    return { mode: this.mode, running: this.started, hostId: this.resolveHostId(),
      counts: { ...this.counts }, recentEvents: this.recentEvents.slice(-20), logFile: LOG_FILE };
  }
}

let instance: RuleAutoSyncDaemon | null = null;
export function getRuleAutoSyncDaemon(): RuleAutoSyncDaemon {
  if (!instance) instance = new RuleAutoSyncDaemon();
  return instance;
}
```
The reconcile test stubs `transport.listFleetNodes`/`transport.pullRulesExport`; calling them via the `transport.*` namespace (not destructured) is why the daemon does `import * as transport` and `transport.pullRulesExport(...)` — so the test's monkey-patch is observed.

(c) `core/src/project-settings.ts` — add `ruleSyncEnabled` mirroring `memorySyncEnabled` in all four spots:
  - interface (after `memorySyncEnabled: boolean;`): `/** Cross-node rule sync: when true the rule-autosync daemon runs in on mode (env RULE_AUTOSYNC overrides). Default true. */\n  ruleSyncEnabled: boolean;`
  - `DEFAULTS` (after `memorySyncEnabled: true,`): `ruleSyncEnabled: true,`
  - `getProjectSettings` parse (after the `memorySyncEnabled:` line): `ruleSyncEnabled: typeof data.ruleSyncEnabled === 'boolean' ? data.ruleSyncEnabled : DEFAULTS.ruleSyncEnabled,`
  - `saveProjectSettings` merge (after the `memorySyncEnabled:` line): `ruleSyncEnabled: typeof partial.ruleSyncEnabled === 'boolean' ? partial.ruleSyncEnabled : current.ruleSyncEnabled,`

(d) `core/src/routes/core/project-settings.routes.ts` — in the PUT handler add `ruleSyncEnabled: body.ruleSyncEnabled,` to the `saveProjectSettings({...})` call, and after the memory-sync live-apply block add:
```ts
        // Live-apply the rule-sync toggle: re-resolve the rule-autosync daemon mode (no restart).
        if (prevSettings.ruleSyncEnabled !== updated.ruleSyncEnabled) {
          try {
            const mode = require('../../rules/autosync').getRuleAutoSyncDaemon().refreshMode();
            console.log(`[ProjectSettings] ruleSyncEnabled=${updated.ruleSyncEnabled} → rule-autosync mode=${mode}`);
          } catch (err: any) {
            console.error('[ProjectSettings] rule-sync toggle error:', err?.message);
          }
        }
```

(e) `core/src/rest-server.ts` — in `initMemoryCacheEvents()`, directly after the memory autosync daemon `try {...}` block (ends ~line 158), add:
```ts
      // Start the cross-node RULE autosync daemon (own chokidar v3 watch of ~/.claude/rules/*.md;
      // pull-based fleet-wide reconcile). On by default (ruleSyncEnabled; env RULE_AUTOSYNC overrides).
      try {
        const { getRuleAutoSyncDaemon } = require('./rules/autosync');
        const rd = getRuleAutoSyncDaemon();
        rd.start();
        console.log(`[Server] Rule autosync daemon: mode=${rd.getMode()}`);
      } catch (e) {
        console.warn('[Server] Rule autosync daemon init failed:', e);
      }
```

- [ ] **Step 4: run, expect PASS** — `cd core && npm test 2>&1 | grep -E 'rule-autosync|rule-sync-enabled|fail'`. Also build the whole tree: `./core.sh build` (verifies the chokidar v3 import + the mcp-transport ↔ rule-sync type-only import compile under CommonJS, no `ERR_REQUIRE_ESM`).

- [ ] **Step 5: Commit** —
```bash
git add core/src/rules/autosync.ts core/src/memory/mcp-transport.ts core/src/rest-server.ts core/src/project-settings.ts core/src/routes/core/project-settings.routes.ts core/src/__tests__/rule-autosync.test.ts core/src/__tests__/rule-sync-enabled-setting.test.ts
git commit -m "feat(rules): pull-based rule-autosync daemon + ruleSyncEnabled setting + boot wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: rule-map CLI (`core/scripts/rule-map.js`)

**Files:**
- Modify: `core/scripts/rule-map.js`
- Test: `core/scripts/__tests__/memory-rules-e2e.js` (Modify — add cases), `core/src/__tests__/rule-map-os.test.ts` (Create — hermetic CLI shell-out, no server needed)

**Interfaces:**
- Consumes: `extractRule`, `normalizeOsList` from `../dist/rules/rule-extract` (the latter newly required).
- Produces: JSON records gain `os`, `osDependent`, `active`; new flags `--os <plat>`, `--os-dependent`, `--active`; mirror-dir scan (`~/.lm-assist/rules-mirror/<host>/`, source `repo:<host>`, active:false); `synced.<host>.*` live-dir detection (node/source rewrite).

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/rule-map-os.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const RULE_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'rule-map.js');
const DIST = path.join(__dirname, '..', '..', 'dist', 'rules', 'rule-extract.js');

function run(flags: string[], env: Record<string, string>): any {
  // rule-map.js requires ../dist/rules/rule-extract — needs ./core.sh build first.
  const out = execFileSync('node', [RULE_SCRIPT, ...flags, '--port', '1', '--format', 'json'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env } });
  return JSON.parse(out);
}

test('rule-map emits os/osDependent/active, detects synced.<host>.*, scans the mirror dir', (t) => {
  if (!fs.existsSync(DIST)) { t.skip('dist not built — run ./core.sh build'); return; }
  const CLAUDE = fs.mkdtempSync(path.join(os.tmpdir(), 'rmo-claude-'));
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rmo-data-'));
  const rulesDir = path.join(CLAUDE, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, 'own.md'), '---\nname: own\nos: ' + process.platform.replace('win32', 'windows').replace('darwin', 'mac') + '\n---\nbody');
  fs.writeFileSync(path.join(rulesDir, 'synced.host-a.shared.md'), '---\nname: shared\n---\nx'); // active, from host-a
  const mirror = path.join(DATA, 'rules-mirror', 'host-b');
  fs.mkdirSync(mirror, { recursive: true });
  fs.writeFileSync(path.join(mirror, 'winrule.md'), '---\nos: windows\n---\nW'); // inert

  const env = { CLAUDE_CONFIG_DIR: CLAUDE, LM_ASSIST_DATA_DIR: DATA };
  const all = run(['--scope', 'user'], env);
  const byFile = (f: string) => all.find((r: any) => r.file === f || (r.file || '').endsWith(f));

  const own = byFile('own.md');
  assert.ok(own, 'own rule present');
  assert.equal(own.active, true);          // os matches this platform
  assert.equal(own.osDependent, true);
  assert.equal(own.source, 'live');

  const synced = all.find((r: any) => /shared/.test(r.file));
  assert.ok(synced, 'synced rule present');
  assert.equal(synced.node, 'host-a');
  assert.equal(synced.source, 'repo:host-a'); // provenance from the synced.<host>. prefix

  const mir = all.find((r: any) => /winrule/.test(r.file));
  assert.ok(mir, 'mirror rule present');
  assert.equal(mir.node, 'host-b');
  assert.equal(mir.source, 'repo:host-b');
  assert.equal(mir.active, false);            // inert by location
  assert.deepEqual(mir.os, ['win32']);

  // --active filters out the inert mirror rule
  const activeOnly = run(['--scope', 'user', '--active'], env);
  assert.ok(!activeOnly.some((r: any) => /winrule/.test(r.file)), '--active hides inert mirror rule');
  // --os-dependent keeps only os-tagged rules
  const dep = run(['--scope', 'user', '--os-dependent'], env);
  assert.ok(!dep.some((r: any) => /shared/.test(r.file)), 'synced shared.md has no os: → excluded by --os-dependent');
  // --os windows matches the winrule + the always-on synced shared (os:[] applies to all)
  const winFiltered = run(['--scope', 'user', '--os', 'windows'], env);
  assert.ok(winFiltered.some((r: any) => /winrule/.test(r.file)), '--os windows includes the win rule');
  assert.ok(winFiltered.some((r: any) => /shared/.test(r.file)), '--os windows includes os:[] (all) rules');
});
```
This shells the REAL CLI with a hermetic `CLAUDE_CONFIG_DIR`/`LM_ASSIST_DATA_DIR` and `--port 1` (no server → `fetchProjects()` resolves `[]` on connect error, so the USER + mirror scans still run). It `t.skip`s if `dist/` is not built, so plain `npm test` never red-fails; the run command builds dist first.

- [ ] **Step 2: Run it, expect FAIL** — `./core.sh build && cd core && npm test 2>&1 | grep -A3 rule-map-os` (fails: records lack `os`/`active`; no `node:'host-a'`; mirror not scanned; flags unknown).

- [ ] **Step 3: implement** — edit `core/scripts/rule-map.js`:
  - Require change: `const { extractRule, normalizeOsList } = require(path.join(__dirname, '..', 'dist', 'rules', 'rule-extract'));`
  - Parse new flags (near the other `opt(...)`/`has(...)` lines):
```js
let fOs = opt('os');                         // platform filter (friendly or canonical)
if (fOs) { try { fOs = normalizeOsList([fOs])[0]; } catch {} }
const fOsDependent = has('os-dependent');
const fActive = has('active');
```
  - Extend `readRulesDir` to accept an options arg and honor it (signature → `readRulesDir(rootDir, node, source, project, scope, out, opts)`); inside the walk, replace the single `out.push(extractRule({...}))` with:
```js
        let rec;
        try { rec = extractRule({ node, project, source, scope, relpath, content, mtimeMs: st.mtimeMs, size: st.size }); } catch { continue; }
        if (opts && opts.detectSynced) {
          const m = path.basename(relpath).match(/^synced\.([A-Za-z0-9_-]+)\.(.+)$/);
          if (m) { rec = Object.assign({}, rec, { node: m[1], source: 'repo:' + m[1] }); }
        }
        if (opts && opts.forceInactive) rec = Object.assign({}, rec, { active: false });
        out.push(rec);
```
  - In `collect()`: pass `{ detectSynced: true }` to the USER `readRulesDir` call, and after the project loop add the mirror scan:
```js
  // Inert mirror of wrong-OS synced rules — rules-mirror/<host>/*.md (active:false, source repo:<host>).
  const dataDir = process.env.LM_ASSIST_DATA_DIR || path.join(home, '.lm-assist');
  const mirrorRoot = path.join(dataDir, 'rules-mirror');
  let mhosts; try { mhosts = fs.readdirSync(mirrorRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { mhosts = []; }
  for (const h of mhosts) {
    readRulesDir(path.join(mirrorRoot, h), h, 'repo:' + h, USER_PROJECT, 'user', recs, { forceInactive: true });
  }
```
  (Keep the existing project-rule `readRulesDir` calls passing no opts — they get `undefined`, which is fine.)
  - Filters in `match(r)` (append before `return true;`):
```js
  if (fOs && !((r.os || []).length === 0 || (r.os || []).includes(fOs))) return false;
  if (fOsDependent && !r.osDependent) return false;
  if (fActive && !r.active) return false;
```
  - Emit the new fields in the BRIEF JSON projection (the `level === 'complete' ? r : {...}` map at the bottom): add `os: r.os, osDependent: r.osDependent, active: r.active,` to the brief object literal. (Complete already returns the whole record.)
  - Stats (optional, additive): add `active: recs.filter(r => r.active).length, osDependent: recs.filter(r => r.osDependent).length,` to the `--stats` output object.
  - Update the header doc comment usage line to mention `[--os <plat>] [--os-dependent] [--active]`.

  Add the e2e cases to `core/scripts/__tests__/memory-rules-e2e.js` (after the existing TC-15/16 rule cases): a TC that writes `<home>/.claude/rules/e2e-os-windows.md` with `os: windows`, runs `RULE_SCRIPT ['--scope','user','--q','e2e-os']`, asserts the record has `os:["win32"]`, `osDependent:true`, and `active === (process.platform === 'win32')`; and a TC for `--active`/`--os-dependent` filter behavior. Revert the temp file in `finally` (match the existing cleanup pattern).

- [ ] **Step 4: run, expect PASS** — `./core.sh build && cd core && npm test 2>&1 | grep -E 'rule-map-os|fail'`. Live CLI e2e (optional, needs Core up): `./core.sh restart && node core/scripts/__tests__/memory-rules-e2e.js --port 3200`.

- [ ] **Step 5: Commit** —
```bash
git add core/scripts/rule-map.js core/scripts/__tests__/memory-rules-e2e.js core/src/__tests__/rule-map-os.test.ts
git commit -m "feat(rules): rule-map scans mirror dir + synced.<host>.*, emits os/active, adds --os/--active filters

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: MCP tools (`expanded.ts` + `configure.ts`)

**Files:**
- Modify: `core/src/mcp-server/tools/expanded.ts`, `core/src/mcp-server/configure.ts`
- Test: `core/src/__tests__/rule-mcp-tools.test.ts` (Create)

**Interfaces:** 5 new READ tools — all wired in `EXPANDED_TOOL_DEFS` + `EXPANDED_HANDLERS` + `TOOL_SCOPES('read')`, no explicit dispatch `case`:
- `rule_record(recordId)` → shell `rule-map.js --record <id>` (mirror `handleMemoryRecord`, swap script).
- `rule_sync_status()` → `workerGet('/rules/sync/status')` (mirror `handleMemorySyncStatus`, swap route + fallback to `getProjectSettings().ruleSyncEnabled`).
- `rule_cross_host(query)` → thin view: `rule-map.js --q <query> --level brief`, annotate each record with `presentLocally` (a `live`-source record with the same title exists) + pass through `active`.
- `rule_import_candidates(query?)` → records from other hosts (`source` starts `repo:`) with no local `live` record of the same title (preview).
- `rule_projects()` → `rule-map.js --stats` (scopes/hosts that have rule dirs).

None of the 5 take numeric args, so `numArg` coercion is not required here (the constraint still binds any future numeric param).

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/rule-mcp-tools.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPANDED_TOOL_DEFS, EXPANDED_HANDLERS } from '../mcp-server/tools/expanded';
import { assertScopesCoverTools, TOOL_SCOPES } from '../mcp-server/configure';

const NEW_TOOLS = ['rule_record', 'rule_sync_status', 'rule_cross_host', 'rule_import_candidates', 'rule_projects'];

test('each new rule tool is advertised, dispatchable, and scoped read', () => {
  for (const name of NEW_TOOLS) {
    assert.ok(EXPANDED_TOOL_DEFS.some((d: any) => d.name === name), `${name} in EXPANDED_TOOL_DEFS`);
    assert.equal(typeof EXPANDED_HANDLERS[name], 'function', `${name} in EXPANDED_HANDLERS`);
    assert.equal((TOOL_SCOPES as Record<string, string>)[name], 'read', `${name} scoped read`);
  }
});

test('rule_record requires a recordId', async () => {
  const r = await EXPANDED_HANDLERS['rule_record']({});
  assert.equal(r.isError, true);
});

test('rule_cross_host requires a query', async () => {
  const r = await EXPANDED_HANDLERS['rule_cross_host']({});
  assert.equal(r.isError, true);
});

test('assertScopesCoverTools does not throw (every advertised tool has a scope)', () => {
  assert.doesNotThrow(() => assertScopesCoverTools());
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd core && npm test 2>&1 | grep -A2 rule-mcp-tools` (tools not advertised; `assertScopesCoverTools` would throw if defs were added without scopes).

- [ ] **Step 3: implement** —

(a) In `core/src/mcp-server/tools/expanded.ts`, add the 5 tool DEFS (place after `ruleMapToolDef`):
```ts
export const ruleRecordToolDef = {
  name: 'rule_record',
  description:
    'Fetch one complete RULE record by its recordId (from rule_map output) — the full rule text ' +
    'plus its scope, os/active, and load condition. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: { recordId: { type: 'string', description: 'The record id from a prior rule_map result.' } },
    required: ['recordId'],
  },
};

export const ruleSyncStatusToolDef = {
  name: 'rule_sync_status',
  description:
    "Show this node's cross-node RULE-sync state: whether rule auto-sync is enabled, the node mode " +
    '(persistent vs ephemeral), and the live rule-autosync daemon status (mode + counts of ' +
    'reconciles/applied/removed/errors). Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const ruleCrossHostToolDef = {
  name: 'rule_cross_host',
  description:
    'Search USER rules across ALL hosts (this node\'s own rules plus every synced/mirrored peer rule), ' +
    'ranked by query, each tagged with `active` (applies to this OS) and `presentLocally` (this host ' +
    'authors an equivalent rule). Use for "what rule does any of my machines have about X". Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: { query: { type: 'string', description: 'Relevance query over rule title+brief+complete+paths.' } },
    required: ['query'],
  },
};

export const ruleImportCandidatesToolDef = {
  name: 'rule_import_candidates',
  description:
    'List rules from OTHER hosts (synced or inert mirror copies) that this host does not itself author — ' +
    'a preview of what auto-sync brings in (it usually already applied them). Optionally ranked by a ' +
    'query. Read-only (suggests; does not import).',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: { query: { type: 'string', description: 'Optional relevance query to rank candidates.' } },
  },
};

export const ruleProjectsToolDef = {
  name: 'rule_projects',
  description:
    'Summarize where rules live across the fleet — counts by host (node), scope (user/project), ' +
    'load condition, and category. The rules analog of memory_projects. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};
```
  Update `ruleMapToolDef.description` to mention the new dimension, e.g. append: `' Records carry os/osDependent/active and source (live vs repo:<host>); filter with scope, paths, always, os, os_dependent, active.'` (Optional new schema props `os`/`os_dependent`/`active` may be added to `ruleMapToolDef.inputSchema.properties` and forwarded in `handleRuleMap` — see (c).)

  Register them in `EXPANDED_TOOL_DEFS` (in the `// memory map + rules map (read ...)` group, after `ruleMapToolDef,`):
```ts
  ruleRecordToolDef,
  ruleSyncStatusToolDef,
  ruleCrossHostToolDef,
  ruleImportCandidatesToolDef,
  ruleProjectsToolDef,
```

(b) Add the handlers (after `handleRuleMap`):
```ts
async function handleRuleRecord(args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.recordId || '').trim();
  if (!id) return err('recordId is required.');
  try { return ok(await runCli([cliPath('rule-map.js'), '--port', apiPort(), '--record', id])); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}

async function handleRuleSyncStatus(): Promise<McpToolResult> {
  try {
    return ok(pretty(await workerGet('/rules/sync/status')));
  } catch {
    try {
      const { getProjectSettings } = await import('../../project-settings');
      return ok(pretty({ config: { ruleSyncEnabled: getProjectSettings().ruleSyncEnabled }, daemon: null, note: 'Core unreachable — on-disk setting only' }));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
}

/** Run rule-map.js and JSON-parse its record array (shared by the thin cross-host views). */
async function ruleMapRecords(extra: string[]): Promise<any[]> {
  const out = await runCli([cliPath('rule-map.js'), '--port', apiPort(), '--format', 'json', '--level', 'brief', ...extra]);
  try { const j = JSON.parse(out); return Array.isArray(j) ? j : []; } catch { return []; }
}

async function handleRuleCrossHost(args: Record<string, unknown>): Promise<McpToolResult> {
  const q = String(args.query || '').trim();
  if (!q) return err('query is required.');
  try {
    const recs = await ruleMapRecords(['--q', q]);
    const localTitles = new Set(recs.filter((r) => r.source === 'live').map((r) => String(r.title || '').toLowerCase()));
    const records = recs.map((r) => ({ ...r, presentLocally: localTitles.has(String(r.title || '').toLowerCase()) }));
    return ok(pretty({ query: q, total: records.length, records }));
  } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}

async function handleRuleImportCandidates(args: Record<string, unknown>): Promise<McpToolResult> {
  const q = String(args.query || '').trim();
  try {
    const recs = await ruleMapRecords(q ? ['--q', q] : []);
    const localTitles = new Set(recs.filter((r) => r.source === 'live').map((r) => String(r.title || '').toLowerCase()));
    const candidates = recs.filter((r) => typeof r.source === 'string' && r.source.startsWith('repo:') && !localTitles.has(String(r.title || '').toLowerCase()));
    return ok(pretty({ query: q || null, total: candidates.length, candidates }));
  } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}

async function handleRuleProjects(): Promise<McpToolResult> {
  try { return ok(await runCli([cliPath('rule-map.js'), '--port', apiPort(), '--format', 'json', '--stats'])); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
```
  (`runCli`, `cliPath`, `apiPort`, `ok`, `err`, `pretty`, `workerGet` all already exist in this file.)

  Register in `EXPANDED_HANDLERS` (in the `// memory map + rules map (read ...)` group, after `rule_map: handleRuleMap,`):
```ts
  rule_record: handleRuleRecord,
  rule_sync_status: () => handleRuleSyncStatus(),
  rule_cross_host: handleRuleCrossHost,
  rule_import_candidates: handleRuleImportCandidates,
  rule_projects: () => handleRuleProjects(),
```

(c) Optional `handleRuleMap` os filters (only if the new schema props were added to `ruleMapToolDef`): after the existing `if (args.always) argv.push('--always');` line add:
```ts
  if (args.os) argv.push('--os', String(args.os));
  if (args.os_dependent) argv.push('--os-dependent');
  if (args.active) argv.push('--active');
```

(d) In `core/src/mcp-server/configure.ts`, add to `TOOL_SCOPES` (after `rule_map: 'read',`):
```ts
  rule_record: 'read',
  rule_sync_status: 'read',
  rule_cross_host: 'read',
  rule_import_candidates: 'read',
  rule_projects: 'read',
```

- [ ] **Step 4: run, expect PASS** — `cd core && npm test 2>&1 | grep -E 'rule-mcp-tools|memory-sync-status-tool|fail'` (and the existing scopes-cover-tools test still green). `./core.sh build` to confirm the full tree compiles.

- [ ] **Step 5: Commit** —
```bash
git add core/src/mcp-server/tools/expanded.ts core/src/mcp-server/configure.ts core/src/__tests__/rule-mcp-tools.test.ts
git commit -m "feat(rules): 5 read-only rule MCP tools (record/sync_status/cross_host/import_candidates/projects)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (every §):**
- §1 `os:` dimension — Task 1 (`parseOs`/`normalizeOsList` mirror `parsePaths`; `os`/`osDependent`/`active` on `RuleRecord`; absent ⇒ `[]` ⇒ all platforms; unknown tokens kept verbatim).
- §2 placement-time activation (OS router) — Task 2 `routePlacement` + `applyIngest` (active `synced.<host>.*` vs inert `rules-mirror/<host>/`); byte-identical writes (`writeIfChanged` compares bytes, no banner); own export excludes `synced.*` (Task 2 `readOwnRules`).
- §3 daemon — Task 4 (own chokidar v3 watch excl `synced.*`; 5-min timer + on-change + 15s startup; pull-based, fleet-wide unfiltered `listFleetNodes`; tombstone-free set-diff removal via `applyIngest` sweep).
- §4 routes — Task 3 (`/rules/export|ingest|sync/status|autosync/status`; key-in-body auth mirror; `'/rules'` relay allow-list).
- §5 rule-map + MCP — Task 5 (mirror-dir scan + `synced.<host>.*` detection + `os`/`active` emit + `--os`/`--os-dependent`/`--active`) and Task 6 (5 read tools; `rule_map` desc updated; cross_host/import_candidates/projects are thin views over rule-map records).
- §6 settings & safety — Task 4 `ruleSyncEnabled` (default true) + live-apply; Task 2 basename/host sanitization, 64 KB cap, credential-name guard, never-clobber-hand-authored, fleet-wide (not cluster).
- §7 testing — unit (Tasks 1–4, 6) + CLI/e2e (Task 5).

**No placeholders:** every NEW rule-specific function (`parseOs`, `normalizeOsList`, `readOwnRules`, `sanitizeBasename`, `sanitizeHost`, `routePlacement`, `applyIngest`, the daemon, `pullRulesExport`, all 5 tool defs+handlers, every route handler) and every test is written out in full. Memory-parallel deltas are named explicitly (e.g. "mirror `memory/autosync.ts` `resolveMode`, swap `MEMORY_AUTOSYNC`→`RULE_AUTOSYNC`, `memorySyncEnabled`→`ruleSyncEnabled`").

**Type consistency across tasks:** `OwnRule`/`IngestRule`/`IngestResult` defined once in `rule-sync.ts` (Task 2) and consumed by the route (Task 3), the daemon + `pullRulesExport` (Task 4, via a type-only import that erases at compile so there is no CJS require cycle). The export route returns `{ host, platform, rules: OwnRule[] }` (spec §4); `pullRulesExport` reads `raw.rules` → `{ host, platform, rules }`, which `applyIngest(host, platform, rules, os.platform())` consumes — shapes line up end to end. `extractRule`'s new `os`/`osDependent`/`active` (Task 1) are surfaced unchanged by rule-map (Task 5) and the MCP thin views (Task 6).

**Constraints honored:** chokidar imported as v3 (`import chokidar, { FSWatcher }` + `chokidar.watch`); the 5 tools wire in exactly 3 places with `read` scopes (no `case`); synced files byte-identical (dedup-safe); ingest writes path-confined with defense-in-depth `path.dirname(resolve(dest))` checks; pull-only + fleet-wide; the 5 tools take no numeric args (numArg N/A but noted).

**One deviation from the spec's literal file list (intentional, minimal):** `pullRulesExport` + `rulesExportBody` are added to the existing `memory/mcp-transport.ts` rather than a new `rule-transport.ts` — faithful to the spec's "reuse mcp-transport," keeps all fleet transport in one module, and reuses its private `relayPost` + exported `listFleetNodes`. This changes no behavior or contract. (Everything else maps 1:1 onto the spec's File-structure list.)
