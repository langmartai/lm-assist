'use client';

import { useCallback, useState } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { NodeSelector } from './NodeSelector';
import { MemoryBrowser } from './MemoryBrowser';
import { RulesBrowser } from './RulesBrowser';
import { SyncTab } from './SyncTab';
import type { CallFn } from './types';

const TABS = ['memory', 'rules', 'sync'] as const;
type Tab = typeof TABS[number];

export function MemoryPage() {
  const { apiClient, proxy } = useAppMode();
  const [tab, setTab] = useState<Tab>('memory');
  const [nodeId, setNodeId] = useState<string | null>(null);

  const call: CallFn = useCallback(
    (path, opts) => apiClient.fetchPath(path, {
      method: opts?.method, body: opts?.body,
      machineId: nodeId ?? proxy.machineId ?? undefined,
    }),
    [apiClient, nodeId, proxy.machineId],
  );

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">Memory</h1>
          <p className="text-sm text-gray-400">Project memory and user rules across your nodes.</p>
        </div>
        <NodeSelector value={nodeId} onChange={setNodeId} />
      </div>
      <div className="flex gap-1 border-b border-gray-800">
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-sm rounded-t capitalize ${tab === t ? 'bg-gray-800 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}>
            {t}
          </button>
        ))}
      </div>
      {/* key= remounts tabs on node switch so stale node data can't linger */}
      <div key={nodeId ?? 'local'}>
        {tab === 'memory' && <MemoryBrowser call={call} />}
        {tab === 'rules' && <RulesBrowser call={call} />}
        {tab === 'sync' && <SyncTab call={call} />}
      </div>
    </div>
  );
}
