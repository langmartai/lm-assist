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

// ── ~/.claude.json is written atomically ────────────────────────────────────────────────────────
// `mcp add/remove` runs while Claude Code sessions are live; a truncate-then-write left a window
// of empty/partial JSON and, on a crash, a truncated file. tmp in the same dir + rename.

const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.lm-assist-') && n.endsWith('.tmp'));

test('mcp add writes ~/.claude.json atomically: owner-only, every other key kept, no temp file left', () => {
  const home = sandbox();
  const cc = path.join(home, '.claude.json');
  fs.chmodSync(cc, 0o644); // a pre-existing, group/world-readable file
  const before = fs.statSync(cc).ino;
  const r = run(home, 'mcp', 'add', '--profile', 'basic');
  assert.strictEqual(r.status, 0, r.stderr);
  const after = fs.statSync(cc);
  if (process.platform !== 'win32') {
    assert.strictEqual(after.mode & 0o777, 0o600, 'the file carries the node key: owner-only');
    assert.notStrictEqual(after.ino, before, 'replaced by rename, not truncated in place');
  }
  assert.deepStrictEqual(leftovers(home), []);
  const cfg = readCc(home);
  assert.strictEqual(cfg.userID, 'u1');
  assert.deepStrictEqual(cfg.mcpServers['lm-assist-hub'], HUB_ENTRY);
  assert.ok(cfg.mcpServers['lm-assist-basic']);
  assert.strictEqual(run(home, 'mcp', 'remove', '--profile', 'basic').status, 0);
  assert.deepStrictEqual(leftovers(home), []);
  assert.deepStrictEqual(Object.keys(readCc(home).mcpServers), ['lm-assist-hub']);
});

test('a symlinked ~/.claude.json (dotfiles) stays a symlink; its target gets the update', { skip: process.platform === 'win32' }, () => {
  const home = sandbox();
  const dots = path.join(home, 'dotfiles');
  fs.mkdirSync(dots);
  const target = path.join(dots, 'claude.json');
  fs.renameSync(path.join(home, '.claude.json'), target);
  fs.symlinkSync(target, path.join(home, '.claude.json'));
  const r = run(home, 'mcp', 'add', '--profile', 'basic');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.lstatSync(path.join(home, '.claude.json')).isSymbolicLink(), 'the link survives');
  assert.ok(JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers['lm-assist-basic'], 'the target was written');
  assert.deepStrictEqual(leftovers(dots), []);
});

// ── login --mcp-profile, against a stubbed Core (fetch preloaded — no port, no network) ─────────

function loginStub(home, authenticated) {
  const stub = path.join(home, 'fetch-stub.js');
  fs.writeFileSync(stub, `
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (!u.startsWith('http://localhost:3100/')) throw new Error('unexpected network call in test: ' + u);
      if (u.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      if (u.endsWith('/hub/login') && init.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { connected: true, authenticated: ${authenticated} } }) };
      }
      throw new Error('unexpected route in test: ' + u);
    };`);
  return stub;
}
function runWithStub(home, stub, ...argv) {
  return cp.spawnSync(process.execPath, ['--require', stub, BIN, ...argv], {
    env: { ...process.env, HOME: home, USERPROFILE: home, LM_ASSIST_DATA_DIR: path.join(home, '.lm-assist') },
    encoding: 'utf8',
    timeout: 20000,
  });
}

test('login --mcp-profile while authentication is PENDING says the entry was not written, and how to add it', () => {
  const home = sandbox();
  const before = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
  const r = runWithStub(home, loginStub(home, false), 'login', 'lmkp_test', '--mcp-profile', 'basic');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /authentication pending/);
  assert.match(r.stderr, /'--mcp-profile basic' not written — the node is not authenticated yet/);
  assert.match(r.stderr, /lm-assist mcp add --profile basic/);
  assert.strictEqual(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), before, 'nothing written');
});

test('login --mcp-profile once authenticated writes lm-assist-hub AND lm-assist-<profile> in one atomic write', () => {
  const home = sandbox();
  const r = runWithStub(home, loginStub(home, true), 'login', 'lmkp_test', '--mcp-profile', 'basic');
  assert.strictEqual(r.status, 0, r.stderr);
  const cfg = readCc(home);
  assert.deepStrictEqual(cfg.mcpServers['lm-assist-basic'], {
    type: 'http', url: 'https://mcp.langmart.ai/mcp/basic', headers: { Authorization: 'Bearer sk-node' },
  });
  assert.strictEqual(cfg.mcpServers['lm-assist-hub'].url, 'https://mcp.langmart.ai/mcp', 'lm-assist-hub is never re-pinned');
  assert.strictEqual(cfg.userID, 'u1');
  assert.deepStrictEqual(leftovers(home), []);
  assert.doesNotMatch(r.stderr, /not written/);
});

// ── an older fallback helper module is a message, not a TypeError ───────────────────────────────

test('missingProfileHelpers: an old helper module (pre --profile) is named, the built one passes', () => {
  const prev = process.env.LM_ASSIST_NO_RUN;
  process.env.LM_ASSIST_NO_RUN = '1';
  try {
    delete require.cache[require.resolve(BIN)];
    const { missingProfileHelpers } = require(BIN);
    const old = { deriveHubMcpUrl: () => null, upsertHubMcpServer: () => ({}), HUB_MCP_SERVER_NAME: 'lm-assist-hub' };
    assert.deepStrictEqual(missingProfileHelpers(old), [
      'parseMcpCliArgs', 'resolveEntryProfile', 'readFlagValue', 'profileRequiredMessage',
      'upsertProfileMcpServer', 'removeProfileMcpServer',
    ]);
    const built = require(path.join(__dirname, '..', '..', 'core', 'dist', 'utils', 'claude-mcp-config.js'));
    assert.deepStrictEqual(missingProfileHelpers(built), []);
  } finally {
    if (prev === undefined) delete process.env.LM_ASSIST_NO_RUN; else process.env.LM_ASSIST_NO_RUN = prev;
  }
});
