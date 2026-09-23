'use strict';
// End-to-end over the real bin: a sandboxed HOME + LM_ASSIST_DATA_DIR, so nothing touches the
// operator's ~/.claude.json or hub.json. Needs core/dist built (env -u API_PORT ./core.sh build).
const { test } = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', '..', 'bin', 'lm-assist.js');
const HUB_ENTRY = { type: 'http', url: 'https://mcp.langmart.ai/mcp', headers: { Authorization: 'Bearer sk-hub' } };

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-mcp-cli-'));
  const data = path.join(home, '.lm-assist');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'hub.json'), JSON.stringify({ hubUrl: 'wss://assist-api.langmart.ai', apiKey: 'sk-node' }));
  fs.writeFileSync(path.join(home, '.claude.json'),
    JSON.stringify({ userID: 'u1', mcpServers: { 'lm-assist-hub': HUB_ENTRY } }, null, 2));
  return home;
}
function run(home, ...argv) {
  return cp.spawnSync(process.execPath, [BIN, ...argv], {
    env: { ...process.env, HOME: home, USERPROFILE: home, LM_ASSIST_DATA_DIR: path.join(home, '.lm-assist') },
    encoding: 'utf8',
    timeout: 20000,
  });
}
const readCc = (home) => JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));

test('mcp add --profile basic writes lm-assist-basic over HTTP and leaves lm-assist-hub as it was', () => {
  const home = sandbox();
  const r = run(home, 'mcp', 'add', '--profile', 'basic');
  assert.strictEqual(r.status, 0, r.stderr);
  const cc = readCc(home);
  assert.deepStrictEqual(cc.mcpServers['lm-assist-basic'], {
    type: 'http', url: 'https://mcp.langmart.ai/mcp/basic', headers: { Authorization: 'Bearer sk-node' },
  });
  assert.deepStrictEqual(cc.mcpServers['lm-assist-hub'], HUB_ENTRY);
  assert.strictEqual(cc.userID, 'u1');
  assert.match(r.stdout, /costs MORE/);
});

test('mcp add --profile langmart --stdio writes lm-assist-platform with LM_MCP_PROFILE', () => {
  const home = sandbox();
  const r = run(home, 'mcp', 'add', '--profile', 'langmart', '--stdio');
  assert.strictEqual(r.status, 0, r.stderr);
  const e = readCc(home).mcpServers['lm-assist-platform'];
  assert.strictEqual(e.type, 'stdio');
  assert.strictEqual(e.command, 'node');
  // THIS checkout's server — not projectRoot's, which from a repo checkout resolves to the global
  // npm install (findNpmPackage), whose stdio server predates LM_MCP_PROFILE.
  assert.strictEqual(e.args[0], path.join(__dirname, '..', '..', 'core', 'dist', 'mcp-server', 'index.js'));
  assert.ok(fs.existsSync(e.args[0]), e.args[0]);
  assert.deepStrictEqual(e.env, { LM_MCP_PROFILE: 'platform' });
  assert.deepStrictEqual(readCc(home).mcpServers['lm-assist-hub'], HUB_ENTRY);
});

test('an unknown profile exits 1 and leaves ~/.claude.json untouched', () => {
  const home = sandbox();
  const before = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
  const r = run(home, 'mcp', 'add', '--profile', 'nope');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown profile "nope"/);
  assert.strictEqual(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), before);
});

test('mcp add without --profile explains the unpinned entries and writes nothing', () => {
  const home = sandbox();
  const before = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
  const r = run(home, 'mcp', 'add');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /lm-assist-hub/);
  assert.strictEqual(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), before);
});

test('mcp remove --profile basic removes only that entry; --profile hub is refused', () => {
  const home = sandbox();
  assert.strictEqual(run(home, 'mcp', 'add', '--profile', 'basic').status, 0);
  const r = run(home, 'mcp', 'remove', '--profile', 'basic');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(Object.keys(readCc(home).mcpServers), ['lm-assist-hub']);
  const h = run(home, 'mcp', 'remove', '--profile', 'hub');
  assert.strictEqual(h.status, 1);
  assert.match(h.stderr, /refusing/);
  assert.deepStrictEqual(readCc(home).mcpServers['lm-assist-hub'], HUB_ENTRY);
});

test('a ~/.claude.json that is not JSON is refused, not overwritten', () => {
  const home = sandbox();
  fs.writeFileSync(path.join(home, '.claude.json'), '{ not json');
  const r = run(home, 'mcp', 'add', '--profile', 'basic');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
  assert.strictEqual(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), '{ not json');
});

test('login --mcp-profile is validated BEFORE any enrollment work', () => {
  const home = sandbox();
  const bad = run(home, 'login', '--mcp-profile', 'nope');
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /unknown profile "nope"/);
  const clash = run(home, 'login', '--mcp-profile', 'basic', '--no-mcp');
  assert.strictEqual(clash.status, 1);
  assert.match(clash.stderr, /contradict/);
});
