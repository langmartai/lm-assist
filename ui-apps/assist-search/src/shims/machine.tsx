/* Shim for '@/contexts/MachineContext' (aliased in build.mjs).
 *
 * A pane is served BY one node and its data plane targets that node — there is no
 * machine list to load and nothing to select. isSingleMachine:true is what hides
 * the machine column in SessionSidebar; the stub also drops useMachines (and its
 * getMachines fetch) out of the bundle graph entirely.
 */
import type { ReactNode } from 'react';

const LOCAL = {
  id: 'local',
  hostname: typeof window !== 'undefined' ? window.location.hostname : 'local',
  platform: 'linux',
  status: 'online' as const,
  lastHeartbeat: '',
  isLocal: true,
};

const VALUE = {
  machines: [LOCAL],
  onlineMachines: [LOCAL],
  isLoading: false,
  error: null,
  selectedMachineId: null,
  setSelectedMachineId: () => {},
  selectedMachine: LOCAL,
  isSingleMachine: true,
};

export function useMachineContext() {
  return VALUE as any;
}

export function MachineProvider({ children }: { children: ReactNode }) {
  return children as any;
}
