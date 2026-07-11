import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMachineAccessRoutes } from '../routes/core/machine-access.routes';
import type { ParsedRequest, RouteHandler } from '../routes/index';

const routes: RouteHandler[] = createMachineAccessRoutes({} as never);

function findRoute(method: string, samplePath: string): RouteHandler {
  const r = routes.find((h) => h.method === method && h.pattern.test(samplePath));
  assert.ok(r, `route ${method} ${samplePath} not found`);
  return r as RouteHandler;
}

function req(method: string, reqPath: string, over: Partial<ParsedRequest> = {}): ParsedRequest {
  const r = findRoute(method, reqPath);
  const match = r.pattern.exec(reqPath);
  return {
    method,
    path: reqPath,
    params: (match?.groups as Record<string, string>) || {},
    query: {},
    body: undefined,
    clientIp: '127.0.0.1',
    ...over,
  } as ParsedRequest;
}

const PROFILE = {
  id: 'yitest',
  name: 'yitest VM',
  access: [{ type: 'ssh', host: '10.0.1.123', user: 'yi', identityFile: '~/.ssh/ssh-keys/id_rsa' }],
};

describe('machine-access routes', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-routes-'));
    process.env.LM_MACHINE_ACCESS_FILE = path.join(dir, 'machine-access.json');
  });
  after(() => { delete process.env.LM_MACHINE_ACCESS_FILE; });

  it('PUT rejects non-loopback callers', async () => {
    const h = findRoute('PUT', '/machine-access/machines/yitest');
    const res = await h.handler(req('PUT', '/machine-access/machines/yitest', { clientIp: '10.0.0.5', body: PROFILE }), {} as never);
    assert.equal(res.success, false);
    assert.equal(res.error?.code, 'FORBIDDEN');
  });

  it('DELETE rejects non-loopback callers', async () => {
    const h = findRoute('DELETE', '/machine-access/machines/yitest');
    const res = await h.handler(req('DELETE', '/machine-access/machines/yitest', { clientIp: '203.0.113.9' }), {} as never);
    assert.equal(res.success, false);
    assert.equal(res.error?.code, 'FORBIDDEN');
  });

  it('loopback PUT upserts (path id wins) and GET reports with derived command', async () => {
    const put = findRoute('PUT', '/machine-access/machines/yitest');
    const created = await put.handler(req('PUT', '/machine-access/machines/yitest', { body: { ...PROFILE, id: 'ignored' } }), {} as never);
    assert.equal(created.success, true);
    assert.equal((created.data as { machine: { id: string } }).machine.id, 'yitest');

    const get = findRoute('GET', '/machine-access');
    const rep = await get.handler(req('GET', '/machine-access'), {} as never);
    assert.equal(rep.success, true);
    const data = rep.data as {
      count: number;
      machines: Array<{ access: Array<{ command?: string }> }>;
      node: { hostname: string };
      usage: string;
    };
    assert.equal(data.count, 1);
    assert.equal(data.machines[0].access[0].command, 'ssh -i ~/.ssh/ssh-keys/id_rsa yi@10.0.1.123');
    assert.ok(typeof data.node.hostname === 'string' && data.node.hostname.length > 0);
    assert.match(data.usage, /NODE-LOCAL/);
  });

  it('PUT with invalid body → INVALID_INPUT', async () => {
    const put = findRoute('PUT', '/machine-access/machines/bad');
    const res = await put.handler(req('PUT', '/machine-access/machines/bad', { body: { name: 'x', access: [] } }), {} as never);
    assert.equal(res.success, false);
    assert.equal(res.error?.code, 'INVALID_INPUT');
  });

  it('DELETE removes and reports removed:false for unknown id', async () => {
    const del = findRoute('DELETE', '/machine-access/machines/yitest');
    const res1 = await del.handler(req('DELETE', '/machine-access/machines/yitest'), {} as never);
    assert.equal((res1.data as { removed: boolean }).removed, true);
    const res2 = await del.handler(req('DELETE', '/machine-access/machines/yitest'), {} as never);
    assert.equal((res2.data as { removed: boolean }).removed, false);
  });
});
