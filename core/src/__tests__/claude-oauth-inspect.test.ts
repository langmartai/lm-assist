/**
 * Claude Code OAuth credential inspection — the guard for the 2026-09 finding on
 * node 117: auth_status said "NOT PRESENT (no ~/.claude/.credentials.json
 * token)" while the file existed. Every failure mode collapsed to one null.
 * Now absent / unreadable / malformed / expired are distinct, and each names
 * the exact path it looked at.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inspectClaudeOAuth } from '../utils/claude-oauth';
import { renderClaudeCodeOAuth } from '../mcp-server/tools/auth-status';

const SKIP = process.platform === 'darwin';

function tmpFile(content: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-oauth-'));
  const p = path.join(dir, '.credentials.json');
  if (content !== null) fs.writeFileSync(p, content);
  return p;
}

const CURRENT_SHAPE = {
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-x', refreshToken: 'sk-ant-ort01-y', expiresAt: Date.now() + 3600_000,
    scopes: ['user:inference', 'user:profile'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x',
  },
  mcpOAuth: { 'github|abc': { serverName: 'github', accessToken: '' } },
  organizationUuid: '00000000-0000-0000-0000-000000000000',
};

test('current credentials.json shape (claudeAiOauth + mcpOAuth + organizationUuid) → ok, refreshable', { skip: SKIP }, () => {
  const p = tmpFile(JSON.stringify(CURRENT_SHAPE));
  const r = inspectClaudeOAuth(p, '/home/x');
  assert.equal(r.state, 'ok');
  assert.equal(r.refreshable, true);
  assert.equal(r.credsPath, p);
  assert.equal(r.home, '/home/x');
  assert.ok(typeof r.fileMtime === 'number');
  assert.deepEqual(r.fileKeys, ['claudeAiOauth', 'mcpOAuth', 'organizationUuid']);
  assert.equal(r.creds?.accessToken, 'sk-ant-oat01-x');
  assert.equal(r.creds?.subscriptionType, 'max');
});

test('missing file → ABSENT with the path (not "present:false" with no reason)', { skip: SKIP }, () => {
  const p = tmpFile(null);
  const r = inspectClaudeOAuth(p, '/home/x');
  assert.equal(r.state, 'absent');
  assert.equal(r.creds, null);
  assert.match(r.detail || '', new RegExp(p.replace(/[\\.]/g, '\\$&')));
});

test('half-written / non-JSON file → MALFORMED, never "absent"', { skip: SKIP }, () => {
  const p = tmpFile('{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x","refr');
  const r = inspectClaudeOAuth(p, '/home/x');
  assert.equal(r.state, 'malformed');
  assert.match(r.detail || '', /not valid JSON/);
});

test('JSON without a claudeAiOauth block → MALFORMED, listing the top-level keys (no values)', { skip: SKIP }, () => {
  const p = tmpFile(JSON.stringify({ mcpOAuth: {}, organizationUuid: 'u' }));
  const r = inspectClaudeOAuth(p, '/home/x');
  assert.equal(r.state, 'malformed');
  assert.match(r.detail || '', /no claudeAiOauth block/);
  assert.match(r.detail || '', /mcpOAuth, organizationUuid/);
  assert.doesNotMatch(r.detail || '', /sk-ant/);
});

test('accessToken without refreshToken → ok but NOT refreshable (was: reported as absent)', { skip: SKIP }, () => {
  const p = tmpFile(JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-x', expiresAt: Date.now() + 1000 } }));
  const r = inspectClaudeOAuth(p, '/home/x');
  assert.equal(r.state, 'ok');
  assert.equal(r.refreshable, false);
  assert.equal(r.creds?.refreshToken, '');
  assert.match(r.detail || '', /no refreshToken/);
});

// ── rendering: the tool text distinguishes the four problems ─────────────────

test('render: absent / unreadable / malformed / expired are four different lines, each naming the path', () => {
  const at = '/home/ubuntu/.claude/.credentials.json';
  const absent = renderClaudeCodeOAuth({ present: false, state: 'absent', credsPath: at, home: '/home/ubuntu' }).join('\n');
  assert.match(absent, /ABSENT/); assert.match(absent, /\/home\/ubuntu\/\.claude\/\.credentials\.json/); assert.match(absent, /home: \/home\/ubuntu/);
  const unreadable = renderClaudeCodeOAuth({ present: false, state: 'unreadable', credsPath: at, detail: 'EACCES: permission denied' }).join('\n');
  assert.match(unreadable, /UNREADABLE/); assert.match(unreadable, /EACCES/); assert.match(unreadable, /which user the Core runs as/);
  const malformed = renderClaudeCodeOAuth({ present: false, state: 'malformed', credsPath: at, detail: 'no claudeAiOauth block' }).join('\n');
  assert.match(malformed, /MALFORMED/); assert.match(malformed, /no claudeAiOauth block/);
  const expired = renderClaudeCodeOAuth({ present: true, state: 'ok', credsPath: at, expired: true, msUntilExpiry: -5 * 60_000, refreshable: true }).join('\n');
  assert.match(expired, /EXPIRED/); assert.match(expired, /5m ago/); assert.doesNotMatch(expired, /ABSENT|not present/i);
  const expiredNoRefresh = renderClaudeCodeOAuth({ present: true, state: 'ok', credsPath: at, expired: true, msUntilExpiry: -1000, refreshable: false }).join('\n');
  assert.match(expiredNoRefresh, /no refreshToken/);
});

test('render: an older Core that reports only present:false is NOT rendered as "absent"', () => {
  const t = renderClaudeCodeOAuth({ present: false }).join('\n');
  assert.doesNotMatch(t, /ABSENT/);
  assert.match(t, /reason not reported/);
});

test('render: valid token shows expiry, sub/tier, scopes and the file age', () => {
  const now = 1_000_000_000;
  const t = renderClaudeCodeOAuth({
    present: true, state: 'ok', credsPath: '/h/.claude/.credentials.json', expired: false, msUntilExpiry: 23 * 3600_000,
    subscriptionType: 'max', rateLimitTier: 'tier-4', scopes: ['user:inference'], fileMtime: now - 120_000, refreshable: true,
  }, now).join('\n');
  assert.match(t, /valid \(expires in 23h, sub=max, tier=tier-4\)/);
  assert.match(t, /scopes: user:inference/);
  assert.match(t, /written 2m ago/);
  assert.doesNotMatch(t, /no refreshToken/);
});
