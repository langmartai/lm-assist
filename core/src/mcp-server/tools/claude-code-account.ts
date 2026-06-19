/**
 * claude_code_account MCP tool — the Claude Code OAuth account picture (NO
 * secrets): identity + plan/tier (/claude-code/profile), org role
 * (/claude-code/roles), and policy limits (/claude-code/policy-limits).
 * Completes the Claude Code account trio next to auth_status (token validity)
 * and claude_code_usage (quota). Registered in EXPANDED_TOOL_DEFS +
 * EXPANDED_HANDLERS; scoped read in configure.ts.
 */
import { ok, workerGet, type McpToolResult } from './_passthrough';

export const claudeCodeAccountToolDef = {
  name: 'claude_code_account',
  description:
    'Show the Claude Code OAuth account (NO secrets) — who you are, plan/tier, org + ' +
    'role, and policy limits. Trigger words: "my claude code account", "what plan am I ' +
    'on", "my org", "am I admin", "claude code profile", "rate-limit tier", "policy ' +
    'limits", "compliance". Pairs with `auth_status` (token validity) and ' +
    '`claude_code_usage` (quota left). Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const CLAUDE_CODE_ACCOUNT_TOOL_DEFS = [claudeCodeAccountToolDef] as const;

interface Profile {
  account?: { full_name?: string; email?: string; has_claude_max?: boolean; has_claude_pro?: boolean };
  organization?: { name?: string; organization_type?: string; rate_limit_tier?: string; billing_type?: string; subscription_status?: string; has_extra_usage_enabled?: boolean };
}
interface Roles { organization_role?: string; workspace_role?: string | null }
interface Policy { restrictions?: Record<string, { allowed?: boolean }>; compliance_taints?: unknown[] }

async function handleClaudeCodeAccount(_args: Record<string, unknown> = {}): Promise<McpToolResult> {
  const lines: string[] = [];
  try {
    const p = await workerGet<Profile>('/claude-code/profile');
    const a = p.account || {};
    const o = p.organization || {};
    const plan = a.has_claude_max ? 'Max' : a.has_claude_pro ? 'Pro' : 'free';
    lines.push(`Claude Code account: ${a.full_name || '?'} <${a.email || '?'}> — ${plan}`);
    if (o.name) lines.push(`  org: ${o.name}${o.organization_type ? ` (${o.organization_type})` : ''}${o.rate_limit_tier ? `, tier ${o.rate_limit_tier}` : ''}`);
    const sub = [o.subscription_status && `subscription ${o.subscription_status}`, o.billing_type, `extra-usage ${o.has_extra_usage_enabled ? 'on' : 'off'}`].filter(Boolean).join(', ');
    if (sub) lines.push(`  ${sub}`);
  } catch (e) {
    lines.push(`Claude Code profile: error — ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const r = await workerGet<Roles>('/claude-code/roles');
    const role = [r.organization_role && `org ${r.organization_role}`, r.workspace_role && `workspace ${r.workspace_role}`].filter(Boolean).join(', ');
    if (role) lines.push(`  role: ${role}`);
  } catch { /* roles optional */ }
  try {
    const pol = await workerGet<Policy>('/claude-code/policy-limits');
    const taints = (pol.compliance_taints || []).length;
    const denied = Object.entries(pol.restrictions || {}).filter(([, v]) => v && v.allowed === false).map(([k]) => k);
    lines.push(`  policy: ${taints} compliance taint(s)${denied.length ? `; restricted: ${denied.join(', ')}` : ''}`);
  } catch { /* policy optional */ }
  return ok(lines.join('\n'));
}

export const CLAUDE_CODE_ACCOUNT_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  claude_code_account: handleClaudeCodeAccount,
};
