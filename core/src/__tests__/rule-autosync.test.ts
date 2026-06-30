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

// ── F2: off→on lazy start ────────────────────────────────────────────────────

test('off→on lazy start: refreshMode() after disabled boot creates watcher+timer', () => {
  const CLAUDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-off2on-'));
  process.env.CLAUDE_CONFIG_DIR = CLAUDE;
  fs.mkdirSync(path.join(CLAUDE, 'rules'), { recursive: true });

  delete require.cache[require.resolve('../rules/autosync')];
  process.env.RULE_AUTOSYNC = 'off';
  const { RuleAutoSyncDaemon } = require('../rules/autosync');

  const d = new RuleAutoSyncDaemon({ mode: 'off' });
  d.start();
  assert.equal(d.getStatus().running, true, 'should be running after start()');
  assert.equal((d as any).watcher, null, 'off mode: no watcher');
  assert.equal((d as any).timer, null, 'off mode: no timer');

  // Switch mode to on and call refreshMode()
  process.env.RULE_AUTOSYNC = 'on';
  const newMode = d.refreshMode();
  assert.equal(newMode, 'on', 'refreshMode should return on');

  const hasWatcher = (d as any).watcher !== null;
  const hasTimer = (d as any).timer !== null;
  assert.ok(hasWatcher || hasTimer, 'watcher or timer must be created after off→on transition');

  // Cleanup
  if ((d as any).timer) clearInterval((d as any).timer);
  if ((d as any).watcher) { try { (d as any).watcher.close(); } catch { /* */ } }
  delete process.env.RULE_AUTOSYNC;
  delete process.env.CLAUDE_CONFIG_DIR;
});

test('on→off transition in refreshMode() tears down watcher+timer', () => {
  const CLAUDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-on2off-'));
  process.env.CLAUDE_CONFIG_DIR = CLAUDE;
  fs.mkdirSync(path.join(CLAUDE, 'rules'), { recursive: true });

  delete require.cache[require.resolve('../rules/autosync')];
  process.env.RULE_AUTOSYNC = 'on';
  const { RuleAutoSyncDaemon } = require('../rules/autosync');

  const d = new RuleAutoSyncDaemon({ mode: 'on' });
  d.start();
  assert.ok((d as any).timer !== null, 'on mode: timer created');

  process.env.RULE_AUTOSYNC = 'off';
  d.refreshMode();
  assert.equal((d as any).timer, null, 'timer torn down after on→off');
  assert.equal((d as any).watcher, null, 'watcher torn down after on→off');

  delete process.env.RULE_AUTOSYNC;
  delete process.env.CLAUDE_CONFIG_DIR;
});

// ── F3: single-flight guard on reconcile() ────────────────────────────────────

test('reconcile() is single-flight — concurrent calls coalesce', async () => {
  delete require.cache[require.resolve('../rules/autosync')];
  process.env.RULE_AUTOSYNC = 'on';
  const { RuleAutoSyncDaemon } = require('../rules/autosync');

  const transport = require('../memory/mcp-transport');
  const origList = transport.listFleetNodes;
  let listCallCount = 0;
  transport.listFleetNodes = async () => {
    listCallCount++;
    // simulate non-trivial async work so the guard is exercised
    await new Promise((r) => setTimeout(r, 30));
    return [];
  };
  const hubcfg = require('../hub-client/hub-config');
  const origCfg = hubcfg.getHubConfig;
  hubcfg.getHubConfig = () => ({ apiKey: 'sk-test', hubUrl: 'wss://h' });

  try {
    const d = new RuleAutoSyncDaemon({ mode: 'on' });
    // Launch 3 concurrent reconciles — only 1 should enter the real body
    await Promise.all([d.reconcile(), d.reconcile(), d.reconcile()]);
    assert.equal(listCallCount, 1, 'only one reconcile body should run (single-flight guard)');
  } finally {
    transport.listFleetNodes = origList;
    hubcfg.getHubConfig = origCfg;
    delete process.env.RULE_AUTOSYNC;
  }
});

test('/rules/sync/status route returns a real daemon status shape when daemon is present', async () => {
  process.env.RULE_AUTOSYNC = 'observe';
  delete require.cache[require.resolve('../rules/autosync')];
  // Ensure the daemon module is present (it is, since autosync.ts exists after Task 4).
  const { getRuleAutoSyncDaemon } = require('../rules/autosync');
  getRuleAutoSyncDaemon(); // ensure singleton is created
  const { createRuleSyncRoutes } = require('../routes/core/rule-sync.routes');
  const rts = createRuleSyncRoutes({} as any);
  const statusRoute = rts.find((r: any) => r.method === 'GET' && /sync.{1,3}status/.test(r.pattern.source));
  assert.ok(statusRoute, 'sync/status route not found');
  const result: any = await statusRoute.handler({} as any, {} as any);
  assert.equal(result.success, true, `expected success, got: ${JSON.stringify(result)}`);
  assert.ok(result.data.daemon, 'daemon field missing');
  assert.ok(['off', 'observe', 'on'].includes(result.data.daemon.mode), `unexpected mode: ${result.data.daemon.mode}`);
  assert.equal(typeof result.data.daemon.running, 'boolean');
  assert.ok(result.data.daemon.counts, 'counts field missing');
  delete process.env.RULE_AUTOSYNC;
});
