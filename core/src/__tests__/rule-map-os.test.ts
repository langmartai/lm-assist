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

test('rule-map attributes local rule to LM_HOST_ID when set', (t) => {
  if (!fs.existsSync(DIST)) { t.skip('dist not built — run ./core.sh build'); return; }
  const CLAUDE = fs.mkdtempSync(path.join(os.tmpdir(), 'rmo-hostid-'));
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rmo-hostid-data-'));
  const rulesDir = path.join(CLAUDE, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, 'own.md'), '---\nname: own\n---\nbody');

  const env = { CLAUDE_CONFIG_DIR: CLAUDE, LM_ASSIST_DATA_DIR: DATA, LM_HOST_ID: 'gw-test' };
  const all = run(['--scope', 'user'], env);
  const own = all.find((r: any) => (r.file || '').endsWith('own.md'));
  assert.ok(own, 'own rule present');
  assert.equal(own.node, 'gw-test', 'LM_HOST_ID should set the node label');
});
