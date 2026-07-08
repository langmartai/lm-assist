import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyUrlPath, exportBody, ingestBody, mergeIngestBody, pullRulesExport, pullFromHome, slugsByRemote, pushToHome, pushMergeToPeer } from '../memory/mcp-transport';

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

// ---------------------------------------------------------------------------
// feat/memory-fabric: pullFromHome / slugsByRemote / pushToHome / pushMergeToPeer
// fabric-first, hub-fallback.
//
// Same monkey-patch-require()'d-exports convention as pullRulesExport above
// (these are plain functions, not a class like FabricPeerClient). global.fetch
// is stubbed per-function so the hub-fallback path (relayPost/relayGet) is
// fully exercised without a real network call. /memory/ingest (pushToHome,
// pushMergeToPeer) is the FIRST WRITE on a fabric fast-path — same eligibility
// gate (dataSyncViaFabric + fabricMemoryPeer) as the reads.
// ---------------------------------------------------------------------------

/** Generic fetch stub: serves a canned hub response for ANY relayPost/relayGet call
 *  made during the test, and counts calls. Mirrors stubHubFetch above but takes the
 *  full `{success,data}` envelope so it can be reused across all 4 functions'
 *  differently-shaped responses. */
function stubHubFetchGeneric(hubData: unknown): { readonly calls: number; restore: () => void } {
  const orig = global.fetch;
  let calls = 0;
  (global as any).fetch = async (_url: string, _init?: unknown) => {
    calls++;
    return {
      ok: true,
      json: async () => ({ success: true, data: hubData }),
    } as unknown as Response;
  };
  return {
    get calls() { return calls; },
    restore: () => { (global as any).fetch = orig; },
  };
}

/** Patches fabricMemoryPeer / getProjectSettings / fabricDataRequest on the SAME
 *  require()'d module objects mcp-transport.ts itself lazy-require()s, and returns
 *  a restore() that puts every patched export back. */
function patchMemoryFabric(opts: { eligiblePeer: boolean; dataSyncViaFabric: boolean; request: (node: string, init: { method: string; path: string; body?: unknown; query?: Record<string, string> }) => Promise<any> }): () => void {
  const fabricMod = require('../fabric');
  const settingsMod = require('../project-settings');
  const origPeer = fabricMod.fabricMemoryPeer;
  const origRequest = fabricMod.fabricDataRequest;
  const origSettings = settingsMod.getProjectSettings;
  fabricMod.fabricMemoryPeer = () => opts.eligiblePeer;
  settingsMod.getProjectSettings = () => ({ dataSyncViaFabric: opts.dataSyncViaFabric });
  fabricMod.fabricDataRequest = opts.request;
  return () => {
    fabricMod.fabricMemoryPeer = origPeer;
    fabricMod.fabricDataRequest = origRequest;
    settingsMod.getProjectSettings = origSettings;
  };
}

// --- pullFromHome --------------------------------------------------------

