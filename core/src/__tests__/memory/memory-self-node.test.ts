import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRoutes, resolveHostIdFromHostsFile } from '../../routes/core/memory.routes';
import { resetMemoryCache } from '../../memory-cache';
import { stopSessionCache } from '../../session-cache';
import { resetProjectsService } from '../../projects-service';
import type { ParsedRequest } from '../../routes/index';

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

// ─── resolveHostIdFromHostsFile — pure scanner, port of memory-map.js's
// resolveMyHostId inner loop. These are the tests that give /memory/self-node
// its parity guarantee with memory-map.js's `liveNode` without needing a real
// _hosts.md fixture on disk. ─────────────────────────────────────────────

test('resolveHostIdFromHostsFile: backtick id line with matching IP -> id', () => {
  const text = [
    '# Hosts',
    '- `linux-117` — 10.0.1.117 (Ubuntu VM)',
    '- `windows-desk` — 10.0.1.107',
  ].join('\n');
  assert.equal(resolveHostIdFromHostsFile(text, ['10.0.1.117']), 'linux-117');
});

test('resolveHostIdFromHostsFile: table-row id line with matching IP -> id', () => {
  const text = [
    '| id | ip | notes |',
    '|---|---|---|',
    '| linux-123 | 10.0.1.123 | staging |',
    '| linux-117 | 10.0.1.117 | prod |',
  ].join('\n');
  assert.equal(resolveHostIdFromHostsFile(text, ['10.0.1.117']), 'linux-117');
});

test('resolveHostIdFromHostsFile: matching IP but no id token on that line -> null', () => {
  const text = [
    '# Hosts',
    '- 10.0.1.117 is this machine (no id markup here)',
  ].join('\n');
  assert.equal(resolveHostIdFromHostsFile(text, ['10.0.1.117']), null);
});

test('resolveHostIdFromHostsFile: id token present but no IP match -> null', () => {
  const text = [
    '# Hosts',
    '- `linux-117` — 10.0.1.117 (Ubuntu VM)',
  ].join('\n');
  assert.equal(resolveHostIdFromHostsFile(text, ['10.0.1.999']), null);
});

test('resolveHostIdFromHostsFile: empty/garbage text -> null', () => {
  assert.equal(resolveHostIdFromHostsFile('', ['10.0.1.117']), null);
  assert.equal(resolveHostIdFromHostsFile('   \n\n   not a hosts file at all   \n', ['10.0.1.117']), null);
});

test('resolveHostIdFromHostsFile: first matching line wins when multiple lines match', () => {
  const text = [
    '- `first-match` — 10.0.1.117',
    '- `second-match` — 10.0.1.117',
  ].join('\n');
  assert.equal(resolveHostIdFromHostsFile(text, ['10.0.1.117']), 'first-match');
});

// The route handler now calls getApi().listProjects() (to reproduce
// memory-map.js's liveNode chain), which opens the real MemoryCache
// (LMDB env + chokidar file watcher) via createMemoryApiImpl() — same
// long-lived-handle shape as core/src/__tests__/memory/memory-files-warnings.test.ts.
// Release it here or the process hangs on exit instead of returning
// control to node --test.
after(() => {
  resetMemoryCache();
  stopSessionCache();
  resetProjectsService();
});
