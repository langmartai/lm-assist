/**
 * Direct-MCP memory transport — pull/push a project's records to/from a peer node over the hub
 * relay, mirroring core/src/data/peer-client.ts. The access-key travels in the BODY because the
 * hub machine-proxy (`/api/tier-agent/machines/<id>/proxy`) drops the `x-lm-access-key` header.
 *
 * Network code — exercised by the live e2e; the pure helpers below are unit-tested.
 */
import { getHubConfig } from '../hub-client/hub-config';

/** Pure: the hub machine-proxy URL path for a peer node's Core endpoint. */
export function proxyUrlPath(node: string, urlPath: string): string {
  return `/api/tier-agent/machines/${node}/proxy${urlPath}`;
}

export function exportBody(project: string, sinceMs: number, key: string) {
  return { project, sinceMs, key };
}
export function ingestBody(project: string, sourceHost: string, records: unknown[], key: string) {
  return { project, sourceHost, records, key };
}

function hubHttpBase(): string {
  const cfg = getHubConfig();
  return (cfg.hubUrl || '').replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
}

/** Relay a POST to a peer node's Core endpoint via the hub machine-proxy. Returns null on failure. */
async function relayPost(node: string, urlPath: string, body: unknown): Promise<any> {
  const cfg = getHubConfig();
  const base = hubHttpBase();
  if (!base || !cfg.apiKey || !node) return null;
  try {
    const res = await fetch(`${base}${proxyUrlPath(node, urlPath)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export interface PulledRecord {
  file: string;
  content: string;
  contentHash: string;
  recordId?: string;
  recordedAtMs?: number;
}

/** Pull a project's syncable records from the home node (relayed, key in body). */
export async function pullFromHome(homeId: string, project: string, sinceMs: number, key: string): Promise<PulledRecord[]> {
  const j = await relayPost(homeId, '/memory/export', exportBody(project, sinceMs, key));
  const raw = j && (j.data || j);
  return raw && Array.isArray(raw.records) ? raw.records : [];
}

/** Push records to the home node's mirror for this host (relayed, key in body). */
export async function pushToHome(homeId: string, project: string, sourceHost: string, records: unknown[], key: string): Promise<number> {
  const j = await relayPost(homeId, '/memory/ingest', ingestBody(project, sourceHost, records, key));
  const raw = j && (j.data || j);
  return raw && typeof raw.ingested === 'number' ? raw.ingested : 0;
}
