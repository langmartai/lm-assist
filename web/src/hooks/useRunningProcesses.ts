'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';
import type { RunningProcessesResponse } from '@/lib/types';

const EMPTY: RunningProcessesResponse = {
  managed: [],
  allClaudeProcesses: [],
  summary: { totalManaged: 0, totalClaude: 0, unmanagedCount: 0, byCategory: {} },
};

export function useRunningProcesses(pollInterval = 5000) {
  const { apiClient, isLocal } = useAppMode();
  const { onlineMachines, selectedMachineId } = useMachineContext();
  const [data, setData] = useState<RunningProcessesResponse>(EMPTY);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Use refs for values that change frequently but shouldn't reset the interval
  const machinesRef = useRef(onlineMachines);
  machinesRef.current = onlineMachines;
  const selectedRef = useRef(selectedMachineId);
  selectedRef.current = selectedMachineId;
  const isLocalRef = useRef(isLocal);
  isLocalRef.current = isLocal;
  // Track known hash per machine for delta polling
  const hashRef = useRef<Map<string, string>>(new Map());

  const fetchProcesses = useCallback(async () => {
    try {
      setError(null);

      const machines = machinesRef.current;
      const selected = selectedRef.current;
      const local = isLocalRef.current;

      // In local mode, fetch directly without waiting for machines list.
      // getRunningProcesses() with no machineId works for local API.
      if (local) {
        const machineKey = '_local';
        const knownHash = hashRef.current.get(machineKey);

        if (knownHash) {
          const check = await apiClient.checkRunningProcesses(knownHash);
          if (!check.changed) return;
          if (check.data) {
            hashRef.current.set(machineKey, check.hash);
            // Stamp machine info from machines list if available
            const m = machines[0];
            const stamped = check.data.allClaudeProcesses.map(p => ({
              ...p,
              machineId: m?.id || 'local',
              machineHostname: m?.hostname || 'localhost',
            }));
            setData({ ...check.data, allClaudeProcesses: stamped });
            return;
          }
        }

        const raw = await apiClient.getRunningProcesses();
        if (raw.hash) hashRef.current.set(machineKey, raw.hash);
        const m = machines[0];
        const stamped = raw.allClaudeProcesses.map(p => ({
          ...p,
          machineId: m?.id || 'local',
          machineHostname: m?.hostname || 'localhost',
        }));
        setData({ ...raw, allClaudeProcesses: stamped });
        return;
      }

      // Hub/hybrid mode: need machines list to know which machines to query
      const targets = selected
        ? machines.filter(m => m.id === selected)
        : machines;

      if (targets.length === 0) {
        // Machines not loaded yet — don't overwrite existing data, just skip
        return;
      }

      if (targets.length === 1) {
        const machineId = targets[0].id;
        const machineKey = machineId;
        const knownHash = hashRef.current.get(machineKey);

        if (knownHash) {
          const check = await apiClient.checkRunningProcesses(knownHash, machineId);
          if (!check.changed) return;
          if (check.data) {
            hashRef.current.set(machineKey, check.hash);
            const stamped = check.data.allClaudeProcesses.map(p => ({
              ...p,
              machineId: targets[0].id,
              machineHostname: targets[0].hostname,
            }));
            setData({ ...check.data, allClaudeProcesses: stamped });
            return;
          }
        }

        const raw = await apiClient.getRunningProcesses(machineId);
        if (raw.hash) hashRef.current.set(machineKey, raw.hash);
        const stamped = raw.allClaudeProcesses.map(p => ({
          ...p,
          machineId: targets[0].id,
          machineHostname: targets[0].hostname,
        }));
        setData({ ...raw, allClaudeProcesses: stamped });
      } else {
        // Multi-machine: parallel fetch + merge
        const results = await Promise.allSettled(
          targets.map(async machine => {
            const machineKey = machine.id;
            const knownHash = hashRef.current.get(machineKey);

            if (knownHash) {
              const check = await apiClient.checkRunningProcesses(knownHash, machine.id);
              if (!check.changed) {
                return { machine, result: null, unchanged: true };
              }
              if (check.data) {
                hashRef.current.set(machineKey, check.hash);
                return { machine, result: check.data, unchanged: false };
              }
            }

            const r = await apiClient.getRunningProcesses(machine.id);
            if (r.hash) hashRef.current.set(machineKey, r.hash);
            return { machine, result: r, unchanged: false };
          })
        );

        const allUnchanged = results.every(
          r => r.status === 'fulfilled' && r.value.unchanged
        );
        if (allUnchanged) return;

        const merged: RunningProcessesResponse = {
          managed: [],
          allClaudeProcesses: [],
          summary: { totalManaged: 0, totalClaude: 0, unmanagedCount: 0, byCategory: {} },
        };

        for (const r of results) {
          if (r.status !== 'fulfilled' || !r.value.result) continue;
          const { machine, result: res } = r.value;
          merged.managed.push(...res.managed);
          merged.allClaudeProcesses.push(
            ...res.allClaudeProcesses.map(p => ({
              ...p,
              machineId: machine.id,
              machineHostname: machine.hostname,
            }))
          );
          merged.summary.totalManaged += res.summary.totalManaged;
          merged.summary.totalClaude += res.summary.totalClaude;
          merged.summary.unmanagedCount += res.summary.unmanagedCount;
          for (const [cat, count] of Object.entries(res.summary.byCategory)) {
            merged.summary.byCategory[cat] = (merged.summary.byCategory[cat] || 0) + (count as number);
          }
        }

        setData(merged);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load processes');
    } finally {
      setIsLoading(false);
    }
  }, [apiClient]); // Only depends on apiClient (stable singleton)

  useEffect(() => {
    fetchProcesses();
    const interval = setInterval(fetchProcesses, pollInterval);
    return () => clearInterval(interval);
  }, [fetchProcesses, pollInterval]);

  // Hub/hybrid mode: trigger immediate fetch when machines first become available
  // (initial fetch fires before machines are loaded, so it skips)
  const hadMachinesRef = useRef(false);
  useEffect(() => {
    if (!isLocal && onlineMachines.length > 0 && !hadMachinesRef.current) {
      hadMachinesRef.current = true;
      fetchProcesses();
    }
  }, [isLocal, onlineMachines.length, fetchProcesses]);

  return { data, isLoading, error, refetch: fetchProcesses };
}
