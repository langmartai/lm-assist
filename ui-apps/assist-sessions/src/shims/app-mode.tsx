/* Shim for '@/contexts/AppModeContext' (aliased in build.mjs).
 *
 * The heart of the port: useAppMode() hands the sessions components a REAL
 * ApiClient — the api-client's own createLocalClient pinned at the pane data
 * plane — with exactly two method overrides:
 *
 *  - batchCheckSessions: the local client POSTs, but a session browser's grant is
 *    deliberately GET-only (a pane that can POST is a session DRIVER). The core
 *    exposes a GET twin (`GET /sessions/batch-check?sessions=…&listCheck.*=…`,
 *    sessions.routes.ts) that the existing `/sessions/*` leaf already covers, so
 *    the unified live-poll loop works with no grant widening.
 *  - getSessionConversation: the local client requests includeRawMessages=true —
 *    measured 7.8MB vs 512KB on a 2707-turn session. This override fetches the
 *    COMPACT chat extras instead (includeToolResults/includeSystemMessages),
 *    adapts them to the shapes transformSessionResponse already reads (tool.output,
 *    rawMessages system/summary rows), and calls the REAL transform — one source
 *    of truth for the message model, ~10x less payload.
 */
import type { ReactNode } from 'react';
import {
  createLocalClient,
  transformSessionResponse,
  detectProxyInfo,
} from './api-client';
import type { SessionDetail } from '../../../../web/src/lib/types';
import { dataBase } from '../data-plane';

async function fetchDataJson<T>(path: string): Promise<T> {
  const res = await fetch(dataBase() + path); // scoped patch adds the Bearer token
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  const json = await res.json();
  if (json && typeof json === 'object') {
    if ('data' in json) return (json as any).data as T;
    if ('result' in json) return (json as any).result as T;
  }
  return json as T;
}

function buildApiClient() {
  const base = createLocalClient(dataBase(), detectProxyInfo());
  return {
    ...base,

    async batchCheckSessions(request: any): Promise<any> {
      const params = new URLSearchParams();
      if (request?.sessions?.length) params.set('sessions', JSON.stringify(request.sessions));
      const lc = request?.listCheck;
      if (lc) {
        if (lc.projectPath) params.set('listCheck.projectPath', lc.projectPath);
        if (lc.knownSessionCount !== undefined) params.set('listCheck.knownSessionCount', String(lc.knownSessionCount));
        if (lc.knownLatestModified) params.set('listCheck.knownLatestModified', lc.knownLatestModified);
      }
      try {
        return await fetchDataJson<any>(`/sessions/batch-check?${params.toString()}`);
      } catch {
        return { sessions: {} }; // same swallow-and-degrade the local client uses
      }
    },

    async getSessionConversation(
      sessionId: string,
      opts: { lastN?: number; fromLine?: number },
    ): Promise<SessionDetail> {
      const params = new URLSearchParams();
      if (opts?.lastN) params.set('lastNUserPrompts', String(opts.lastN));
      if (opts?.fromLine) params.set('fromLineIndex', String(opts.fromLine));
      params.set('includeToolResults', 'true');
      params.set('includeSystemMessages', 'true');
      const raw = await fetchDataJson<any>(`/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`);

      // Compact → transform adaptation. transformSessionResponse reads
      // `tool.output || tool.result || tool.resultSummary` for the paired result,
      // and derives system/result/summary chat rows from rawMessages.
      if (Array.isArray(raw?.toolUses) && Array.isArray(raw?.toolResults)) {
        const byId = new Map<string, any>(raw.toolResults.map((r: any) => [r.toolUseId, r]));
        for (const t of raw.toolUses) {
          const r = t && byId.get(t.id);
          if (!r) continue;
          t.output = r.isError ? `[tool error]\n${r.content}` : r.content;
          if (r.truncated) t.output += `\n… (${r.fullLength ?? '?'} chars total, server-capped)`;
        }
      }
      if (Array.isArray(raw?.systemMessages) && !raw.rawMessages) {
        raw.rawMessages = raw.systemMessages.map((m: any) => ({
          type: m.type,
          subtype: m.subtype,
          content: m.content,
          durationMs: m.durationMs,
          lineIndex: m.lineIndex,
          timestamp: m.timestamp,
        }));
      }
      return transformSessionResponse(raw, sessionId);
    },
  };
}

let cached: ReturnType<typeof buildApiClient> | null = null;
function apiClient() {
  if (!cached) cached = buildApiClient();
  return cached;
}

const VALUE = {
  mode: 'local' as const,
  isLocal: true,
  isHub: false,
  isHybrid: false,
  get apiClient() { return apiClient(); },
  proxy: { isProxied: true, basePath: '', machineId: 'local' },
  hubUser: null,
  hubConnected: false,
  localGatewayId: 'local',
  hubUrl: null,
  proxySessionExpired: false,
  refreshHubConnection: async () => {},
};

export function useAppMode() {
  return VALUE as any;
}

export function AppModeProvider({ children }: { children: ReactNode }) {
  return children as any;
}
