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
export function mergeIngestBody(project: string, sourceHost: string, records: unknown[], key: string) {
  return { project, sourceHost, records, key, merge: true };
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

/** True iff this node has a fabric link to `node`, that peer advertised the `memory` HELLO
 *  feature, AND the local opt-in (dataSyncViaFabric) is on. Lazy require()s (mirrors
 *  rulesFabricEligible's own `require('../fabric') as any` / `require('../project-settings')`
 *  pattern below) to avoid a load-time circular dep between fabric/index.ts and this module.
 *  Wrapped in try/catch — any settings/fabric read failure is simply "not eligible", same as
 *  fabricSettingEnabled()'s own default-safe posture elsewhere in the fabric layer. */
function memoryFabricEligible(node: string): boolean {
  try {
    const { getProjectSettings } = require('../project-settings') as typeof import('../project-settings');
    const { fabricMemoryPeer } = require('../fabric') as any;
    return getProjectSettings().dataSyncViaFabric && fabricMemoryPeer(node);
  } catch {
    return false;
  }
}

/** Generic peer RPC over the fabric for the memory sync routes (export/ingest/projects-by-remote —
 *  no key required, the peer authorizes a loopback+peer call without one; see memory-sync.routes.ts's
 *  authorized()). Throws on any transport failure OR app-error (status>=400 or a `code`) — every
 *  throw routes the caller (pullFromHome/slugsByRemote/pushToHome/pushMergeToPeer) to the hub
 *  fallback, mirroring pullRulesViaFabric's assertNoAppError-then-throw shape (fabricDataRequest
 *  RESOLVES app-errors instead of throwing, so they must be checked explicitly here). */
async function memoryFabricRequest(node: string, init: { method: string; path: string; body?: unknown; query?: Record<string, string> }): Promise<any> {
  const { fabricDataRequest } = require('../fabric') as any;
  const r = await fabricDataRequest(node, init);
  if (r.status >= 400 || r.code) {
    throw new Error(r.message || `fabric app-error (status ${r.status}${r.code ? `, code ${r.code}` : ''})`);
  }
  return r.data;
}

/** Pull a project's syncable records from the home node. Fabric fast-path when eligible (direct
 *  peer RPC, no hub hairpin, no key — see memoryFabricEligible/memoryFabricRequest above); falls
 *  back to the EXISTING hub relay path unchanged on ANY error (ineligible, transport failure, or
 *  fabric app-error) or a malformed fabric result. Returns [] on total failure (unchanged contract). */
export async function pullFromHome(homeId: string, project: string, sinceMs: number, key: string): Promise<PulledRecord[]> {
  if (memoryFabricEligible(homeId)) {
    try {
      const raw = await memoryFabricRequest(homeId, { method: 'POST', path: '/memory/export', body: exportBody(project, sinceMs, key) });
      const data = raw && (raw.data || raw);
      if (data && Array.isArray(data.records)) return data.records;
    } catch {
      // fall through to hub
    }
  }
  const j = await relayPost(homeId, '/memory/export', exportBody(project, sinceMs, key));
  const raw = j && (j.data || j);
  return raw && Array.isArray(raw.records) ? raw.records : [];
}

/** Push records to the home node's mirror for this host — the first WRITE on the memory fabric
 *  fast-path. Fabric fast-path when eligible; falls back to the EXISTING hub relay path unchanged
 *  on ANY error or a malformed fabric result. Returns 0 on total failure (unchanged contract). */
export async function pushToHome(homeId: string, project: string, sourceHost: string, records: unknown[], key: string): Promise<number> {
  if (memoryFabricEligible(homeId)) {
    try {
      const raw = await memoryFabricRequest(homeId, { method: 'POST', path: '/memory/ingest', body: ingestBody(project, sourceHost, records, key) });
      const data = raw && (raw.data || raw);
      if (data && typeof data.ingested === 'number') return data.ingested;
    } catch {
      // fall through to hub
    }
  }
  const j = await relayPost(homeId, '/memory/ingest', ingestBody(project, sourceHost, records, key));
  const raw = j && (j.data || j);
  return raw && typeof raw.ingested === 'number' ? raw.ingested : 0;
}

/** CONVERGENT push: merge this node's records into a peer's LIVE memory for `targetProject` — the
 *  second WRITE on the memory fabric fast-path (same /memory/ingest route, merge:true). Fabric
 *  fast-path when eligible; falls back to the EXISTING hub relay path unchanged on ANY error or a
 *  falsy fabric result. Returns null on total failure (unchanged contract). */
export async function pushMergeToPeer(node: string, targetProject: string, sourceHost: string, records: unknown[], key: string): Promise<any> {
  if (memoryFabricEligible(node)) {
    try {
      const raw = await memoryFabricRequest(node, { method: 'POST', path: '/memory/ingest', body: mergeIngestBody(targetProject, sourceHost, records, key) });
      const data = raw && (raw.data || raw);
      if (data && data.merged) return data.merged;
    } catch {
      // fall through to hub
    }
  }
  const j = await relayPost(node, '/memory/ingest', mergeIngestBody(targetProject, sourceHost, records, key));
  const raw = j && (j.data || j);
  return (raw && raw.merged) || null;
}

/** Relay a GET to a peer node's Core endpoint via the hub machine-proxy (worker token injected by the relay). */
async function relayGet(node: string, urlPath: string): Promise<any> {
  const cfg = getHubConfig();
  const base = hubHttpBase();
  if (!base || !cfg.apiKey || !node) return null;
  try {
    const res = await fetch(`${base}${proxyUrlPath(node, urlPath)}`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Ask a peer which of its project slugs match a git-remote key. Fabric fast-path when eligible;
 *  falls back to the EXISTING hub relay (GET /memory/projects-by-remote) path unchanged on ANY
 *  error or a malformed fabric result. Returns [] on total failure (unchanged contract). */
export async function slugsByRemote(node: string, remoteKey: string): Promise<string[]> {
  if (memoryFabricEligible(node)) {
    try {
      const raw = await memoryFabricRequest(node, { method: 'GET', path: '/memory/projects-by-remote', query: { key: remoteKey } });
      const data = raw && (raw.data || raw);
      if (data && Array.isArray(data.slugs)) return data.slugs;
    } catch {
      // fall through to hub
    }
  }
  const j = await relayGet(node, `/memory/projects-by-remote?key=${encodeURIComponent(remoteKey)}`);
  const raw = j && (j.data || j);
  return raw && Array.isArray(raw.slugs) ? raw.slugs : [];
}

import type { IngestRule } from '../rules/rule-sync';

/** Pure: body for POST /rules/export (key in body because the hub proxy strips the x-lm-access-key header). */
export function rulesExportBody(key: string) {
  return { key };
}

/** True iff this node has a fabric link to `node`, that peer advertised the `rules` HELLO
 *  feature, AND the local opt-in (dataSyncViaFabric) is on. Lazy require()s (mirrors
 *  FabricPeerClient's own `require('../fabric') as any` / `require('../project-settings')`
 *  pattern) to avoid a load-time circular dep between fabric/index.ts and this module.
 *  Wrapped in try/catch — any settings/fabric read failure is simply "not eligible", same
 *  as fabricSettingEnabled()'s own default-safe posture elsewhere in the fabric layer. */
function rulesFabricEligible(node: string): boolean {
  try {
    const { getProjectSettings } = require('../project-settings') as typeof import('../project-settings');
    const { fabricRulesPeer } = require('../fabric') as any;
    return getProjectSettings().dataSyncViaFabric && fabricRulesPeer(node);
  } catch {
    return false;
  }
}

/** Fetch a peer's own USER rules over the fabric (no key — the peer authorizes a
 *  loopback+peer call without one; see rule-sync.routes.ts's authorized()). Throws on
 *  any transport failure OR app-error (status>=400) OR a malformed body — every throw
 *  routes the caller (pullRulesExport) to the hub fallback, mirroring FabricPeerClient's
 *  own assertNoAppError-then-throw shape (fabricRequestManaged RESOLVES app-errors
 *  instead of throwing, so they must be checked explicitly here). */
async function pullRulesViaFabric(node: string): Promise<{ host: string; platform: string; rules: IngestRule[] } | null> {
  const { fabricDataRequest } = require('../fabric') as any;
  const r = await fabricDataRequest(node, { method: 'POST', path: '/rules/export', body: {} });
  if (r.status >= 400 || r.code) {
    throw new Error(r.message || `fabric app-error (status ${r.status}${r.code ? `, code ${r.code}` : ''})`);
  }
  const raw = r.data && (r.data.data || r.data);
  if (!raw || !Array.isArray(raw.rules)) {
    throw new Error('fabric /rules/export: malformed response (no rules[])');
  }
  return { host: String(raw.host || node), platform: String(raw.platform || ''), rules: raw.rules };
}

/** Pull a peer node's own USER rules. Fabric fast-path when eligible (direct peer RPC, no
 *  hub hairpin, no key — see rulesFabricEligible/pullRulesViaFabric above); falls back to
 *  the EXISTING hub relay path unchanged on ANY error (ineligible, transport failure, or
 *  fabric app-error) or a falsy fabric result. Returns null on total failure. */
export async function pullRulesExport(node: string, key: string): Promise<{ host: string; platform: string; rules: IngestRule[] } | null> {
  if (rulesFabricEligible(node)) {
    try {
      const parsed = await pullRulesViaFabric(node);
      if (parsed) return parsed;
    } catch {
      // fall through to hub
    }
  }
  const j = await relayPost(node, '/rules/export', rulesExportBody(key));
  const raw = j && (j.data || j);
  if (!raw || !Array.isArray(raw.rules)) return null;
  return { host: String(raw.host || node), platform: String(raw.platform || ''), rules: raw.rules };
}

/** Fleet node ids (excluding self), from the hub machine list. Empty on any failure. */
export async function listFleetNodes(): Promise<string[]> {
  try {
    const { getHubPeerClient } = await import('../data/peer-client');
    const peers = await getHubPeerClient().listPeers();
    return peers.map((p: any) => p.node).filter((n: any) => typeof n === 'string' && n);
  } catch {
    return [];
  }
}
