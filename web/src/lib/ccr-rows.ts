/**
 * Row building for the CCR page — pure. Normalizes the /fleet/ccr aggregate
 * (cloud account-wide + per-node bridges/rc/locals) into the one CcrRow list
 * both the sidebar and the main pane render. Row KEYS are node-scoped and
 * stable — the deterministic list order depends on them.
 */
import type { CcrFleetPayload, CcrNodeSnapshot, CcrRow, CloudSessionInfo, Remote } from '@/components/ccr/ccrTypes';

const base = (p?: string | null) => (p ? p.split('/').filter(Boolean).pop() || p : '');

export function buildFleetRows(fleet: CcrFleetPayload): CcrRow[] {
  const rows: CcrRow[] = [];

  // RC identity across the fleet: cse → title + owning node.
  const titleByCse = new Map<string, string>();
  const nodeByCse = new Map<string, string>();
  for (const n of fleet.nodes || []) {
    const c = n.rc?.controller;
    if (c?.cse) { titleByCse.set(c.cse, c.title || 'Mission Controller'); nodeByCse.set(c.cse, n.node); }
    for (const ex of n.rc?.executors || []) {
      if (ex.cse) { titleByCse.set(ex.cse, ex.title || ex.sid); nodeByCse.set(ex.cse, n.node); }
    }
  }

  const seenCse = new Set<string>();
  for (const c of fleet.cloud || []) {
    seenCse.add(c.sid);
    // Registry-fallback items (core offline / OAuth down) carry no kind — normalize so the
    // list, filter counts, and icons never see undefined.
    const kind: CcrRow['kind'] = c.kind === 'remote' ? 'remote' : 'cloud';
    rows.push({
      key: `cloud:${c.sid}`, kind, id: c.sid,
      node: nodeByCse.get(c.sid) ?? null,
      title: titleByCse.get(c.sid) || c.title,
      repo: c.repo, branch: c.branch, model: c.model,
      status: { statusBucket: c.statusBucket, workerStatus: c.workerStatus, statusCategory: c.statusCategory, connectionStatus: c.connectionStatus },
      statusDetail: c.statusDetail || c.needsAction || null,
      time: c.lastEventAt || c.createdAt, webUrl: c.webUrl, unread: c.unread, cloud: c,
    });
  }

  for (const n of fleet.nodes || []) {
    // RC controller/executors not already in the cloud list (by cse) → remote rows on their node.
    const rcExtra = [
      ...(n.rc?.controller?.cse ? [{ sid: n.rc.controller.cse, title: n.rc.controller.title || 'Mission Controller' }] : []),
      ...(n.rc?.executors || []).filter((e) => e.cse).map((e) => ({ sid: e.cse as string, title: e.title || e.sid })),
    ];
    for (const x of rcExtra) {
      if (seenCse.has(x.sid)) continue;
      seenCse.add(x.sid);
      rows.push({
        key: `rc:${n.node}:${x.sid}`, kind: 'remote', id: x.sid, node: n.node, title: x.title,
        status: { connectionStatus: 'connected' }, statusDetail: 'remote-control', time: null,
        webUrl: `https://claude.ai/code/${x.sid}`,
      });
    }

    const bridgeBySession = new Map<string, Remote>();
    for (const r of n.remotes || []) if (r.sessionId) bridgeBySession.set(r.sessionId, r);

    for (const s of n.locals || []) {
      const bridge = bridgeBySession.get(s.sessionId);
      rows.push({
        key: `local:${n.node}:${s.sessionId}`, kind: 'local', id: s.sessionId, node: n.node,
        title: base(s.owner?.cwd) || base(s.jsonl) || 'session',
        repo: null, branch: null,
        status: { live: !!s.verdict?.live, connectionStatus: bridge ? 'connected' : null },
        statusDetail: bridge ? `bridged · ${bridge.mode}` : (s.owner?.status || null),
        time: null, webUrl: bridge?.webUrl || null,
        driveable: !!s.driveable || !!s.verdict?.live,
        local: s, remoteBridge: bridge,
      });
    }
  }
  return rows;
}

/** Per-node row counts (node-attributed rows only; cloud/null rows are account-wide). */
export function countRowsByNode(rows: CcrRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) if (r.node) m.set(r.node, (m.get(r.node) || 0) + 1);
  return m;
}

/** Back-compat shim for a single-node payload (kept for tests / gradual rollout). */
export function singleNodePayload(
  node: string,
  cloud: CloudSessionInfo[],
  snapshot: Omit<CcrNodeSnapshot, 'node'>,
): CcrFleetPayload {
  return { generatedAt: 0, self: node, cloud, nodes: [{ node, ...snapshot }], unreachable: [], partial: false };
}
