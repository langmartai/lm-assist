import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as claudeOauth from '../../utils/claude-oauth';
import { createCoworkTask, CoworkTaskError } from '../cowork-tasks';

// Repo convention for stubbing a boundary dependency in a node:test suite is
// to patch `global.fetch` (see ../../__tests__/claude-code-usage.test.ts,
// ../../__tests__/refresh-connector.test.ts). `cowork-tasks.ts`'s boundary is
// one level up — the named `anthropicOAuthPost` / `getOrganizationUuid`
// exports from `claude-oauth.ts` — because `getOrganizationUuid` itself goes
// through on-disk credential reads + a module-level memoization cache before
// ever touching the network, so stubbing `fetch` would require also faking
// valid credentials on disk and would leak state via that cache across tests.
// `mock.method` on the `require()`'d `claude-oauth` module object patches the
// exact property the commonjs-compiled call sites in `cowork-tasks.js` read
// (`claude_oauth_1.anthropicOAuthPost(...)`), so no source seam is needed.

const ORG_UUID = 'org-test-uuid';

/** Stub getOrganizationUuid to resolve instantly with a fixed org id. */
function stubOrg(): void {
  mock.method(claudeOauth, 'getOrganizationUuid', async () => ORG_UUID);
}

interface OAuthPostCall { pathname: string; body: any; opts: any; }

/**
 * Stub anthropicOAuthPost. `handler` is invoked per call (in order) and
 * returns `{ status, body }` for that call; calls are recorded for assertion.
 */
function stubPost(handler: (call: OAuthPostCall, index: number) => { status: number; body: any }): OAuthPostCall[] {
  const calls: OAuthPostCall[] = [];
  mock.method(claudeOauth, 'anthropicOAuthPost', async (pathname: string, body?: any, opts?: any) => {
    const call = { pathname, body, opts };
    calls.push(call);
    const { status, body: respBody } = handler(call, calls.length - 1);
    return { status, statusText: status >= 200 && status < 300 ? 'OK' : 'Error', headers: {}, body: respBody };
  });
  return calls;
}

afterEach(() => { mock.restoreAll(); });

// ── input validation ────────────────────────────────────────────────────────

test('createCoworkTask: empty prompt -> COWORK_BAD_REQUEST 400', async () => {
  await assert.rejects(createCoworkTask({ prompt: '' }), (err: unknown) => {
    assert.ok(err instanceof CoworkTaskError);
    assert.equal(err.code, 'COWORK_BAD_REQUEST');
    assert.equal(err.httpStatus, 400);
    return true;
  });
});

test('createCoworkTask: missing prompt -> COWORK_BAD_REQUEST 400', async () => {
  await assert.rejects(createCoworkTask({} as any), (err: unknown) => {
    assert.ok(err instanceof CoworkTaskError);
    assert.equal(err.code, 'COWORK_BAD_REQUEST');
    assert.equal(err.httpStatus, 400);
    return true;
  });
});

test('createCoworkTask: whitespace-only prompt -> COWORK_BAD_REQUEST 400', async () => {
  await assert.rejects(createCoworkTask({ prompt: '   ' }), (err: unknown) => {
    assert.ok(err instanceof CoworkTaskError);
    assert.equal(err.code, 'COWORK_BAD_REQUEST');
    return true;
  });
});

test('createCoworkTask: target local without environmentId -> COWORK_BAD_REQUEST 400', async () => {
  stubOrg();
  await assert.rejects(createCoworkTask({ prompt: 'hi', target: 'local' }), (err: unknown) => {
    assert.ok(err instanceof CoworkTaskError);
    assert.equal(err.code, 'COWORK_BAD_REQUEST');
    assert.equal(err.httpStatus, 400);
    return true;
  });
});

// ── target routing ──────────────────────────────────────────────────────────

