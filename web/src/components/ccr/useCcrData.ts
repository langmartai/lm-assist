'use client';

/**
 * The ONE data pipeline for the CCR page. Polls the core aggregate
 * GET /fleet/ccr (cloud once + every online node's bridges/rc/locals) on a
 * single stable 5s loop and derives the row list both panes render. There is
 * deliberately no other session-loading logic on the page — the sidebar and
 * the main list are two views over this hook's rows.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { buildFleetRows } from '@/lib/ccr-rows';
import type { ApiFetch, CcrFleetPayload, CcrRow } from './ccrTypes';

export interface CcrNodeInfo {
  id: string;
  /** rows attributed to this node (locals + rc + bridged cloud sessions). */
  count: number;
  reachable: boolean;
}

export interface CcrData {
  rows: CcrRow[];
  /** the aggregating node's gateway-id (rows from it are "local" to this page). */
  selfNode: string | null;
  /** every node present in the payload (reachable or not), self first. */
  nodes: CcrNodeInfo[];
  loading: boolean;
  error: string | null;
  /** degraded-but-serving note (e.g. cloud list stale under OAuth churn). */
  warning: string | null;
  nowMs: number;
  refresh: () => Promise<void>;
}

export function useCcrData(apiFetch: ApiFetch): CcrData {
  const [fleet, setFleet] = useState<CcrFleetPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(0);

  // Re-entrancy guard, same shape as useSessions' fetchingRef. WITHOUT it the 5s poll below
  // fires again while the previous /fleet/ccr is still in flight — and that request is not
  // cheap (~4s on the LM_HTTPS origin, where Core proxies every page asset on the SAME event
  // loop it serves /_coreapi from). The polls then stack, saturate the browser's per-origin
  // connection pool, and NOTHING completes: the page sits on "Loading sessions…" forever while
  // the identical page over plain http — where Next serves assets from its own process — stays
  // just fast enough to keep ahead. Skipping a tick is always correct here; the next one is 5s away.
  const inFlightRef = useRef(false);

  const fetchAll = useCallback(async () => {
    if (inFlightRef.current) return; // a poll is still running — let it finish
    inFlightRef.current = true;
    setError(null);
    try {
      const f = await apiFetch<CcrFleetPayload>('/fleet/ccr');
      if (f && Array.isArray(f.nodes)) {
        setFleet(f);
        setNowMs(Date.now());
      } else {
        setError('unexpected /fleet/ccr payload');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [apiFetch]);

  // Stable 5s poll (decoupled from apiFetch identity churn in hybrid/proxy mode).
  const fetchRef = useRef(fetchAll);
  useEffect(() => { fetchRef.current = fetchAll; }, [fetchAll]);
  useEffect(() => { fetchRef.current(); const t = setInterval(() => fetchRef.current(), 5000); return () => clearInterval(t); }, []);

  const rows = useMemo(() => (fleet ? buildFleetRows(fleet) : []), [fleet]);

  const nodes = useMemo<CcrNodeInfo[]>(() => {
    if (!fleet) return [];
    const counts = new Map<string, number>();
    for (const r of rows) if (r.node) counts.set(r.node, (counts.get(r.node) || 0) + 1);
    const reachable = (fleet.nodes || []).map((n) => ({ id: n.node, count: counts.get(n.node) || 0, reachable: true }));
    // self first, then the rest in payload order (payload order is self-first already; keep deterministic).
    reachable.sort((a, b) => Number(b.id === fleet.self) - Number(a.id === fleet.self) || a.id.localeCompare(b.id));
    const down = (fleet.unreachable || []).map((id) => ({ id, count: 0, reachable: false }));
    return [...reachable, ...down];
  }, [fleet, rows]);

  // Age-gated: single failed polls are invisible (the last-good list keeps
  // serving, and a peer usually backfills). Warn only when the cloud list has
  // been GENUINELY stale for a while — that's worth the user's attention.
  const warning = cloudStaleWarning(fleet, nowMs || Date.now());

  return { rows, selfNode: fleet?.self ?? null, nodes, loading, error, warning, nowMs, refresh: fetchAll };
}

export const CLOUD_STALE_WARN_MS = 90_000;

/** Pure: the degraded-banner text, or null while blips are being absorbed. */
export function cloudStaleWarning(fleet: CcrFleetPayload | null, nowMs: number): string | null {
  if (!fleet?.cloudError) return null;
  const at = fleet.cloudFetchedAt ?? 0;
  if (at && nowMs - at < CLOUD_STALE_WARN_MS) return null;
  const age = at ? `${Math.max(1, Math.round((nowMs - at) / 60000))}m old` : 'unavailable';
  return `cloud session list stale (${age}): ${fleet.cloudError}`;
}
