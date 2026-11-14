/**
 * The auto-approve REST routes refuse an auto-approve scope that names no tool.
 *
 * Always-approve removes the human approval gate. Both routes filter non-string entries out of
 * `tools`, so `tools: [7]` used to become `tools: []`, and `[]` used to read as "every tool the
 * connector lists". An empty or malformed scope must be refused loudly, never widened.
 */
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs = require('fs');
import os = require('os');
import path = require('path');

// The routes module creates its conversation cache dir at import: keep it off the real ~/.lm-assist.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-claudeai-cache-'));
process.env.LM_ASSIST_CLAUDEAI_CACHE_DIR = tmp;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createClaudeAIRoutes } = require('../routes/core/claude-ai.routes') as typeof import('../routes/core/claude-ai.routes');

const A = '8f61a74e-9d48-44b6-9ba0-a8d4873a86c2';
const routes = createClaudeAIRoutes({} as never);
function route(method: string, p: string) {
  const r = routes.find((x) => x.method === method && x.pattern.test(p));
  assert.ok(r, `no route for ${method} ${p}`);
  return (body: unknown) => r!.handler({ params: (p.match(r!.pattern)?.groups || {}) as Record<string, string>, body, query: {} } as never, undefined as never);
}

// Never read the real claude.ai cookie: a regression would reach setMcpToolsAutoApprove.
const realReadFileSync = fs.readFileSync;
function stubSession(): void {
  mock.method(fs, 'readFileSync', (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (typeof p === 'string' && p.endsWith('claudeai-session.json')) {
      return JSON.stringify({ cookie: 'lastActiveOrg=7cad1e03-e98e-42ca-8571-311a4ce74b8b; sessionKey=REDACTED' });
    }
    return (realReadFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  });
}

afterEach(() => { mock.restoreAll(); });

const BAD_SCOPES: unknown[] = [[], [7], [null, {}], 'elevated_exec', null, { 0: 'search' }];

test('POST /claude-ai/mcp/servers/:uuid/auto-approve refuses a scope that names no tool — before any upstream call', async () => {
  stubSession();
  const fetches: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string) => { fetches.push(String(url)); return new Response('{}', { status: 599 }); });
  const call = route('POST', `/claude-ai/mcp/servers/${A}/auto-approve`);
  for (const tools of BAD_SCOPES) {
    const res = (await call({ enable: true, tools })) as { success: boolean; error?: { code: string; message: string } };
    assert.equal(res.success, false, `tools=${JSON.stringify(tools)} was accepted`);
    assert.equal(res.error?.code, 'INVALID_INPUT', JSON.stringify(tools));
    assert.ok(res.error!.message.includes(JSON.stringify(tools)), 'the refusal echoes what was sent');
  }
  assert.deepEqual(fetches, [], 'nothing reached claude.ai');
});

test('POST /claude-ai/mcp/tool-settings/batch refuses a scope that names no tool — before any upstream call', async () => {
  stubSession();
  const fetches: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string) => { fetches.push(String(url)); return new Response('{}', { status: 599 }); });
  const call = route('POST', '/claude-ai/mcp/tool-settings/batch');
  for (const tools of BAD_SCOPES) {
    const res = (await call({ updates: [{ connectorUuid: A, autoApprove: { enable: true, tools } }] })) as {
      success: boolean; error?: { code: string };
    };
    assert.equal(res.success, false, `tools=${JSON.stringify(tools)} was accepted`);
    assert.equal(res.error?.code, 'INVALID_INPUT', JSON.stringify(tools));
  }
  assert.deepEqual(fetches, []);
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
