'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { machinesSignature } from '@/lib/session-list';
import type { Machine } from '@/lib/types';

interface UseMachinesResult {
  machines: Machine[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useMachines(): UseMachinesResult {
  const { apiClient, isLocal, isHybrid } = useAppMode();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Signature of the machine list we last published, so an unchanged poll does
  // not hand consumers a new array identity.
  const signatureRef = useRef<string | null>(null);

  const fetchMachines = useCallback(async () => {
    try {
      const result = await apiClient.getMachines();
      // Keep the array IDENTITY stable when nothing meaningful changed.
      // MachineContext derives onlineMachines from this array, and that lands in
      // the useCallback deps of useProjects and useSessions — so a new identity
      // every poll re-ran the whole page's fan-out. getMachines() also stamps a
      // fresh lastHeartbeat on the local machine every call, which meant the
      // payload ALWAYS looked different; machinesSignature() ignores that field.
      const signature = machinesSignature(result);
      if (signature !== signatureRef.current) {
        signatureRef.current = signature;
        setMachines(result);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch machines');
    } finally {
      setIsLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    fetchMachines();
    // Local: poll every 30s, Hub/Hybrid: poll every 10s
    const interval = isLocal ? 30000 : 10000;
    intervalRef.current = setInterval(fetchMachines, interval);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchMachines, isLocal]);

  return { machines, isLoading, error, refetch: fetchMachines };
}
