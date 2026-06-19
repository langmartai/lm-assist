/**
 * claudeai_active_sessions MCP tool — the live device/browser sessions logged
 * into the user's claude.ai account (GET /claude-ai/sessions-active). A security
 * view: which browsers/devices, from where, last active, which one is "current".
 * Uses the same cookie auth_status reports on. Read-only, no secrets.
 *
 * Registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts), scoped
 * read in configure.ts TOOL_SCOPES.
 */
import { ok, err, workerGet, type McpToolResult } from './_passthrough';

export const claudeaiActiveSessionsToolDef = {
  name: 'claudeai_active_sessions',
  description:
    'List the live device/browser sessions currently logged into the user\'s claude.ai ' +
    'WEB account — a security view. For each: device + browser + OS, city/country, when it ' +
    'was last active, and which one is the current session. Trigger words: "who is logged ' +
    'into my claude.ai", "my active sessions", "what devices are signed in", "claude.ai ' +
    'security", "other sessions", "am I logged in somewhere else". Requires a configured ' +
    'claude.ai cookie (check auth_status first). Read-only — does NOT revoke sessions.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const CLAUDEAI_ACTIVE_SESSIONS_TOOL_DEFS = [claudeaiActiveSessionsToolDef] as const;

interface DeviceSession {
  updated_at?: string;
  user_agent?: { browser_family?: string; browser_version?: string; os_family?: string; os_version?: string; device_family?: string };
  location_info?: { country?: string; region?: string; city?: string };
  is_current?: boolean;
}

function shortTime(iso?: string): string {
  if (!iso) return '?';
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

function deviceLabel(s: DeviceSession): string {
  const ua = s.user_agent || {};
  const device = ua.device_family && ua.device_family !== 'Other' ? ua.device_family : ua.os_family || 'device';
  const browser = [ua.browser_family, ua.browser_version?.split('.')[0]].filter(Boolean).join(' ');
  return `${device} / ${browser || 'unknown browser'}`;
}

function locLabel(s: DeviceSession): string {
  const l = s.location_info || {};
  return [l.city, l.country].filter(Boolean).join(', ') || 'unknown location';
}

async function handleClaudeaiActiveSessions(_args: Record<string, unknown> = {}): Promise<McpToolResult> {
  let sessions: DeviceSession[];
  try {
    const raw = await workerGet<DeviceSession[] | { data?: DeviceSession[] }>('/claude-ai/sessions-active');
    sessions = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }

  if (sessions.length === 0) return ok('No active claude.ai device sessions reported (0).');

  // Most-recently-active first; the current session pinned at the top.
  sessions.sort((a, b) => {
    if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
    return (b.updated_at || '').localeCompare(a.updated_at || '');
  });

  const lines = [`Active claude.ai sessions (${sessions.length}) — devices signed into your account:`];
  for (const s of sessions) {
    lines.push(`  • ${deviceLabel(s)} — ${locLabel(s)} — active ${shortTime(s.updated_at)}${s.is_current ? '  [current]' : ''}`);
  }
  return ok(lines.join('\n'));
}

export const CLAUDEAI_ACTIVE_SESSIONS_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  claudeai_active_sessions: handleClaudeaiActiveSessions,
};
