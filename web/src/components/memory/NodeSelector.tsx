'use client';

import { useMachines } from '@/hooks/useMachines';
import { useAppMode } from '@/contexts/AppModeContext';

/** Pick which node's live memory/rules the page operates on. null = this node
 *  (or the proxied machine in cloud mode). Hidden when there is nothing to pick. */
export function NodeSelector({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const { machines } = useMachines();
  const { proxy } = useAppMode();
  // Relay machine identifier is `gatewayId || id` — the same expression
  // MachineDropdown.tsx uses (`remoteGatewayId = m.gatewayId || m.id`).
  const relayId = (m: { id: string; gatewayId?: string }) => m.gatewayId || m.id;
  const others = machines.filter(m =>
    m.status === 'online' && !m.isLocal && relayId(m) !== proxy.machineId);
  if (others.length === 0) return null;
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
      title="Which node's live memory/rules to browse and edit"
    >
      <option value="">This node</option>
      {others.map(m => <option key={m.id} value={relayId(m)}>{m.hostname}</option>)}
    </select>
  );
}
