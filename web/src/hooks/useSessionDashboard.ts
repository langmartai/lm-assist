'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';
import type { Session } from '@/lib/types';

export function useSessionDashboard() {
  const { apiClient, isLocal } = useAppMode();
  const { onlineMachines, selectedMachineId } = useMachineContext();
  const [availableSessions, setAvailableSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTerminals = useCallback(async () => {
    try {
      setError(null);
      const sessionList: Session[] = [];

      const targets = selectedMachineId
        ? onlineMachines.filter(m => m.id === selectedMachineId)
        : onlineMachines;

      await Promise.allSettled(
        targets.map(async machine => {
          const sessions = await apiClient.getSessions(isLocal ? undefined : machine.id);
          sessionList.push(...sessions);
        })
      );

      // Filter out sessions with 0 user prompts (special sessions, not resumable)
      const resumable = sessionList.filter(s => s.userPromptCount && s.userPromptCount > 0);

      // Sort by lastModified descending (most recent first)
      resumable.sort((a, b) =>
        new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
      );

      setAvailableSessions(resumable);
    } catch (err: any) {
      setError(err.message || 'Failed to load sessions');
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, isLocal, onlineMachines, selectedMachineId]);

  useEffect(() => {
    fetchTerminals();
    const interval = setInterval(fetchTerminals, 10000);
    return () => clearInterval(interval);
  }, [fetchTerminals]);

  return { availableSessions, isLoading, error, refetch: fetchTerminals };
}
