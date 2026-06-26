/**
 * auth_status MCP tool — one-glance credential health for a node, with NO
 * secrets. Aggregates:
 *   - the claude.ai WEB session cookie  (GET /claude-ai/healthz)
 *   - the Claude Code OAuth token        (GET /claude-code/oauth-status)
 *
 * Both back the rest of the surface: the claude.ai cookie powers
 * list_claudeai_conversations / read_conversation / claudeai_completion; the
 * Claude Code OAuth token powers agent_execute and the api.anthropic.com proxy.
 * So "is my session still good / why did that claude.ai call fail / is my
 * OAuth expired" is answered here before driving those tools.
 *
 * Registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts), scoped
 * read in configure.ts TOOL_SCOPES.
 */
import { ok, err, workerGet, type McpToolResult } from './_passthrough';

export const authStatusToolDef = {
  name: 'auth_status',
  description:
    'Report a node\'s credential health (NO secrets) — the claude.ai WEB session ' +
    'cookie and the Claude Code OAuth token. Trigger words: "am I logged in", "is my ' +
    'claude.ai session valid", "auth status", "check my credentials", "is the cookie ' +
    'still good", "is my oauth expired", "why did that claude.ai call fail". The ' +
    'claude.ai cookie powers list_claudeai_conversations / read_conversation / ' +
    'claudeai_completion; the Claude Code OAuth token powers agent_execute. Returns, ' +
    'per surface: configured?, valid?, identity / expiry, and a reason+hint when ' +
    'something is wrong. Use `which` to scope to one surface. Set `allNodes:true` for ' +
    'a compact fleet-wide sweep (one line per connected node). Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      which: {
        type: 'string',
        enum: ['all', 'claude_ai', 'claude_code'],
        description: 'Which credential surface to check (default all). Ignored when allNodes:true.',
      },
      allNodes: {
        type: 'boolean',
        description: 'Sweep every connected node and return a compact per-node summary (oauth+cookie flags). Ignores `which`.',
      },
    },
  },
};

export const AUTH_STATUS_TOOL_DEFS = [authStatusToolDef] as const;

/** Human-friendly duration for a ms delta (e.g. 23h, 5m, 40s, or "expired"). */
function humanDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '?';
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

interface Healthz {
  ok?: boolean;
  reason?: string;
  hint?: string;
  sessionConfigured?: boolean;
  identity?: { email?: string; full_name?: string; uuid?: string } | null;
  cookieFreshness?: { hasSessionKey?: boolean; hasCfClearance?: boolean; hasCfBm?: boolean };
}

interface OAuthStatus {
  present?: boolean;
  expired?: boolean;
  msUntilExpiry?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
  scopes?: string[];
  storage?: string;
  platform?: string;
}

