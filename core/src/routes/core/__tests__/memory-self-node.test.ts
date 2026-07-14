import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRoutes } from '../memory.routes';
import type { ParsedRequest } from '../../index';

function req(): ParsedRequest {
  return { method: 'GET', path: '/memory/self-node', params: {}, query: {}, headers: {}, clientIp: '127.0.0.1' } as ParsedRequest;
}

test('GET /memory/self-node returns { node, platform } as non-empty strings', async () => {
  const route = createMemoryRoutes({} as any).find(
    r => r.method === 'GET' && /self-node/.test(r.pattern.source))!;
  assert.ok(route, 'route must be registered');
  const r: any = await route.handler(req(), {} as any);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(typeof r.data.node, 'string');
  assert.ok(r.data.node.length > 0, 'node must be non-empty');
  assert.equal(typeof r.data.platform, 'string');
  assert.ok(r.data.platform.length > 0, 'platform must be non-empty');
});

test('GET /memory/self-node platform matches os.platform() for this process', async () => {
  const os = await import('os');
  const route = createMemoryRoutes({} as any).find(
    r => r.method === 'GET' && /self-node/.test(r.pattern.source))!;
  const r: any = await route.handler(req(), {} as any);
  assert.equal(r.data.platform, os.platform());
});
