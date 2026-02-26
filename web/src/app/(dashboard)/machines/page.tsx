'use client';

import { useMachineContext } from '@/contexts/MachineContext';
import { useAppMode } from '@/contexts/AppModeContext';
import { detectAppMode } from '@/lib/api-client';
import { CrossRefStats } from '@/components/shared/CrossRefStats';
import { Monitor, LayoutDashboard } from 'lucide-react';
import { getPlatformEmoji } from '@/lib/utils';
import { useState } from 'react';

type FilterType = 'all' | 'online' | 'offline';

export default function MachinesPage() {
  const { machines, isLoading } = useMachineContext();
  const { mode, proxy } = useAppMode();
  const [filter, setFilter] = useState<FilterType>('online');

  const openDashboard = async (machine: typeof machines[0]) => {
    const hubName = 'langmart.ai';
    const remoteGatewayId = machine.gatewayId || machine.id;
    const dashboardPath = '/sessions';

    if (mode === 'hub') {
      // In hub mode, user is already on langmart.ai — navigate directly
      window.open(`https://${hubName}/w/${remoteGatewayId}/assist${dashboardPath}`, '_blank');
      return;
    }

    // In local/hybrid mode, fetch a proxy token for authentication
    try {
      const { baseUrl } = detectAppMode();
      const res = await fetch(`${baseUrl}/hub/machines/${remoteGatewayId}/proxy-token`, { method: 'POST' });
      const json = await res.json();
      if (json.success && json.data?.token) {
        window.open(`https://${hubName}/w/${remoteGatewayId}/assist${dashboardPath}?token=${json.data.token}`, '_blank');
        return;
      }
    } catch { /* fall through */ }
    window.open(`https://${hubName}/w/${remoteGatewayId}/assist${dashboardPath}`, '_blank');
  };

  const filtered = machines.filter(m => {
    if (filter === 'online') return m.status === 'online';
    if (filter === 'offline') return m.status === 'offline';
    return true;
  });

  const onlineCount = machines.filter(m => m.status === 'online').length;
  const offlineCount = machines.filter(m => m.status === 'offline').length;

  return (
    <div style={{ padding: 20, overflowY: 'auto', height: '100%', minWidth: 0 }} className="scrollbar-thin">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>Machines</h2>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['all', 'online', 'offline'] as FilterType[]).map(f => (
            <button
              key={f}
              className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? `All (${machines.length})` : f === 'online' ? `Online (${onlineCount})` : `Offline (${offlineCount})`}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[1, 2].map(i => <div key={i} className="skeleton" style={{ height: 100 }} />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <Monitor size={40} className="empty-state-icon" />
          <span style={{ fontSize: 14 }}>No machines {filter !== 'all' ? filter : 'connected'}</span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map(machine => (
            <div
              key={machine.id}
              className="card"
              style={{
                borderLeftWidth: 3,
                borderLeftColor: machine.status === 'online' ? 'var(--color-status-green)' : 'var(--color-text-tertiary)',
                opacity: machine.status === 'offline' ? 0.65 : 1,
              }}
            >
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 }}>
                {/* Platform icon */}
                <div style={{
                  width: 48,
                  height: 48,
                  flexShrink: 0,
                  background: 'var(--color-bg-active)',
                  borderRadius: 'var(--radius-md)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 24,
                }}>
                  {getPlatformEmoji(machine.platform)}
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                      {machine.hostname}
                    </span>
                    <span className={`status-dot ${machine.status === 'online' ? 'online' : 'offline'}`} />
                    <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                      {machine.platform}
                    </span>
                    {machine.osVersion && (
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                        {machine.osVersion}
                      </span>
                    )}
                  </div>
                  <CrossRefStats
                    compact
                    projects={machine.projectCount}
                    sessions={machine.sessionCount}
                    runningSessions={machine.runningSessionCount}
                    taskCounts={machine.taskCounts}
                    terminals={machine.activeTerminalCount}
                    cost={machine.totalCost}
                  />
                </div>

                {/* Actions — hide for current machine (already viewing it) */}
                {machine.status === 'online' && !machine.isLocal && !(proxy.isProxied && proxy.machineId === (machine.gatewayId || machine.id)) && (
                  <div style={{ flexShrink: 0 }}>
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => openDashboard(machine)}
                    >
                      <LayoutDashboard size={12} /> Dashboard
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