test('createCoworkTask: cloud target uses the anthropic_cloud singleton environment id', async () => {
  stubOrg();
  const calls = stubPost((call, i) => (i === 0
    ? { status: 200, body: { session: { id: 'cse_ABCDEFGHIJKL', environment_kind: 'anthropic_cloud', status: 'starting' } } }
    : { status: 200, body: {} }));
  const result = await createCoworkTask({ prompt: 'hello world' });
  assert.equal(result.target, 'cloud');
  assert.equal(result.environmentId, 'env_011111111111111111111117');
  assert.equal(calls[0].body.environment_id, 'env_011111111111111111111117');
});

test('createCoworkTask: local target uses the passed environmentId', async () => {
  stubOrg();
  const calls = stubPost((call, i) => (i === 0
    ? { status: 200, body: { session: { id: 'cse_LOCAL0000001', environment_kind: 'bridge', status: 'starting' } } }
    : { status: 200, body: {} }));
  const result = await createCoworkTask({ prompt: 'hello', target: 'local', environmentId: 'env_bridge_42' });
  assert.equal(result.target, 'local');
  assert.equal(result.environmentId, 'env_bridge_42');
  assert.equal(calls[0].body.environment_id, 'env_bridge_42');
});

// ── defaults ─────────────────────────────────────────────────────────────────

test('createCoworkTask: defaults model=claude-sonnet-5, config.effort_level=medium', async () => {
  stubOrg();
  const calls = stubPost((call, i) => (i === 0
    ? { status: 200, body: { session: { id: 'cse_DEFAULTS0001', environment_kind: 'anthropic_cloud', status: 'starting' } } }
    : { status: 200, body: {} }));
  const result = await createCoworkTask({ prompt: 'plain task' });
  assert.equal(result.model, 'claude-sonnet-5');
  assert.equal(calls[0].body.config.model, 'claude-sonnet-5');
  assert.equal(calls[0].body.config.effort_level, 'medium');
});

test('createCoworkTask: title defaults to the prompt when <= 60 chars', async () => {
  stubOrg();
  const calls = stubPost((call, i) => (i === 0
    ? { status: 200, body: { session: { id: 'cse_TITLESHORT01', environment_kind: 'anthropic_cloud', status: 'starting' } } }
    : { status: 200, body: {} }));
  const prompt = 'short prompt under sixty chars';
  const result = await createCoworkTask({ prompt });
  assert.equal(result.title, prompt);
  assert.equal(calls[0].body.title, prompt);
});

test('createCoworkTask: title is truncated with an ellipsis when the prompt is over 60 chars', async () => {
  stubOrg();
  const calls = stubPost((call, i) => (i === 0
    ? { status: 200, body: { session: { id: 'cse_TITLELONG001', environment_kind: 'anthropic_cloud', status: 'starting' } } }
    : { status: 200, body: {} }));
  const prompt = 'x'.repeat(80);
  const result = await createCoworkTask({ prompt });
  assert.equal(result.title.length, 58); // 57 chars + '…'
  assert.ok(result.title.endsWith('…'));
  assert.equal(result.title, prompt.slice(0, 57) + '…');
  assert.equal(calls[0].body.title, result.title);
});

test('createCoworkTask: explicit title overrides the prompt-derived default', async () => {
  stubOrg();
  const calls = stubPost((call, i) => (i === 0
    ? { status: 200, body: { session: { id: 'cse_TITLEEXPL001', environment_kind: 'anthropic_cloud', status: 'starting' } } }
    : { status: 200, body: {} }));
  const result = await createCoworkTask({ prompt: 'hi', title: 'My Custom Title' });
  assert.equal(result.title, 'My Custom Title');
  assert.equal(calls[0].body.title, 'My Custom Title');
});

// ── happy path ───────────────────────────────────────────────────────────────

