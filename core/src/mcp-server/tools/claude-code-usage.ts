/**
 * claude_code_usage MCP tool — the live Claude Code rate-limit / quota windows
 * (GET /claude-code/usage → api.anthropic.com Utilization). Complements
 * auth_status: that says the OAuth token is VALID; this says how much quota is
 * left in each window before you hit a limit. Read-only, no secrets.
 *
 * Registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts), scoped
 * read in configure.ts TOOL_SCOPES.
 */
import { ok, err, workerGet, type McpToolResult } from './_passthrough';

export const claudeCodeUsageToolDef = {
  name: 'claude_code_usage',
  description:
    'Show the live Claude Code rate-limit / quota windows for this node\'s OAuth ' +
    'account — the 5-hour session window, the weekly all-models window, and any ' +
    'per-model (Opus/Sonnet) weekly windows, each with percent used, severity, and ' +
    'when it resets. Trigger words: "am I rate limited", "how much quota left", "usage", ' +
    '"rate limit", "when does my limit reset", "am I close to the cap". Pairs with ' +
    'auth_status (which says whether the token itself is valid). Live call to ' +
    'api.anthropic.com via the Claude Code OAuth token; read-only, no secrets.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const CLAUDE_CODE_USAGE_TOOL_DEFS = [claudeCodeUsageToolDef] as const;

interface UsageLimit {
  kind?: string;
  group?: string;
  percent?: number;
  severity?: string;
  resets_at?: string;
  is_active?: boolean;
  scope?: { model?: { display_name?: string } } | null;
}
interface Usage {
  limits?: UsageLimit[];
  extra_usage?: { is_enabled?: boolean; utilization?: number | null };
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
}

/** "2026-06-24T10:00:00Z" → "Jun 24 10:00 UTC" (compact, no fractional secs). */
function shortReset(iso?: string): string {
  if (!iso) return '?';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m[2], 10) - 1]} ${m[3]} ${m[4]}:${m[5]} UTC`;
}

function labelFor(l: UsageLimit): string {
  const model = l.scope?.model?.display_name;
  if (model) return `weekly (${model})`;
  if (l.kind === 'session') return 'session (5h)';
  if (l.kind === 'weekly_all') return 'weekly (all models)';
  return l.kind || l.group || 'window';
}

async function handleClaudeCodeUsage(_args: Record<string, unknown> = {}): Promise<McpToolResult> {
  let usage: Usage;
  try {
    usage = await workerGet<Usage>('/claude-code/usage');
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }

  const limits = (usage.limits || []).filter((l) => typeof l.percent === 'number');
  const lines: string[] = [];

  if (limits.length === 0) {
    // Fall back to the top-level windows if the limits[] array is absent.
    if (usage.five_hour) lines.push(`session (5h): ${usage.five_hour.utilization ?? '?'}% used, resets ${shortReset(usage.five_hour.resets_at)}`);
    if (usage.seven_day) lines.push(`weekly: ${usage.seven_day.utilization ?? '?'}% used, resets ${shortReset(usage.seven_day.resets_at)}`);
    if (lines.length === 0) return ok('Claude Code usage: no rate-limit windows reported.');
  }

  const worst = limits.reduce((mx, l) => Math.max(mx, l.percent || 0), 0);
  const anySevere = limits.some((l) => l.severity && l.severity !== 'normal');
  const header = anySevere || worst >= 80
    ? `Claude Code usage — ⚠ approaching a limit (peak ${worst}% used):`
    : `Claude Code usage — OK (peak ${worst}% used):`;
  lines.unshift(header);

  for (const l of limits) {
    const sev = l.severity && l.severity !== 'normal' ? `  [${l.severity}]` : '';
    const active = l.is_active ? ' *active' : '';
    lines.push(`  ${labelFor(l)}: ${l.percent}% used, resets ${shortReset(l.resets_at)}${sev}${active}`);
  }

  if (usage.extra_usage) {
    lines.push(`  extra usage: ${usage.extra_usage.is_enabled ? `enabled (${usage.extra_usage.utilization ?? 0}% used)` : 'disabled'}`);
  }

  return ok(lines.join('\n'));
}

export const CLAUDE_CODE_USAGE_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  claude_code_usage: handleClaudeCodeUsage,
};
