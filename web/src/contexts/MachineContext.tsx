'use client';

import { createContext, useContext, useState, useMemo, useCallback, useEffect, type ReactNode } from 'react';
import { useMachines } from '@/hooks/useMachines';
import type { Machine } from '@/lib/types';

const STORAGE_KEY = 'langmart-selected-machine';

interface MachineContextValue {
  machines: Machine[];
  onlineMachines: Machine[];
  isLoading: boolean;
  error: string | null;
  // Selected machine filter (null = all machines)
  selectedMachineId: string | null;
  setSelectedMachineId: (id: string | null) => void;
  // Convenience
  selectedMachine: Machine | null;
  isSingleMachine: boolean;
}

const MachineContext = createContext<MachineContextValue | null>(null);

export function MachineProvider({ children }: { children: ReactNode }) {
  const { machines, isLoading, error } = useMachines();
  const [selectedMachineId, setSelectedMachineIdRaw] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY);
  });

  const setSelectedMachineId = useCallback((id: string | null) => {
    setSelectedMachineIdRaw(id);
    if (id === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, id);
    }
  }, []);

  // Validate stored selection against available machines
  useEffect(() => {
    if (selectedMachineId && machines.length > 0 && !machines.find(m => m.id === selectedMachineId)) {
      setSelectedMachineId(null);
    }
  }, [machines, selectedMachineId, setSelectedMachineId]);

  const onlineMachines = useMemo(() =>
    machines.filter(m => m.status === 'online'),
    [machines]
  );

  const selectedMachine = useMemo(() =>
    selectedMachineId ? machines.find(m => m.id === selectedMachineId) || null : null,
    [selectedMachineId, machines]
  );

  const isSingleMachine = machines.length <= 1;

  const value = useMemo<MachineContextValue>(() => ({
    machines,
    onlineMachines,
    isLoading,
    error,
    selectedMachineId,
    setSelectedMachineId,
    selectedMachine,
    isSingleMachine,
  }), [machines, onlineMachines, isLoading, error, selectedMachineId, setSelectedMachineId, selectedMachine, isSingleMachine]);

  return (
    <MachineContext.Provider value={value}>
      {children}
    </MachineContext.Provider>
  );
}

export function useMachineContext(): MachineContextValue {
  const ctx = useContext(MachineContext);
  if (!ctx) throw new Error('useMachineContext must be used within MachineProvider');
  return ctx;
}
