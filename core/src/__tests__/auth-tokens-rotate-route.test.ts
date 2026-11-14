/**
 * POST /auth/token/rotate (operator revoke-now) and GET /auth/check (the web server's
 * token verifier). Handlers are invoked directly; data dir = mkdtemp — never a live dir.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAuthTokensRoutes } from '../routes/core/auth-tokens.routes';
import type { ParsedRequest, RouteHandler } from '../routes/index';
import { apiTokenFilePath, currentApiToken, initApiToken, isValidToken, __resetApiTokenState } from '../auth/api-token';
import { mintScopedToken, __resetScopedTokens } from '../auth/scoped-token';
import { assistConfigPath } from '../auth/lan-access';

let dir = '';
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-rotate-route-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
});
beforeEach(() => {
  __resetApiTokenState();
  __resetScopedTokens();
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  initApiToken();
});
after(() => {
  __resetApiTokenState();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const routes: RouteHandler[] = createAuthTokensRoutes({} as never);
function route(method: string, p: string): RouteHandler {
  const r = routes.find((h) => h.method === method && h.pattern.test(p));
  assert.ok(r, `${method} ${p}`);
  return r as RouteHandler;
}
function req(over: Partial<ParsedRequest>): ParsedRequest {
  return { method: 'POST', path: '/auth/token/rotate', params: {}, query: {}, body: {}, headers: {}, clientIp: '127.0.0.1', ...over } as ParsedRequest;
}
const rotate = (over: Partial<ParsedRequest>) => route('POST', '/auth/token/rotate').handler(req(over), {} as never);
const check = (key?: string) =>
  route('GET', '/auth/check').handler(req({ method: 'GET', path: '/auth/check', headers: key === undefined ? {} : { 'x-api-key': key } }), {} as never);

test('rotate refuses an Origin, a forwarded request, a relayed request and a non-loopback caller', async () => {
  const before = currentApiToken();
  const cases: Array<[string, Partial<ParsedRequest>]> = [
    ['origin', { headers: { origin: 'http://localhost:3948' } }],
    ['forwarded', { headers: { 'x-forwarded-host': '' } }],
    ['x-forwarded-for', { headers: { 'x-forwarded-for': '10.0.0.9' } }],
    ['relayed', { headers: { 'x-relay-source': 'hub' } }],
    ['lan peer', { clientIp: '198.51.100.7' }],
  ];
  for (const [label, over] of cases) {
    const r = await rotate(over);
    assert.equal(r.success, false, label);
    assert.equal(r.httpStatus, 403, label);
    assert.equal(r.error.code, 'FORBIDDEN', label);
  }
  assert.equal(fs.readFileSync(apiTokenFilePath(), 'utf8').trim(), before, 'nothing rotated');
  assert.ok(isValidToken(before));
});

test('rotate succeeds for a clean loopback caller: old token dead, no secret in the response', async () => {
  const old = currentApiToken();
  fs.writeFileSync(assistConfigPath(), JSON.stringify({ lanAuthEnabled: true, lanAccessToken: 'e'.repeat(64) }));
  const r = await rotate({ body: { regenerateLanKey: true } });
  assert.equal(r.success, true);
  assert.equal(typeof r.data.rotatedAt, 'number');
  assert.ok(r.data.revokedCount >= 1);
  assert.equal(r.data.lanKeyRegenerated, true);
  const fresh = fs.readFileSync(apiTokenFilePath(), 'utf8').trim();
  const lan = JSON.parse(fs.readFileSync(assistConfigPath(), 'utf8')).lanAccessToken;
  const body = JSON.stringify(r);
  assert.equal(body.includes(old), false);
  assert.equal(body.includes(fresh), false);
  assert.equal(body.includes(lan), false);
  assert.equal(isValidToken(old), false);
  assert.ok(isValidToken(fresh));
});

test('/auth/check: current token → valid; garbage, missing or a scoped token → 401', async () => {
  const ok = await check(currentApiToken());
  assert.equal(ok.success, true);
  assert.deepEqual(ok.data, { valid: true });
  for (const k of ['garbage', '', undefined]) {
    const r = await check(k);
    assert.equal(r.success, false, String(k));
    assert.equal(r.httpStatus, 401);
    assert.equal(r.error.code, 'UNAUTHORIZED');
  }
  const scoped = mintScopedToken({ scope: 'claude-ai-chat' });
  const s = await check(scoped.token);
  assert.equal(s.httpStatus, 401, 'a scoped lmsc_ token never passes /auth/check');
});
