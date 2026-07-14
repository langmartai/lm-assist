'use client';

import { useCallback, useEffect, useState } from 'react';
import { Brain } from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { NodeSelector } from './NodeSelector';
import { MemoryBrowser } from './MemoryBrowser';
import { RulesBrowser } from './RulesBrowser';
import { SyncTab } from './SyncTab';
import { FileEditor } from './FileEditor';
import type { CallFn, EditTarget } from './types';

const TABS = ['memory', 'rules', 'sync'] as const;
type Tab = typeof TABS[number];

export function MemoryPage() {
  const { apiClient, proxy } = useAppMode();
  const [tab, setTab] = useState<Tab>('memory');
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selfNode, setSelfNode] = useState<string | null>(null);

  // Remote nodes are reached through THIS node's Core (`/peer-relay/<node>/…`,
  // server-side hub machine-proxy) — a LAN browser cannot call the hub gateway
  // directly (cross-origin + cloud-login gated → TypeError: Failed to fetch).
  const call: CallFn = useCallback(
    (path, opts) => apiClient.fetchPath(
      nodeId ? `/peer-relay/${encodeURIComponent(nodeId)}${path}` : path,
      {
        method: opts?.method, body: opts?.body,
        machineId: proxy.machineId ?? undefined,
      },
    ),
    [apiClient, nodeId, proxy.machineId],
  );

  // Self-node identity for the currently selected node (relay-aware: when
  // `nodeId` is set, `call` prefixes `/peer-relay/<node>`, so this resolves to
  // THAT node's identity) — used to badge records whose origin differs from
  // the node whose file copy is being viewed. Fire-and-forget: never blocks
  // record rendering, and a failure just leaves origin awareness off (null).
  useEffect(() => {
    let alive = true;
    setSelfNode(null);
    call<{ node: string; platform: string }>('/memory/self-node')
      .then((r) => { if (alive) setSelfNode(r.node); })
      .catch(() => { if (alive) setSelfNode(null); });
    return () => { alive = false; };
  }, [call]);

  return (
    // Page frame matches the app convention (see CoworkPage): full-height column
    // on --color-bg-root with a bordered header bar, then a padded content region.
    <div className="h-full flex flex-col overflow-hidden" style={{ background: 'var(--color-bg-root)' }}>
      <div className="flex flex-wrap items-center"
        style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border-default)', gap: 12 }}>
        <Brain size={20} style={{ color: 'var(--color-accent)' }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>Memory</div>
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          Project memory and user rules across your nodes.
        </span>
        <div className="flex items-center gap-2" style={{ marginLeft: 'auto' }}>
          <div className="flex gap-1">
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-sm rounded capitalize ${tab === t ? 'bg-gray-800 text-gray-100' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-900'}`}>
                {t}
              </button>
            ))}
          </div>
          <NodeSelector value={nodeId} onChange={setNodeId} />
        </div>
      </div>
      {nodeId && (
        <div className="text-amber-300/90 text-xs border-b border-amber-900/50 bg-amber-950/30 px-5 py-1.5">
          Viewing node {nodeId} via relay — reads and edits apply on that node.
        </div>
      )}
      {/* key= remounts tabs only on node switch; refreshTick drives an in-place re-fetch after a save instead */}
      <div key={nodeId ?? 'local'} className="flex-1 min-h-0" style={{ padding: 20 }}>
        {tab === 'memory' && <MemoryBrowser call={call} onEdit={setEditTarget} refreshTick={refreshKey} selfNode={selfNode} />}
        {tab === 'rules' && <RulesBrowser call={call} onEdit={setEditTarget} refreshTick={refreshKey} />}
        {tab === 'sync' && <SyncTab call={call} onEdit={setEditTarget} refreshTick={refreshKey} />}
      </div>
      {editTarget && (
        <FileEditor target={editTarget} call={call}
          onDone={(saved) => { setEditTarget(null); if (saved) setRefreshKey((k) => k + 1); }} />
      )}
    </div>
  );
}