test('pullFromHome: eligible + fabric returns records -> parsed result, hub (fetch) NOT called', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ records: [{ file: 'hub.md', content: 'h', contentHash: 'hh' }] });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: true,
    dataSyncViaFabric: true,
    request: async (_node, init) => {
      assert.equal(init.method, 'POST');
      assert.equal(init.path, '/memory/export');
      return { status: 200, data: { records: [{ file: 'fab.md', content: 'f', contentHash: 'ff' }] } };
    },
  });
  try {
    const res = await pullFromHome('gw-home', 'proj', 0, 'KEY');
    assert.deepEqual(res, [{ file: 'fab.md', content: 'f', contentHash: 'ff' }]);
    assert.equal(fetchStub.calls, 0, 'hub relayPost (fetch) must not be called on the fabric-success path');
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('pullFromHome: eligible + fabric throws -> falls back to hub relayPost', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ records: [{ file: 'hub.md', content: 'h', contentHash: 'hh' }] });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: true,
    dataSyncViaFabric: true,
    request: async () => { throw new Error('fabric link dropped'); },
  });
  try {
    const res = await pullFromHome('gw-home', 'proj', 0, 'KEY');
    assert.deepEqual(res, [{ file: 'hub.md', content: 'h', contentHash: 'hh' }]);
    assert.equal(fetchStub.calls, 1);
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('pullFromHome: eligible + fabric app-error (status>=400) -> falls back to hub relayPost', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ records: [{ file: 'hub.md', content: 'h', contentHash: 'hh' }] });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: true,
    dataSyncViaFabric: true,
    request: async () => ({ status: 503, code: 'rpc_disabled', message: 'disabled' }),
  });
  try {
    const res = await pullFromHome('gw-home', 'proj', 0, 'KEY');
    assert.deepEqual(res, [{ file: 'hub.md', content: 'h', contentHash: 'hh' }]);
    assert.equal(fetchStub.calls, 1);
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('pullFromHome: ineligible (dataSyncViaFabric off) -> hub path only, fabric never called', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ records: [{ file: 'hub.md', content: 'h', contentHash: 'hh' }] });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: true,
    dataSyncViaFabric: false,
    request: async () => { throw new Error('must not be called'); },
  });
  try {
    const res = await pullFromHome('gw-home', 'proj', 0, 'KEY');
    assert.deepEqual(res, [{ file: 'hub.md', content: 'h', contentHash: 'hh' }]);
    assert.equal(fetchStub.calls, 1, 'hub relayPost (fetch) is the only path taken');
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('pullFromHome: ineligible (peer lacks the memory feature) -> hub path only, fabric never called', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ records: [{ file: 'hub.md', content: 'h', contentHash: 'hh' }] });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: false,
    dataSyncViaFabric: true,
    request: async () => { throw new Error('must not be called'); },
  });
  try {
    const res = await pullFromHome('gw-home', 'proj', 0, 'KEY');
    assert.deepEqual(res, [{ file: 'hub.md', content: 'h', contentHash: 'hh' }]);
    assert.equal(fetchStub.calls, 1, 'hub relayPost (fetch) is the only path taken');
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('pullFromHome: hub path returns [] when the peer response has no records array (unchanged existing contract)', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ records: null });
  try {
    const res = await pullFromHome('gw-home', 'proj', 0, 'KEY');
    assert.deepEqual(res, []);
  } finally {
    fetchStub.restore();
    restoreCfg();
  }
});

// --- slugsByRemote --------------------------------------------------------

test('slugsByRemote: eligible + fabric returns slugs -> parsed result, hub (fetch) NOT called', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ slugs: ['hub-slug'] });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: true,
    dataSyncViaFabric: true,
    request: async (_node, init) => {
      assert.equal(init.method, 'GET');
      assert.equal(init.path, '/memory/projects-by-remote');
      assert.deepEqual(init.query, { key: 'remote-key' });
      return { status: 200, data: { slugs: ['fab-slug'] } };
    },
  });
  try {
    const res = await slugsByRemote('gw-peer', 'remote-key');
    assert.deepEqual(res, ['fab-slug']);
    assert.equal(fetchStub.calls, 0, 'hub relayGet (fetch) must not be called on the fabric-success path');
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('slugsByRemote: eligible + fabric throws -> falls back to hub relayGet', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ slugs: ['hub-slug'] });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: true,
    dataSyncViaFabric: true,
    request: async () => { throw new Error('fabric link dropped'); },
  });
  try {
    const res = await slugsByRemote('gw-peer', 'remote-key');
    assert.deepEqual(res, ['hub-slug']);
    assert.equal(fetchStub.calls, 1);
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('slugsByRemote: eligible + fabric app-error (status>=400) -> falls back to hub relayGet', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ slugs: ['hub-slug'] });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: true,
    dataSyncViaFabric: true,
    request: async () => ({ status: 503, code: 'rpc_disabled', message: 'disabled' }),
  });
  try {
    const res = await slugsByRemote('gw-peer', 'remote-key');
    assert.deepEqual(res, ['hub-slug']);
    assert.equal(fetchStub.calls, 1);
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('slugsByRemote: ineligible (dataSyncViaFabric off) -> hub path only, fabric never called', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ slugs: ['hub-slug'] });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: true,
    dataSyncViaFabric: false,
    request: async () => { throw new Error('must not be called'); },
  });
  try {
    const res = await slugsByRemote('gw-peer', 'remote-key');
    assert.deepEqual(res, ['hub-slug']);
    assert.equal(fetchStub.calls, 1, 'hub relayGet (fetch) is the only path taken');
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('slugsByRemote: ineligible (peer lacks the memory feature) -> hub path only, fabric never called', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ slugs: ['hub-slug'] });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: false,
    dataSyncViaFabric: true,
    request: async () => { throw new Error('must not be called'); },
  });
  try {
    const res = await slugsByRemote('gw-peer', 'remote-key');
    assert.deepEqual(res, ['hub-slug']);
    assert.equal(fetchStub.calls, 1, 'hub relayGet (fetch) is the only path taken');
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('slugsByRemote: hub path returns [] when the peer response has no slugs array (unchanged existing contract)', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ slugs: null });
  try {
    const res = await slugsByRemote('gw-peer', 'remote-key');
    assert.deepEqual(res, []);
  } finally {
    fetchStub.restore();
    restoreCfg();
  }
});

