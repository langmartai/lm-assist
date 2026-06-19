/**
 * claudeai_account MCP tool — the user's claude.ai WEB account picture (NO
 * card/secret details): organization (/claude-ai/org) + plan/subscription
 * (/claude-ai/org/subscription). Identity/login is in auth_status; this adds the
 * org + plan. Registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS; scoped read.
 */
import { ok, workerGet, type McpToolResult } from './_passthrough';

export const claudeaiAccountToolDef = {
  name: 'claudeai_account',
  description:
    'Show the user\'s claude.ai WEB account (NO card/secret details) — organization, ' +
    'plan/subscription (status, billing interval, next charge), and key ' +
    'Claude-Code-on-web feature flags. Trigger words: "my claude.ai account", "my ' +
    'claude.ai plan", "my subscription", "what org am I in", "claude.ai billing", "when ' +
    'does my plan renew". Identity/login is in `auth_status`; this adds org + plan. ' +
    'Requires a configured claude.ai cookie. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const CLAUDEAI_ACCOUNT_TOOL_DEFS = [claudeaiAccountToolDef] as const;

interface Org { uuid?: string; name?: string; settings?: Record<string, unknown> }
interface Subscription { status?: string; billing_interval?: string; next_charge_date?: string; scheduled_downgrade?: unknown }

async function handleClaudeaiAccount(_args: Record<string, unknown> = {}): Promise<McpToolResult> {
  const lines: string[] = [];
  try {
    const org = await workerGet<Org>('/claude-ai/org');
    lines.push(`claude.ai account: ${org.name || '(org)'}${org.uuid ? `  (${org.uuid})` : ''}`);
    const s = org.settings || {};
    const flags = ['claude_code_routines_enabled', 'claude_code_remote_control_enabled', 'claude_code_workflows_enabled', 'claude_code_penguin_mode_enabled']
      .filter((k) => s[k] !== null && s[k] !== undefined)
      .map((k) => `${k.replace('claude_code_', '').replace('_enabled', '')}=${s[k] ? 'on' : 'off'}`);
    if (flags.length) lines.push(`  claude-code-on-web: ${flags.join(', ')}`);
  } catch (e) {
    lines.push(`claude.ai org: error — ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const sub = await workerGet<Subscription>('/claude-ai/org/subscription');
    const parts = [sub.status, sub.billing_interval, sub.next_charge_date && `next charge ${sub.next_charge_date}`].filter(Boolean);
    if (parts.length) lines.push(`  subscription: ${parts.join(' — ')}`);
    if (sub.scheduled_downgrade) lines.push('  ⚠ a downgrade is scheduled');
  } catch (e) {
    lines.push(`  subscription: error — ${e instanceof Error ? e.message : String(e)}`);
  }
  return ok(lines.join('\n'));
}

export const CLAUDEAI_ACCOUNT_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  claudeai_account: handleClaudeaiAccount,
};
