'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';
import type { SessionTask } from '@/lib/types';

export interface TaskFilters {
  machineId?: string;
  projectName?: string;
  status?: 'all' | 'pending' | 'in_progress' | 'completed';
  groupBy: 'project' | 'machine' | 'session' | 'none';
}

export interface TaskGroup {
  key: string;
  label: string;
  sublabel?: string;
  tasks: SessionTask[];
  machineId?: string;
  machineHostname?: string;
  machinePlatform?: string;
  machineStatus?: 'online' | 'offline';
}

export function useTasks() {
  const { apiClient, isLocal, isHybrid } = useAppMode();
  const { onlineMachines, selectedMachineId } = useMachineContext();
  const [allTasks, setAllTasks] = useState<SessionTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<TaskFilters>({ groupBy: 'project', status: 'all' });

  const fetchTasks = useCallback(async () => {
    try {
      setError(null);
      let tasks: SessionTask[] = [];

      if (isLocal) {
        const result = await apiClient.getTaskStoreAll();
        tasks = result.tasks;
        // Enrich with local machine info if available (so platform badge shows correctly)
        const localMachine = onlineMachines.find(m => m.isLocal) || onlineMachines[0];
        if (localMachine) {
          tasks = tasks.map(t => ({
            ...t,
            machineId: t.machineId || localMachine.id,
            machineHostname: t.machineHostname || localMachine.hostname,
            machinePlatform: t.machinePlatform || localMachine.platform,
            machineStatus: t.machineStatus || localMachine.status,
          }));
        }
      } else {
        // Hybrid/Hub mode: fetch from online machines
        const machineIds = selectedMachineId
          ? [selectedMachineId]
          : onlineMachines.map(m => m.id);

        if (isHybrid && machineIds.length === 0) {
          // No machines yet — fall back to local-only fetch
          const result = await apiClient.getTaskStoreAll();
          tasks = result.tasks;
          // Enrich with local machine info if available
          const localMachine = onlineMachines.find(m => m.isLocal) || onlineMachines[0];
          if (localMachine) {
            tasks = tasks.map(t => ({
              ...t,
              machineId: t.machineId || localMachine.id,
              machineHostname: t.machineHostname || localMachine.hostname,
              machinePlatform: t.machinePlatform || localMachine.platform,
              machineStatus: t.machineStatus || localMachine.status,
            }));
          }
        } else {
          const results = await Promise.allSettled(
            machineIds.map(async id => {
              const m = onlineMachines.find(m => m.id === id);
              const result = await apiClient.getTaskStoreAll(id);
              return result.tasks.map(t => ({
                ...t,
                machineId: id,
                machineHostname: m?.hostname || id,
                machinePlatform: m?.platform || 'linux',
                machineStatus: m?.status || 'online',
              }));
            })
          );

          for (const r of results) {
            if (r.status === 'fulfilled') {
              tasks.push(...r.value);
            }
          }
        }
      }

      setAllTasks(tasks);
    } catch (err: any) {
      setError(err.message || 'Failed to load tasks');
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, isLocal, isHybrid, onlineMachines, selectedMachineId]);

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 10000);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  // Apply filters
  const filteredTasks = useMemo(() => {
    let tasks = allTasks;
    if (filters.machineId) {
      tasks = tasks.filter(t => t.machineId === filters.machineId);
    }
    if (filters.projectName) {
      tasks = tasks.filter(t => t.projectName === filters.projectName);
    }
    if (filters.status && filters.status !== 'all') {
      tasks = tasks.filter(t => t.status === filters.status);
    }
    return tasks;
  }, [allTasks, filters]);

  // Group tasks
  const groups = useMemo((): TaskGroup[] => {
    if (filters.groupBy === 'none') {
      return [{ key: 'all', label: 'All Tasks', tasks: filteredTasks }];
    }

    const map = new Map<string, TaskGroup>();

    for (const task of filteredTasks) {
      let key: string;
      let label: string;
      let sublabel: string | undefined;

      switch (filters.groupBy) {
        case 'project':
          key = `${task.projectName || 'Unknown'}__${task.machineId || ''}`;
          label = task.projectName || 'Unknown Project';
          sublabel = task.machineHostname;
          break;
        case 'machine':
          key = task.machineId || 'unknown';
          label = task.machineHostname || 'Unknown Machine';
          break;
        case 'session':
          key = task.sessionId || 'unknown';
          label = task.sessionId ? task.sessionId.slice(0, 8) : 'Unknown Session';
          sublabel = task.projectName;
          break;
        default:
          key = 'all';
          label = 'All';
      }

      if (!map.has(key)) {
        map.set(key, {
          key,
          label,
          sublabel,
          tasks: [],
          machineId: task.machineId,
          machineHostname: task.machineHostname,
          machinePlatform: task.machinePlatform,
          machineStatus: task.machineStatus,
        });
      }
      map.get(key)!.tasks.push(task);
    }

    return Array.from(map.values());
  }, [filteredTasks, filters.groupBy]);

  // Unique values for filters
  const projectNames = useMemo(() =>
    [...new Set(allTasks.map(t => t.projectName).filter(Boolean))] as string[],
    [allTasks]
  );

  const counts = useMemo(() => ({
    pending: filteredTasks.filter(t => t.status === 'pending').length,
    inProgress: filteredTasks.filter(t => t.status === 'in_progress').length,
    completed: filteredTasks.filter(t => t.status === 'completed').length,
    total: filteredTasks.length,
    totalAll: allTasks.length,
  }), [filteredTasks, allTasks]);

  return {
    allTasks,
    filteredTasks,
    groups,
    isLoading,
    error,
    filters,
    setFilters,
    refetch: fetchTasks,
    projectNames,
    counts,
  };
}