// --- pushToHome (WRITE — /memory/ingest) ---------------------------------

test('pushToHome: eligible + fabric returns ingested count -> parsed result, hub (fetch) NOT called', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ ingested: 1 });
  const recs = [{ file: 'a.md', content: 'x', contentHash: 'h' }];
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: true,
    dataSyncViaFabric: true,
    request: async (_node, init) => {
      assert.equal(init.method, 'POST');
      assert.equal(init.path, '/memory/ingest');
      assert.deepEqual((init.body as any).records, recs);
      return { status: 200, data: { ingested: 3 } };
    },
  });
  try {
    const res = await pushToHome('gw-home', 'proj', 'gw-src', recs, 'KEY');
    assert.equal(res, 3);
    assert.equal(fetchStub.calls, 0, 'hub relayPost (fetch) must not be called on the fabric-success path');
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('pushToHome: eligible + fabric throws -> falls back to hub relayPost', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ ingested: 1 });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: true,
    dataSyncViaFabric: true,
    request: async () => { throw new Error('fabric link dropped'); },
  });
  try {
    const res = await pushToHome('gw-home', 'proj', 'gw-src', [{ file: 'a.md', content: 'x', contentHash: 'h' }], 'KEY');
    assert.equal(res, 1);
    assert.equal(fetchStub.calls, 1);
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('pushToHome: eligible + fabric app-error (status>=400) -> falls back to hub relayPost', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ ingested: 1 });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: true,
    dataSyncViaFabric: true,
    request: async () => ({ status: 400, code: 'invalid_input', message: 'bad project' }),
  });
  try {
    const res = await pushToHome('gw-home', 'proj', 'gw-src', [{ file: 'a.md', content: 'x', contentHash: 'h' }], 'KEY');
    assert.equal(res, 1);
    assert.equal(fetchStub.calls, 1);
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('pushToHome: ineligible (dataSyncViaFabric off) -> hub path only, fabric never called', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ ingested: 1 });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: true,
    dataSyncViaFabric: false,
    request: async () => { throw new Error('must not be called'); },
  });
  try {
    const res = await pushToHome('gw-home', 'proj', 'gw-src', [{ file: 'a.md', content: 'x', contentHash: 'h' }], 'KEY');
    assert.equal(res, 1);
    assert.equal(fetchStub.calls, 1, 'hub relayPost (fetch) is the only path taken');
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('pushToHome: ineligible (peer lacks the memory feature) -> hub path only, fabric never called', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ ingested: 1 });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: false,
    dataSyncViaFabric: true,
    request: async () => { throw new Error('must not be called'); },
  });
  try {
    const res = await pushToHome('gw-home', 'proj', 'gw-src', [{ file: 'a.md', content: 'x', contentHash: 'h' }], 'KEY');
    assert.equal(res, 1);
    assert.equal(fetchStub.calls, 1, 'hub relayPost (fetch) is the only path taken');
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('pushToHome: hub path returns 0 when the peer response has no numeric ingested (unchanged existing contract)', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ ingested: null });
  try {
    const res = await pushToHome('gw-home', 'proj', 'gw-src', [{ file: 'a.md', content: 'x', contentHash: 'h' }], 'KEY');
    assert.equal(res, 0);
  } finally {
    fetchStub.restore();
    restoreCfg();
  }
});

