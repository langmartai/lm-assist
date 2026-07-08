import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyUrlPath, exportBody, ingestBody, mergeIngestBody, pullRulesExport } from '../memory/mcp-transport';

test('proxyUrlPath targets the hub machine-proxy for the peer Core endpoint', () => {
  assert.equal(
    proxyUrlPath('gw4-home', '/memory/export'),
    '/api/tier-agent/machines/gw4-home/proxy/memory/export',
  );
});

test('export body carries project, sinceMs and the key (key travels in BODY)', () => {
  const b = exportBody('p', 5, 'KEY');
  assert.equal(b.project, 'p');
  assert.equal(b.sinceMs, 5);
  assert.equal(b.key, 'KEY');
});

test('ingest body carries sourceHost, records and the key', () => {
  const recs = [{ file: 'a.md', content: 'x', contentHash: 'h' }];
  const b = ingestBody('p', 'gw-cloud', recs, 'KEY');
  assert.equal(b.project, 'p');
  assert.equal(b.sourceHost, 'gw-cloud');
  assert.deepEqual(b.records, recs);
  assert.equal(b.key, 'KEY');
});

test('mergeIngestBody sets merge:true (convergent peer push)', () => {
  const b = mergeIngestBody('p', 'gw-peer', [{ file: 'a.md', content: 'x', contentHash: 'h' }], 'KEY');
  assert.equal(b.merge, true);
  assert.equal(b.project, 'p');
  assert.equal(b.sourceHost, 'gw-peer');
  assert.equal(b.key, 'KEY');
});

// ---------------------------------------------------------------------------
// feat/rules-fabric: pullRulesExport fabric-first, hub-fallback.
//
// pullRulesExport lazily require()s '../fabric' and '../project-settings' —
// mirrors rule-autosync.test.ts's own convention of monkey-patching a
// require()'d module's (mutable, CommonJS) exports object directly, rather
// than constructor-injecting deps (pullRulesExport is a plain function, not a
// class like FabricPeerClient). global.fetch is stubbed so the hub-fallback
// path (relayPost) is fully exercised without a real network call, proving
// "falls back to hub" and "hub path unchanged" for real rather than by
// assertion alone.
// ---------------------------------------------------------------------------

function stubHubConfig(cfg: { hubUrl: string; apiKey: string }): () => void {
  const hubcfg = require('../hub-client/hub-config');
  const orig = hubcfg.getHubConfig;
  hubcfg.getHubConfig = () => cfg;
  return () => { hubcfg.getHubConfig = orig; };
}

/** Stub global.fetch to serve a canned hub /rules/export response, and count calls.
 *  `calls` is a live getter (NOT a value snapshot at call time) — callers read it
 *  AFTER exercising pullRulesExport, so it must reflect calls made in between. */
function stubHubFetch(hubRules: { host: string; platform: string; rules: unknown[] } | null): { readonly calls: number; restore: () => void } {
  const orig = global.fetch;
  let calls = 0;
  (global as any).fetch = async (_url: string, _init: unknown) => {
    calls++;
    return {
      ok: true,
      json: async () => ({ success: true, data: hubRules ?? { rules: null } }),
    } as unknown as Response;
  };
  return {
    get calls() { return calls; },
    restore: () => { (global as any).fetch = orig; },
  };
}

test('pullRulesExport: eligible + fabric returns rules -> parsed result, hub (fetch) NOT called', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetch({ host: 'hub-node', platform: 'linux', rules: [{ file: 'hub.md' }] });
  const fabricMod = require('../fabric');
  const settingsMod = require('../project-settings');
  const origEligible = fabricMod.fabricRulesPeer;
  const origRequest = fabricMod.fabricDataRequest;
  const origSettings = settingsMod.getProjectSettings;
  fabricMod.fabricRulesPeer = () => true;
  settingsMod.getProjectSettings = () => ({ dataSyncViaFabric: true });
  fabricMod.fabricDataRequest = async (_node: string, init: { method: string; path: string; body?: unknown }) => {
    assert.equal(init.method, 'POST');
    assert.equal(init.path, '/rules/export');
    return { status: 200, data: { host: 'fab-node', platform: 'darwin', rules: [{ file: 'fab.md' }] } };
  };
  try {
    const res = await pullRulesExport('gw-b', 'KEY');
    assert.deepEqual(res, { host: 'fab-node', platform: 'darwin', rules: [{ file: 'fab.md' }] });
    assert.equal(fetchStub.calls, 0, 'hub relayPost (fetch) must not be called on the fabric-success path');
  } finally {
    fabricMod.fabricRulesPeer = origEligible;
    fabricMod.fabricDataRequest = origRequest;
    settingsMod.getProjectSettings = origSettings;
    fetchStub.restore();
    restoreCfg();
  }
});