test('createCoworkTask: happy path returns sessionId + cowork url, and sends session_id derived from the cse id', async () => {
  stubOrg();
  const calls = stubPost((call, i) => (i === 0
    ? { status: 201, body: { session: { id: 'cse_ABCxyz789012', environment_kind: 'anthropic_cloud', status: 'starting' } } }
    : { status: 200, body: { accepted: true } }));
  const result = await createCoworkTask({ prompt: 'do the thing' });

  assert.equal(result.sessionId, 'cse_ABCxyz789012');
  assert.equal(result.url, 'https://claude.ai/cowork/cse_ABCxyz789012');
  assert.equal(result.target, 'cloud');
  assert.equal(result.environmentKind, 'anthropic_cloud');
  assert.equal(result.status, 'starting');
  assert.equal(result.warning, undefined);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].pathname, '/v1/code/sessions');
  assert.equal(calls[1].pathname, '/v1/code/sessions/cse_ABCxyz789012/events');
  const sentEvent = calls[1].body.events[0].payload;
  assert.equal(sentEvent.session_id, 'session_ABCxyz789012'); // 'session_' + id.slice(4)
  assert.equal(sentEvent.type, 'user');
  assert.equal(sentEvent.message.content, 'do the thing');
  assert.equal(sentEvent.parent_tool_use_id, null);
});

// ── create failures ──────────────────────────────────────────────────────────

test('createCoworkTask: create responds 400 -> COWORK_CREATE_FAILED 502', async () => {
  stubOrg();
  stubPost(() => ({ status: 400, body: { error: 'bad request upstream' } }));
  await assert.rejects(createCoworkTask({ prompt: 'hi' }), (err: unknown) => {
    assert.ok(err instanceof CoworkTaskError);
    assert.equal(err.code, 'COWORK_CREATE_FAILED');
    assert.equal(err.httpStatus, 502);
    return true;
  });
});

test('createCoworkTask: create responds 500 -> COWORK_CREATE_FAILED 502', async () => {
  stubOrg();
  stubPost(() => ({ status: 500, body: { error: 'internal' } }));
  await assert.rejects(createCoworkTask({ prompt: 'hi' }), (err: unknown) => {
    assert.ok(err instanceof CoworkTaskError);
    assert.equal(err.code, 'COWORK_CREATE_FAILED');
    assert.equal(err.httpStatus, 502);
    return true;
  });
});

test('createCoworkTask: create 2xx but session id is not cse_-prefixed -> COWORK_CREATE_FAILED (prefix guard)', async () => {
  stubOrg();
  stubPost(() => ({ status: 200, body: { session: { id: 'weird' } } }));
  await assert.rejects(createCoworkTask({ prompt: 'hi' }), (err: unknown) => {
    assert.ok(err instanceof CoworkTaskError);
    assert.equal(err.code, 'COWORK_CREATE_FAILED');
    assert.equal(err.httpStatus, 502);
    return true;
  });
});

test('createCoworkTask: create 2xx with missing session id entirely -> COWORK_CREATE_FAILED', async () => {
  stubOrg();
  stubPost(() => ({ status: 200, body: { session: {} } }));
  await assert.rejects(createCoworkTask({ prompt: 'hi' }), (err: unknown) => {
    assert.ok(err instanceof CoworkTaskError);
    assert.equal(err.code, 'COWORK_CREATE_FAILED');
    return true;
  });
});

// ── send failure (non-throwing warning path) ─────────────────────────────────

test('createCoworkTask: create ok but send fails -> resolves with warning + the real sessionId (no throw)', async () => {
  stubOrg();
  stubPost((call, i) => (i === 0
    ? { status: 200, body: { session: { id: 'cse_SENDFAIL0001', environment_kind: 'anthropic_cloud', status: 'starting' } } }
    : { status: 500, body: { error: 'send failed upstream' } }));
  const result = await createCoworkTask({ prompt: 'hi there' });
  assert.equal(result.sessionId, 'cse_SENDFAIL0001');
  assert.equal(result.url, 'https://claude.ai/cowork/cse_SENDFAIL0001');
  assert.ok(result.warning, 'warning should be set');
  assert.match(result.warning!, /prompt send failed/);
  assert.match(result.warning!, /500/);
});