// --- pushMergeToPeer (WRITE — /memory/ingest, merge:true) ----------------

test('pushMergeToPeer: eligible + fabric returns merged -> parsed result, hub (fetch) NOT called', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ merged: { count: 1 } });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: true,
    dataSyncViaFabric: true,
    request: async (_node, init) => {
      assert.equal(init.method, 'POST');
      assert.equal(init.path, '/memory/ingest');
      assert.equal((init.body as any).merge, true);
      return { status: 200, data: { merged: { count: 3 } } };
    },
  });
  try {
    const res = await pushMergeToPeer('gw-peer', 'proj', 'gw-src', [{ file: 'a.md', content: 'x', contentHash: 'h' }], 'KEY');
    assert.deepEqual(res, { count: 3 });
    assert.equal(fetchStub.calls, 0, 'hub relayPost (fetch) must not be called on the fabric-success path');
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('pushMergeToPeer: eligible + fabric throws -> falls back to hub relayPost', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ merged: { count: 1 } });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: true,
    dataSyncViaFabric: true,
    request: async () => { throw new Error('fabric link dropped'); },
  });
  try {
    const res = await pushMergeToPeer('gw-peer', 'proj', 'gw-src', [{ file: 'a.md', content: 'x', contentHash: 'h' }], 'KEY');
    assert.deepEqual(res, { count: 1 });
    assert.equal(fetchStub.calls, 1);
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('pushMergeToPeer: eligible + fabric app-error (status>=400) -> falls back to hub relayPost', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ merged: { count: 1 } });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: true,
    dataSyncViaFabric: true,
    request: async () => ({ status: 400, code: 'invalid_input', message: 'unknown project' }),
  });
  try {
    const res = await pushMergeToPeer('gw-peer', 'proj', 'gw-src', [{ file: 'a.md', content: 'x', contentHash: 'h' }], 'KEY');
    assert.deepEqual(res, { count: 1 });
    assert.equal(fetchStub.calls, 1);
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('pushMergeToPeer: ineligible (dataSyncViaFabric off) -> hub path only, fabric never called', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ merged: { count: 1 } });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: true,
    dataSyncViaFabric: false,
    request: async () => { throw new Error('must not be called'); },
  });
  try {
    const res = await pushMergeToPeer('gw-peer', 'proj', 'gw-src', [{ file: 'a.md', content: 'x', contentHash: 'h' }], 'KEY');
    assert.deepEqual(res, { count: 1 });
    assert.equal(fetchStub.calls, 1, 'hub relayPost (fetch) is the only path taken');
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('pushMergeToPeer: ineligible (peer lacks the memory feature) -> hub path only, fabric never called', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ merged: { count: 1 } });
  const restoreFabric = patchMemoryFabric({
    eligiblePeer: false,
    dataSyncViaFabric: true,
    request: async () => { throw new Error('must not be called'); },
  });
  try {
    const res = await pushMergeToPeer('gw-peer', 'proj', 'gw-src', [{ file: 'a.md', content: 'x', contentHash: 'h' }], 'KEY');
    assert.deepEqual(res, { count: 1 });
    assert.equal(fetchStub.calls, 1, 'hub relayPost (fetch) is the only path taken');
  } finally {
    restoreFabric();
    fetchStub.restore();
    restoreCfg();
  }
});

test('pushMergeToPeer: hub path returns null when the peer response has no merged field (unchanged existing contract)', async () => {
  const restoreCfg = stubHubConfig({ hubUrl: 'wss://hub', apiKey: 'sk-test' });
  const fetchStub = stubHubFetchGeneric({ merged: null });
  try {
    const res = await pushMergeToPeer('gw-peer', 'proj', 'gw-src', [{ file: 'a.md', content: 'x', contentHash: 'h' }], 'KEY');
    assert.equal(res, null);
  } finally {
    fetchStub.restore();
    restoreCfg();
  }
});
