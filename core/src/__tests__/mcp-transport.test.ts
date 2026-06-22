import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyUrlPath, exportBody, ingestBody } from '../memory/mcp-transport';

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
