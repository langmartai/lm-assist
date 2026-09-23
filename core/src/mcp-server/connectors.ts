/**
 * MCP connector management (for the settings UI).
 *
 * Connectors (OAuth clients bound to this node's user) live on the langmart
 * gateway, created via its per-user control plane. This module lets the local
 * web UI list / disable / delete them by calling that control plane with the
 * node's own xeenhub/langmart api key (the same key it uses for the hub), and
 * annotates each with its claude.ai registration status.
 *
 * Connectors are NOT created from the UI — they are minted by the node (or a
 * CLI) against the control plane. The UI is a read + lifecycle (disable/delete)
 * view, plus claude.ai registration status.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { lmAuthHeaders } from '../auth/api-token';

const IS_DEV_REPO = process.env.LM_ASSIST_PROD === 'true' ? false : !__dirname.includes('node_modules');
const DEV_SUFFIX = IS_DEV_REPO ? '-dev' : '';
const HUB_FILE = path.join(os.homedir(), '.lm-assist', `hub${DEV_SUFFIX}.json`);
const GATEWAY_ID_FILE = path.join(os.homedir(), '.lm-assist', `gateway-id${DEV_SUFFIX}`);

function hubConfig(): { hubUrl?: string; apiKey?: string } {
  try {
    return JSON.parse(fs.readFileSync(HUB_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

/** This node's gatewayId (the hub-assigned id), for display. */
export function nodeGatewayId(): string | null {
  try {
    return fs.readFileSync(GATEWAY_ID_FILE, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Public MCP base URL, derived from the hub WS URL:
 *   wss://assist-api.langmart.ai -> https://mcp.langmart.ai
 *   wss://assist-api.xeenhub.com -> https://mcp.xeenhub.com
 * Overridable with MCP_PUBLIC_BASE.
 */
export function mcpPublicBase(): string | null {
  if (process.env.MCP_PUBLIC_BASE) return process.env.MCP_PUBLIC_BASE;
  const hubUrl = hubConfig().hubUrl;
  if (!hubUrl) return null;
  try {
    const host = new URL(hubUrl.replace(/^wss?:/, 'https:')).hostname; // assist-api.langmart.ai
    const domain = host.split('.').slice(-2).join('.'); // langmart.ai
    return `https://mcp.${domain}`;
  } catch {
    return null;
  }
}

function nodeKey(): string | null {
  return hubConfig().apiKey || process.env.TIER_AGENT_API_KEY || null;
}

/** This process's own local API port (to call sibling routes like mcp-bootstrap). */
function localApiPort(): string {
  if (process.env.API_PORT) return process.env.API_PORT;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-code-config.json'), 'utf-8'));
    if (cfg.devModeEnabled) return '3200';
  } catch {
    /* default below */
  }
  return DEV_SUFFIX ? '3200' : '3100';
}

export interface Connector {
  client_id: string;
  name?: string;
  created_at?: string;
  enabled?: boolean;
  /** Registered on claude.ai: at least one claude.ai server points at this node's MCP URL —
   *  unpinned `/mcp` or a per-profile `/mcp/<profile>`. A gateway client carries no URL, so this is
   *  per node, not per client; the per-connector detail is `claudeServers` on the list. */
  claudeRegistered?: boolean;
  /** The preferred of those servers (unpinned, else admin, else the widest). */
  claudeServerName?: string;
}

/** One claude.ai server pointing at this node, with the profile its URL pins (null = unpinned). */
export interface ClaudeServerRegistration {
  uuid?: string;
  name: string;
  url: string;
  profile: string | null;
}

/** Pure: this node's registrations in a claude.ai server list — per URL, so each per-profile
 *  connector is reported on its own. Exported for tests. (Lazy require: profile-connectors
 *  imports this module.) */
export function summarizeClaudeRegistrations(
  servers: Array<{ uuid?: string; name?: string; url?: string }>,
  base: string,
): { claudeServers: ClaudeServerRegistration[]; preferredName?: string } {
  const { ourConnectors, preferredConnector } = require('./profile-connectors') as typeof import('./profile-connectors');
  const mine = ourConnectors(servers, base);
  return {
    claudeServers: mine.map((s) => ({ uuid: s.uuid, name: s.name || '', url: s.url || '', profile: s.profile })),
    preferredName: preferredConnector(mine)?.name || undefined,
  };
}

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = mcpPublicBase();
  const key = nodeKey();
  if (!base) throw new Error('hub URL not configured');
  if (!key) throw new Error('node api key not configured');
  return fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, ...(init?.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
}

/** Which claude.ai servers point at this node's MCP URL — unpinned or per-profile. */
async function claudeRegistrations(): Promise<{ claudeServers: ClaudeServerRegistration[]; preferredName?: string }> {
  const base = mcpPublicBase();
  if (!base) return { claudeServers: [] };
  try {
    const r = await fetch(`http://127.0.0.1:${localApiPort()}/claude-ai/mcp/servers`, {
      headers: lmAuthHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    const j = (await r.json()) as { data?: { servers?: Array<{ uuid?: string; name?: string; url?: string }> } };
    return summarizeClaudeRegistrations(j.data?.servers || [], base.replace(/\/+$/, ''));
  } catch {
    return { claudeServers: [] };
  }
}

export async function listConnectors(): Promise<{
  base: string | null;
  gatewayId: string | null;
  connectors: Connector[];
  /** Every claude.ai server pointing at this node, each with its profile. */
  claudeServers?: ClaudeServerRegistration[];
  error?: string;
}> {
  const base = mcpPublicBase();
  const gatewayId = nodeGatewayId();
  try {
    const r = await gatewayFetch('/mcp/connectors');
    if (!r.ok) return { base, gatewayId, connectors: [], error: `gateway ${r.status}` };
    const j = (await r.json()) as { connectors?: Connector[] };
    const list = j.connectors || [];
    const regs = await claudeRegistrations();
    return {
      base,
      gatewayId,
      claudeServers: regs.claudeServers,
      connectors: list.map((c) => ({
        ...c,
        enabled: c.enabled !== false,
        claudeRegistered: regs.claudeServers.length > 0,
        claudeServerName: regs.preferredName,
      })),
    };
  } catch (e) {
    return { base, gatewayId, connectors: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteConnector(clientId: string): Promise<boolean> {
  const r = await gatewayFetch(`/mcp/connectors/${encodeURIComponent(clientId)}`, { method: 'DELETE' });
  return r.ok;
}

export async function setConnectorEnabled(clientId: string, enabled: boolean): Promise<boolean> {
  const r = await gatewayFetch(`/mcp/connectors/${encodeURIComponent(clientId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  return r.ok;
}
