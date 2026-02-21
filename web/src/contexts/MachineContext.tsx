'use client';

import { createContext, useContext, useState, useMemo, useCallback, useEffect, useRef, type ReactNode } from 'react';
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
  const [selectedMachineId, setSelectedMachineIdRaw] = useState<string | null>(null);
  const hasInitialized = useRef(false);

  const setSelectedMachineId = useCallback((id: string | null) => {
    setSelectedMachineIdRaw(id);
    if (id === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, id);
    }
  }, []);

  // On first load, always select the local machine.
  // On subsequent polls, validate existing selection and fall back if needed.
  useEffect(() => {
    if (machines.length === 0) return;

    if (!hasInitialized.current) {
      // First time machines are available: always prefer the local machine
      const localMachine = machines.find(m => m.isLocal);
      if (localMachine) {
        setSelectedMachineId(localMachine.id);
      } else {
        // No isLocal flag — try localStorage, then fall back to first machine
        const stored = localStorage.getItem(STORAGE_KEY);
        const storedMachine = stored ? machines.find(m => m.id === stored) : null;
        setSelectedMachineId(storedMachine ? storedMachine.id : machines[0].id);
      }
      hasInitialized.current = true;
      return;
    }

    // After init: validate selection still exists
    if (selectedMachineId && !machines.find(m => m.id === selectedMachineId)) {
      const localMachine = machines.find(m => m.isLocal) || machines[0];
      setSelectedMachineId(localMachine ? localMachine.id : null);
    }
    // If somehow null after init, pick local
    if (!selectedMachineId) {
      const localMachine = machines.find(m => m.isLocal) || machines[0];
      if (localMachine) {
        setSelectedMachineId(localMachine.id);
      }
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
