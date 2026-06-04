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
  /** Registered on claude.ai as a connected MCP server. */
  claudeRegistered?: boolean;
  claudeServerName?: string;
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

/** Which claude.ai-connected MCP servers point at this node's MCP URL. */
async function claudeRegistered(): Promise<string[]> {
  const base = mcpPublicBase();
  if (!base) return [];
  const mcpUrl = `${base}/mcp`;
  try {
    const r = await fetch(`http://127.0.0.1:${localApiPort()}/claude-ai/org/mcp-bootstrap`, {
      signal: AbortSignal.timeout(15000),
    });
    const j = (await r.json()) as { data?: { events?: Array<{ type: string; data?: { servers?: Array<{ url?: string; name?: string }> } }> } };
    const ev = (j.data?.events || []).find((e) => e.type === 'server_list');
    const servers = ev?.data?.servers || [];
    return servers.filter((s) => s.url === mcpUrl).map((s) => s.name || '');
  } catch {
    return [];
  }
}

export async function listConnectors(): Promise<{
  base: string | null;
  gatewayId: string | null;
  connectors: Connector[];
  error?: string;
}> {
  const base = mcpPublicBase();
  const gatewayId = nodeGatewayId();
  try {
    const r = await gatewayFetch('/mcp/connectors');
    if (!r.ok) return { base, gatewayId, connectors: [], error: `gateway ${r.status}` };
    const j = (await r.json()) as { connectors?: Connector[] };
    const list = j.connectors || [];
    const registeredNames = await claudeRegistered();
    // The MCP URL is shared across this node's connectors, so claude.ai
    // registration is reported per-URL (registered if any server matches).
    const registered = registeredNames.length > 0;
    return {
      base,
      gatewayId,
      connectors: list.map((c) => ({
        ...c,
        enabled: c.enabled !== false,
        claudeRegistered: registered,
        claudeServerName: registeredNames[0] || undefined,
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
