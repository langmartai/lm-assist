import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildCliArgs } from '../detached-runner';
import { BROWSER_TASK_HANDLERS } from '../mcp-server/tools/browser-task';

// ── plumbing: chrome flag reaches the CLI args ──────────────────────────────

test('buildCliArgs: chrome:true adds --chrome', () => {
  const args = buildCliArgs('do a thing', { chrome: true, permissionMode: 'bypassPermissions' } as never);
  assert.ok(args.includes('--chrome'), 'expected --chrome in CLI args');
  assert.ok(args.includes('--dangerously-skip-permissions'), 'chrome -p needs skip-permissions');
});

test('buildCliArgs: no chrome flag by default (agent_execute unaffected)', () => {
  const args = buildCliArgs('do a thing', {} as never);
  assert.ok(!args.includes('--chrome'), 'must not add --chrome unless requested');
});

// ── browser_task tool ───────────────────────────────────────────────────────

const realFetch = global.fetch;
let lastBody: Record<string, unknown> | null = null;

function stubExecute(resp: Record<string, unknown>): void {
  // @ts-expect-error test stub
  global.fetch = async (_url: string, opts?: { body?: string }) => {
    lastBody = opts?.body ? JSON.parse(opts.body) : null;
    const env = { success: true, data: resp };
    const text = JSON.stringify(env);
    return { ok: true, status: 200, async text() { return text; }, async json() { return env; } };
  };
}

afterEach(() => { global.fetch = realFetch; lastBody = null; });

test('browser_task: sends chrome + background + bypassPermissions and returns the executionId', async () => {
  stubExecute({ executionId: 'exec-77', status: 'started' });
  const res = await BROWSER_TASK_HANDLERS.browser_task({ prompt: 'go to example.com and read the title' });
  assert.notEqual(res.isError, true);
  assert.ok(lastBody, 'a request was made');
  assert.equal(lastBody!.chrome, true);
  assert.equal(lastBody!.background, true);
  assert.equal(lastBody!.permissionMode, 'bypassPermissions');
  assert.equal(lastBody!.prompt, 'go to example.com and read the title');
  assert.match(res.content[0].text, /exec-77/);
  assert.match(res.content[0].text, /get_execution/);
});

test('browser_task: requires a prompt', async () => {
  stubExecute({});
  const res = await BROWSER_TASK_HANDLERS.browser_task({});
  assert.equal(res.isError, true);
  assert.equal(lastBody, null, 'no request for an empty prompt');
});
