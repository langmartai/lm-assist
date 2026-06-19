import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_CODE_ACCOUNT_HANDLERS } from '../mcp-server/tools/claude-code-account';
import { CLAUDEAI_ACCOUNT_HANDLERS } from '../mcp-server/tools/claudeai-account';

const realFetch = global.fetch;
function routeStub(map: (url: string) => unknown): void {
  // @ts-expect-error stub
  global.fetch = async (url: string) => {
    const data = map(String(url));
    const env = data === undefined ? { success: false, error: { message: 'not found' } } : { success: true, data };
    const text = JSON.stringify(env);
    return { ok: data !== undefined, status: data !== undefined ? 200 : 404, async text() { return text; }, async json() { return env; } };
  };
}
afterEach(() => { global.fetch = realFetch; });

test('claude_code_account: shows identity, plan, org, role, policy', async () => {
  routeStub((u) => {
    if (u.includes('/claude-code/profile')) return { account: { full_name: 'databunny', email: 'yi@x.sg', has_claude_max: true }, organization: { name: "yi's Org", organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x', subscription_status: 'active', has_extra_usage_enabled: false } };
    if (u.includes('/claude-code/roles')) return { organization_role: 'admin', workspace_role: null };
    if (u.includes('/claude-code/policy-limits')) return { restrictions: { foo: { allowed: false } }, compliance_taints: [] };
    return undefined;
  });
  const t = (await CLAUDE_CODE_ACCOUNT_HANDLERS.claude_code_account({})).content[0].text;
  assert.match(t, /yi@x\.sg/);
  assert.match(t, /Max/);
  assert.match(t, /admin/);
  assert.match(t, /default_claude_max_20x/);
  assert.match(t, /taint/i);
});

test('claude_code_account: a failing sub-call degrades, not crashes', async () => {
  routeStub((u) => (u.includes('/claude-code/profile') ? { account: { email: 'a@b.c', has_claude_pro: true } } : undefined));
  const res = await CLAUDE_CODE_ACCOUNT_HANDLERS.claude_code_account({});
  assert.notEqual(res.isError, true);
  assert.match(res.content[0].text, /a@b\.c/);
});

test('claudeai_account: shows org + subscription, no card details', async () => {
  routeStub((u) => {
    if (u.endsWith('/claude-ai/org')) return { uuid: '7cad', name: "yi's Organization", settings: { claude_code_penguin_mode_enabled: true, claude_code_routines_enabled: null } };
    if (u.includes('/claude-ai/org/subscription')) return { status: 'active', billing_interval: 'monthly', next_charge_date: '2026-06-23', payment_method: { last4: '2927', brand: 'mastercard' } };
    return undefined;
  });
  const t = (await CLAUDEAI_ACCOUNT_HANDLERS.claudeai_account({})).content[0].text;
  assert.match(t, /yi's Organization/);
  assert.match(t, /active/);
  assert.match(t, /monthly/);
  assert.match(t, /2026-06-23/);
  assert.doesNotMatch(t, /2927/, 'must not leak card last4');
});