async function claudeAiSection(): Promise<string[]> {
  const out: string[] = [];
  try {
    const h = await workerGet<Healthz>('/claude-ai/healthz');
    if (h.ok) {
      const who = h.identity?.email || h.identity?.full_name || h.identity?.uuid || 'logged in';
      out.push(`claude.ai web session: OK (${who})`);
      const c = h.cookieFreshness || {};
      out.push(`  cookies: sessionKey ${c.hasSessionKey ? '✓' : '✗'}  cf_clearance ${c.hasCfClearance ? '✓' : '✗'}  cf_bm ${c.hasCfBm ? '✓' : '✗'}`);
    } else {
      out.push(`claude.ai web session: NOT USABLE — ${h.reason || 'unknown'}${h.sessionConfigured ? '' : ' (not configured)'}`);
      if (h.hint) out.push(`  → ${h.hint}`);
    }
  } catch (e) {
    out.push(`claude.ai web session: error — ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}

async function claudeCodeSection(): Promise<string[]> {
  const out: string[] = [];
  try {
    const o = await workerGet<OAuthStatus>('/claude-code/oauth-status');
    if (!o.present) {
      out.push('Claude Code OAuth: NOT PRESENT (no ~/.claude/.credentials.json token)');
    } else if (o.expired) {
      out.push('Claude Code OAuth: EXPIRED — refresh by running Claude Code, or re-login');
    } else {
      const exp = typeof o.msUntilExpiry === 'number' ? `expires in ${humanDuration(o.msUntilExpiry)}` : 'valid';
      const extra = [o.subscriptionType && `sub=${o.subscriptionType}`, o.rateLimitTier && `tier=${o.rateLimitTier}`].filter(Boolean).join(', ');
      out.push(`Claude Code OAuth: valid (${exp}${extra ? `, ${extra}` : ''})`);
      if (o.scopes?.length) out.push(`  scopes: ${o.scopes.join(' ')}`);
    }
  } catch (e) {
    out.push(`Claude Code OAuth: error — ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}

/**
 * Compact per-node auth summary row for the allNodes fleet sweep.
 * `oauth` and `cookie` are human-readable flags — no secrets.
 */
export function formatAllNodes(rows: Array<{node: string; oauth: string; cookie: string}>): string {
  if (rows.length === 0) return 'No nodes found.';
  return rows.map((r) => `${r.node}  oauth:${r.oauth}  cookie:${r.cookie}`).join('\n');
}

interface NodeEntry { nodeId: string; hostname: string; isSelf: boolean; }

/** Best-effort fleet sweep: get all nodes from hub, probe each, build rows. */
async function sweepAllNodes(): Promise<McpToolResult> {
  const { getHubConfig } = require('../../hub-client/hub-config') as typeof import('../../hub-client/hub-config');
  const cfg = getHubConfig();
  const selfId = cfg.gatewayId || cfg.machineId;
  const selfHostname = cfg.hostname || selfId || 'this-node';

  // Start with just self in case hub is not reachable.
  let nodes: NodeEntry[] = [{ nodeId: selfId, hostname: selfHostname, isSelf: true }];
  try {
    const hm = await workerGet<{machines: unknown[]}>('/hub/machines');
    const machineList: unknown[] = Array.isArray(hm) ? hm : ((hm as any).machines || []);
    const hubNodes: NodeEntry[] = (machineList as any[])
      .map((m: any) => ({
        nodeId: String(m.gatewayId || m.machineId || m.id || ''),
        hostname: String(m.hostname || m.machineHostname || m.gatewayId || m.machineId || m.id || ''),
        isSelf: (m.gatewayId || m.machineId || m.id) === selfId,
      }))
      .filter((m) => m.nodeId);
    if (hubNodes.length > 0) {
      nodes = hubNodes;
      if (!nodes.some((n) => n.isSelf)) {
        nodes.unshift({ nodeId: selfId, hostname: selfHostname, isSelf: true });
      }
    }
  } catch { /* hub not configured or not connected — sweep self only */ }

  const rows = await Promise.all(nodes.map(async (m) => {
    const label = m.hostname || m.nodeId;
    try {
      let healthzData: {ok?: boolean; reason?: string} = {};
      let oauthData: {present?: boolean; expired?: boolean} = {};
      if (m.isSelf) {
        [healthzData, oauthData] = await Promise.all([
          workerGet<{ok?: boolean; reason?: string}>('/claude-ai/healthz').catch(() => ({})),
          workerGet<{present?: boolean; expired?: boolean}>('/claude-code/oauth-status').catch(() => ({})),
        ]);
      } else {
        const { proxyGet } = require('../../data/peer-client') as typeof import('../../data/peer-client');
        const [h, o] = await Promise.all([
          (proxyGet(m.nodeId, '/claude-ai/healthz') as Promise<unknown>).catch(() => null),
          (proxyGet(m.nodeId, '/claude-code/oauth-status') as Promise<unknown>).catch(() => null),
        ]);
        healthzData = ((h as any)?.data ?? (h as any)) || {};
        oauthData = ((o as any)?.data ?? (o as any)) || {};
      }
      const oauthStr = !oauthData.present ? 'none' : oauthData.expired ? 'EXPIRED' : 'valid';
      const cookieStr = healthzData.ok ? 'ok' : (healthzData.reason || '?');
      return { node: label, oauth: oauthStr, cookie: cookieStr };
    } catch { return { node: label, oauth: '?', cookie: '?' }; }
  }));

  return ok(formatAllNodes(rows));
}

async function handleAuthStatus(args: Record<string, unknown>): Promise<McpToolResult> {
  if (args.allNodes === true || args.allNodes === 'true') {
    return sweepAllNodes();
  }
  const which = String(args.which || 'all');
  if (!['all', 'claude_ai', 'claude_code'].includes(which)) {
    return err('which must be one of: all, claude_ai, claude_code.');
  }
  const lines: string[] = [];
  if (which === 'all' || which === 'claude_ai') lines.push(...(await claudeAiSection()));
  if (which === 'all') lines.push('');
  if (which === 'all' || which === 'claude_code') lines.push(...(await claudeCodeSection()));
  return ok(lines.join('\n'));
}

export const AUTH_STATUS_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  auth_status: handleAuthStatus,
};
