/**
 * Runtime override composition — bootstrap/guide render override ?? default per doc,
 * LIVE via the shared content-overlay provider (design §4): override wins, null/absent
 * falls back byte-identically, UNKNOWN ids are ignored, blurb overrides reach the index,
 * provider failure fails OPEN to pure defaults. Uses the content-live test seam the same
 * way mcp-tool-overlay-live tests swap the shared tool overlay.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUIDE_HANDLERS } from '../mcp-server/tools/guide';
import type { ContentState } from '../mcp-server/registry/content-model';
import {
  sharedContentOverlay,
  _replaceSharedContentOverlayForTests,
  type ContentOverlayProvider,
} from '../mcp-server/registry/content-live';

// bootstrap is paged; concatenate ALL pages so a section-override assertion does not
// depend on which page the overridden section happens to land on.
const bootstrapText = async () => {
  const first = (await GUIDE_HANDLERS.bootstrap({})).content[0].text as string;
  const n = parseInt(first.match(/page 1 of (\d+)/i)?.[1] ?? '1', 10);
  const pages = [first];
  for (let p = 2; p <= n; p++) pages.push((await GUIDE_HANDLERS.bootstrap({ page: p })).content[0].text as string);
  return pages.join('\n');
};
const guideText = async (args: Record<string, unknown>) => ((await GUIDE_HANDLERS.guide(args)).content[0].text as string);

function fakeProvider(entries: Record<string, Partial<ContentState>>): ContentOverlayProvider {
  const map = new Map<string, ContentState>(
    Object.entries(entries).map(([k, v]) => [k, { contentOverride: v.contentOverride ?? null, blurbOverride: v.blurbOverride ?? null }]),
  );
  return { get: async () => map, invalidate: () => {} };
}

async function withProvider<T>(p: ContentOverlayProvider, fn: () => Promise<T>): Promise<T> {
  const prev = sharedContentOverlay();
  _replaceSharedContentOverlayForTests(p);
  try { return await fn(); } finally { _replaceSharedContentOverlayForTests(prev); }
}

test('guide(topic) serves the override when a doc has one', async () => {
  await withProvider(fakeProvider({ 'guide.data': { contentOverride: '# Guide: data — REWRITTEN BY REGISTRY' } }), async () => {
    const t = await guideText({ topic: 'data' });
    assert.equal(t, '# Guide: data — REWRITTEN BY REGISTRY');
  });
  // and the default is back the moment the override is gone (override ?? default per call)
  await withProvider(fakeProvider({}), async () => {
    assert.match(await guideText({ topic: 'data' }), /Guide: data service/);
  });
});

test('bootstrap composes section overrides + the bootstrap.header override, live', async () => {
  await withProvider(
    fakeProvider({
      'bootstrap.header': { contentOverride: '# CUSTOM BOOTSTRAP PREAMBLE (rev-managed)' },
      'guide.data': { contentOverride: '# Guide: data service — REWRITTEN' },
    }),
    async () => {
      const t = await bootstrapText();
      assert.match(t, /CUSTOM BOOTSTRAP PREAMBLE/);
      assert.match(t, /Guide: data service — REWRITTEN/);
      assert.ok(!t.includes('capability bootstrap (you have now loaded ALL use cases'), 'default header replaced');
      assert.ok(!t.includes('GOAL: store/retrieve structured records'), 'default data body replaced');
      // untouched sections still come from code
      assert.match(t, /Guide: orientation/);
      assert.match(t, /combination workflows/);
    },
  );
});

test('UNKNOWN doc ids are ignored — never rendered by guide or bootstrap', async () => {
  const junk = fakeProvider({
    'guide.zz-e2e-probe': { contentOverride: 'SCRATCH DOC MUST NEVER RENDER' },
    'bootstrap.nonsense': { contentOverride: 'ALSO NEVER RENDERED' },
  });
  const [bootWithJunk, guideIndexWithJunk] = await withProvider(junk, async () => [await bootstrapText(), await guideText({})]);
  const [bootClean, guideIndexClean] = await withProvider(fakeProvider({}), async () => [await bootstrapText(), await guideText({})]);
  assert.equal(bootWithJunk, bootClean, 'bootstrap byte-identical with junk overlay');
  assert.equal(guideIndexWithJunk, guideIndexClean, 'index byte-identical with junk overlay');
  await withProvider(junk, async () => {
    const t = await guideText({ topic: 'zz-e2e-probe' });
    assert.match(t, /No guide titled/, 'unknown topic still falls back to the index');
    assert.ok(!t.includes('SCRATCH DOC MUST NEVER RENDER'));
  });
});

test('guide.index override replaces the preamble; the topic list stays generated', async () => {
  await withProvider(fakeProvider({ 'guide.index': { contentOverride: '# CUSTOM INDEX RULES' } }), async () => {
    const t = await guideText({});
    assert.match(t, /^# CUSTOM INDEX RULES/);
    assert.match(t, /## Topics/);
    assert.match(t, /- `data`/, 'generated topic list survives');
    assert.ok(!t.includes('Golden rules'), 'default preamble replaced');
  });
});

test('blurbOverride reaches the generated index list without touching the body', async () => {
  await withProvider(fakeProvider({ 'guide.data': { blurbOverride: 'CUSTOM DATA ONE-LINER' } }), async () => {
    const idx = await guideText({});
    assert.match(idx, /- `data` — CUSTOM DATA ONE-LINER/);
    assert.match(await guideText({ topic: 'data' }), /Guide: data service/, 'body untouched');
  });
});

test('no overlay (null) and empty overlay render byte-identical pure defaults (fail-open)', async () => {
  const nullProvider: ContentOverlayProvider = { get: async () => null, invalidate: () => {} };
  const throwProvider: ContentOverlayProvider = { get: async () => { throw new Error('store down'); }, invalidate: () => {} };
  const viaNull = await withProvider(nullProvider, bootstrapText);
  const viaEmpty = await withProvider(fakeProvider({}), bootstrapText);
  const viaThrow = await withProvider(throwProvider, bootstrapText);
  assert.equal(viaNull, viaEmpty);
  assert.equal(viaNull, viaThrow, 'provider errors fail open to defaults');
  // and the composed default still satisfies the long-standing content contracts
  assert.match(viaNull, /capability bootstrap/i);
  assert.match(viaNull, /install & build lm-assist FROM THE REPO/);
});

test('handlers with the REAL shared provider + disabled data service serve pure defaults', async () => {
  // No provider swap here — this exercises the live provider → gated livePort path.
  // The settings gate must answer WITHOUT constructing the data service (dataset
  // watchers/fabric peer/sync engine): construction leaks open handles that keep this
  // bare test process alive forever — the cluster-guide hang the regression gate
  // caught. This test doubles as that canary: if construction returns, the suite hangs.
  const t = await guideText({ topic: 'data' });
  assert.match(t, /Guide: data service/);
  const b = await bootstrapText();
  assert.match(b, /capability bootstrap/i);
});

test('connectors topic keeps its dynamic fleet-identity prepend when overridden', async () => {
  await withProvider(fakeProvider({ 'guide.connectors': { contentOverride: '# Guide: connectors — SHORTENED' } }), async () => {
    const t = await guideText({ topic: 'connectors' });
    assert.match(t, /FLEET \/ CONNECTOR IDENTITY/, 'fleet identity block still prepended');
    assert.match(t, /SHORTENED/);
  });
});