test('pullRulesExport: eligible + fabric throws -> falls back to hub relayPost', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetch({ host: 'hub-node', platform: 'linux', rules: [{ file: 'hub.md' }] });
  const fabricMod = require('../fabric');
  const settingsMod = require('../project-settings');
  const origEligible = fabricMod.fabricRulesPeer;
  const origRequest = fabricMod.fabricDataRequest;
  const origSettings = settingsMod.getProjectSettings;
  fabricMod.fabricRulesPeer = () => true;
  settingsMod.getProjectSettings = () => ({ dataSyncViaFabric: true });
  fabricMod.fabricDataRequest = async () => { throw new Error('fabric link dropped'); };
  try {
    const res = await pullRulesExport('gw-b', 'KEY');
    assert.deepEqual(res, { host: 'hub-node', platform: 'linux', rules: [{ file: 'hub.md' }] });
  } finally {
    fabricMod.fabricRulesPeer = origEligible;
    fabricMod.fabricDataRequest = origRequest;
    settingsMod.getProjectSettings = origSettings;
    fetchStub.restore();
    restoreCfg();
  }
});

test('pullRulesExport: eligible + fabric app-error (status>=400) -> falls back to hub relayPost', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetch({ host: 'hub-node', platform: 'linux', rules: [{ file: 'hub.md' }] });
  const fabricMod = require('../fabric');
  const settingsMod = require('../project-settings');
  const origEligible = fabricMod.fabricRulesPeer;
  const origRequest = fabricMod.fabricDataRequest;
  const origSettings = settingsMod.getProjectSettings;
  fabricMod.fabricRulesPeer = () => true;
  settingsMod.getProjectSettings = () => ({ dataSyncViaFabric: true });
  fabricMod.fabricDataRequest = async () => ({ status: 503, code: 'rpc_disabled', message: 'disabled' });
  try {
    const res = await pullRulesExport('gw-b', 'KEY');
    assert.deepEqual(res, { host: 'hub-node', platform: 'linux', rules: [{ file: 'hub.md' }] });
  } finally {
    fabricMod.fabricRulesPeer = origEligible;
    fabricMod.fabricDataRequest = origRequest;
    settingsMod.getProjectSettings = origSettings;
    fetchStub.restore();
    restoreCfg();
  }
});

test('pullRulesExport: ineligible (dataSyncViaFabric off) -> hub path only, fabric never called', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetch({ host: 'hub-node', platform: 'linux', rules: [{ file: 'hub.md' }] });
  const fabricMod = require('../fabric');
  const settingsMod = require('../project-settings');
  const origEligible = fabricMod.fabricRulesPeer;
  const origRequest = fabricMod.fabricDataRequest;
  const origSettings = settingsMod.getProjectSettings;
  fabricMod.fabricRulesPeer = () => true; // peer IS fabric-capable...
  settingsMod.getProjectSettings = () => ({ dataSyncViaFabric: false }); // ...but the opt-in gate is off
  fabricMod.fabricDataRequest = async () => { throw new Error('must not be called'); };
  try {
    const res = await pullRulesExport('gw-b', 'KEY');
    assert.deepEqual(res, { host: 'hub-node', platform: 'linux', rules: [{ file: 'hub.md' }] });
    assert.equal(fetchStub.calls, 1, 'hub relayPost (fetch) is the only path taken');
  } finally {
    fabricMod.fabricRulesPeer = origEligible;
    fabricMod.fabricDataRequest = origRequest;
    settingsMod.getProjectSettings = origSettings;
    fetchStub.restore();
    restoreCfg();
  }
});

test('pullRulesExport: ineligible (peer lacks the rules feature) -> hub path only, fabric never called', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetch({ host: 'hub-node', platform: 'linux', rules: [{ file: 'hub.md' }] });
  const fabricMod = require('../fabric');
  const settingsMod = require('../project-settings');
  const origEligible = fabricMod.fabricRulesPeer;
  const origRequest = fabricMod.fabricDataRequest;
  const origSettings = settingsMod.getProjectSettings;
  fabricMod.fabricRulesPeer = () => false; // dataSyncViaFabric on, but this peer never advertised 'rules'
  settingsMod.getProjectSettings = () => ({ dataSyncViaFabric: true });
  fabricMod.fabricDataRequest = async () => { throw new Error('must not be called'); };
  try {
    const res = await pullRulesExport('gw-b', 'KEY');
    assert.deepEqual(res, { host: 'hub-node', platform: 'linux', rules: [{ file: 'hub.md' }] });
    assert.equal(fetchStub.calls, 1, 'hub relayPost (fetch) is the only path taken');
  } finally {
    fabricMod.fabricRulesPeer = origEligible;
    fabricMod.fabricDataRequest = origRequest;
    settingsMod.getProjectSettings = origSettings;
    fetchStub.restore();
    restoreCfg();
  }
});

test('pullRulesExport: hub path returns null when the peer response has no rules array (unchanged existing contract)', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetch(null);
  try {
    const res = await pullRulesExport('gw-b', 'KEY');
    assert.equal(res, null);
  } finally {
    fetchStub.restore();
    restoreCfg();
  }
});
