#!/usr/bin/env node
/**
 * Deploy verification — catches the class of bug that no in-process test can.
 *
 * Today `npm run build:test` (which builds dist-test, NOT dist) was mistaken for
 * a build, so a stale `dist` was deployed: source declared 23 gmail tools, the
 * running Core advertised 14, and every test passed because the tests run
 * against dist-test. Nothing in the repo could have caught it — the mismatch is
 * between SOURCE and what a RUNNING SERVER actually serves.
 *
 * Checks, all against the live MCP surface:
 *   1. source tool count      == compiled dist tool count
 *   2. compiled dist          == what the running Core advertises over tools/list
 *   3. every advertised name has a TOOL_SCOPES entry
 *   4. dist mtime is newer than the newest source file (stale-build canary)
 *
 * Exit non-zero on any mismatch, so it can gate a deploy.
 *
 * Usage: node verify-deploy.mjs [repoDir] [installDir] [port]
 */
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// .mjs has no require(); these dist files are CommonJS.
const require = createRequire(import.meta.url);

const REPO = process.argv[2] || '/home/yi/lm-assist-git';
const INSTALL = process.argv[3] || '/usr/lib/node_modules/lm-assist';
const PORT = process.argv[4] || '3100';

const fail = [];
const ok = [];

// ── 1. source vs compiled ───────────────────────────────────────────────────
const srcNames = (() => {
  const s = readFileSync(join(REPO, 'core/src/mcp-server/tools/gmail.ts'), 'utf8');
  const m = s.match(/export const GMAIL_TOOL_DEFS\s*=\s*\[([\s\S]*?)\]/);
  return m ? (m[1].match(/\w+ToolDef/g) || []).length : -1;
})();
const distNames = (() => {
  try {
    const mod = require(join(REPO, 'core/dist/mcp-server/tools/gmail.js'));
    return (mod.GMAIL_TOOL_DEFS || []).length;
  } catch (e) { return -1; }
})();
(srcNames === distNames && srcNames > 0 ? ok : fail).push(
  `source defs (${srcNames}) vs compiled dist (${distNames})`);

// ── 2. dist freshness (the actual bug: build:test != build) ─────────────────
const newest = (dir) => {
  let t = 0;
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p); else { const m = statSync(p).mtimeMs; if (m > t) t = m; } } };
  try { walk(dir); } catch {}
  return t;
};
const srcT = newest(join(REPO, 'core/src'));
const distT = newest(join(REPO, 'core/dist'));
(distT >= srcT ? ok : fail).push(
  `dist freshness: dist ${distT >= srcT ? 'newer than' : 'STALE vs'} src ` +
  `(src ${new Date(srcT).toISOString()}, dist ${new Date(distT).toISOString()})`);

// ── 3. installed copy matches the repo build ────────────────────────────────
const instCount = (() => {
  try { return (require(join(INSTALL, 'core/dist/mcp-server/tools/gmail.js')).GMAIL_TOOL_DEFS || []).length; }
  catch (e) { return -1; }
})();
(instCount > 0 && distNames > 0 && instCount === distNames ? ok : fail).push(
  `installed dist (${instCount}) vs repo dist (${distNames})`);

// ── 4. what the RUNNING server actually advertises ──────────────────────────
let advertised = -1, unscoped = [];
try {
  const key = readFileSync('/home/yi/.lm-assist/api-token', 'utf8').trim();
  // execFileSync with an ARG ARRAY, not a shell string: the API token must never
  // be interpolated into a command line where shell metacharacters could act on it.
  const raw = execFileSync('curl', [
    '-s', '--max-time', '60', '-X', 'POST',
    '-H', `x-api-key: ${key}`,
    '-H', 'Content-Type: application/json',
    '-H', 'Accept: application/json, text/event-stream',
    '-d', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    `http://127.0.0.1:${PORT}/mcp`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const buf = raw.split('\n').filter(l => l.trim() && !l.startsWith('event:'))
    .map(l => l.startsWith('data: ') ? l.slice(6) : l);
  const tools = JSON.parse(buf.join('\n')).result.tools;
  const gm = tools.filter(t => t.name.startsWith('gmail_'));
  advertised = gm.length;
  const scopes = readFileSync(join(REPO, 'core/src/mcp-server/configure.ts'), 'utf8');
  unscoped = gm.map(t => t.name).filter(n => !scopes.includes(`${n}:`));
} catch (e) { fail.push(`could not read live tools/list: ${String(e).slice(0, 90)}`); }

(advertised > 0 && distNames > 0 && advertised === distNames ? ok : fail).push(
  `LIVE advertised (${advertised}) vs compiled (${distNames})`);
(advertised > 0 && unscoped.length === 0 ? ok : fail).push(
  `every advertised tool has a TOOL_SCOPES entry${unscoped.length ? ' — MISSING: ' + unscoped.join(', ') : ''}`);

// ── 5. does the build actually TYPECHECK? ────────────────────────────────────
// MEASURED: tsconfig does NOT set noEmitOnError, so `tsc` writes JavaScript even
// when types are broken — a build can "succeed" and deploy code that does not
// compile. The only way to know is to ask separately.
try {
  execFileSync('npx', ['tsc', '--noEmit'], { cwd: join(REPO, 'core'), encoding: 'utf8', stdio: 'pipe' });
  ok.push('typecheck clean (tsc --noEmit)');
} catch (e) {
  const first = String(e.stdout || e.message).split('\n').filter(Boolean)[0] || 'unknown';
  fail.push(`TYPECHECK FAILS — build emits anyway (noEmitOnError unset): ${first.slice(0, 140)}`);
}

// ── report ──────────────────────────────────────────────────────────────────
console.log('DEPLOY VERIFICATION');
for (const o of ok) console.log('  PASS  ' + o);
for (const f of fail) console.log('  FAIL  ' + f);
console.log(`\n  ${fail.length ? 'FAILED' : 'OK'} — ${ok.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
