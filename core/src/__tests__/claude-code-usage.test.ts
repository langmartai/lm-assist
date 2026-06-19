import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_CODE_USAGE_HANDLERS } from '../mcp-server/tools/claude-code-usage';

const realFetch = global.fetch;

function stubUsage(payload: unknown, ok = true): void {
  // @ts-expect-error test stub
  global.fetch = async () => {
    const env = ok ? { success: true, data: payload } : { success: false, error: { message: 'OAuth token expired' } };
    const text = JSON.stringify(env);
    return { ok, status: ok ? 200 : 401, async text() { return text; }, async json() { return env; } };
  };
}

afterEach(() => { global.fetch = realFetch; });

const SAMPLE = {
  extra_usage: { is_enabled: false },
  limits: [
    { kind: 'session', group: 'session', percent: 12, severity: 'normal', resets_at: '2026-06-19T21:00:00Z', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 38, severity: 'normal', resets_at: '2026-06-24T10:00:00Z', scope: null, is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: 18, severity: 'normal', resets_at: '2026-06-24T09:59:00Z', scope: { model: { display_name: 'Sonnet' } }, is_active: true },
  ],
};

test('claude_code_usage: lists each window with percent + reset', async () => {
  stubUsage(SAMPLE);
  const res = await CLAUDE_CODE_USAGE_HANDLERS.claude_code_usage({});
  const t = res.content[0].text;
  assert.notEqual(res.isError, true);
  assert.match(t, /session/i);
  assert.match(t, /12%/);
  assert.match(t, /38%/);
  assert.match(t, /Sonnet/);
  assert.match(t, /18%/);
});

test('claude_code_usage: a high/severe window is flagged', async () => {
  stubUsage({
    extra_usage: { is_enabled: false },
    limits: [{ kind: 'weekly_all', group: 'weekly', percent: 96, severity: 'warning', resets_at: '2026-06-24T10:00:00Z', scope: null, is_active: true }],
  });
  const res = await CLAUDE_CODE_USAGE_HANDLERS.claude_code_usage({});
  const t = res.content[0].text;
  assert.match(t, /96%/);
  assert.match(t, /warning|approaching|⚠/i, 'a non-normal severity must be visible');
});

test('claude_code_usage: an upstream OAuth failure is a clean error', async () => {
  stubUsage({}, false);
  const res = await CLAUDE_CODE_USAGE_HANDLERS.claude_code_usage({});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /OAuth token expired/);
});
