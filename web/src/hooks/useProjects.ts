'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';
import type { Project } from '@/lib/types';

export function useProjects() {
  const { apiClient, isLocal } = useAppMode();
  const { machines, onlineMachines, selectedMachineId } = useMachineContext();
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProjects = useCallback(async () => {
    try {
      setError(null);
      let projects: Project[] = [];

      if (isLocal) {
        projects = await apiClient.getProjects();
      } else {
        // Hub: fetch from each online machine (or selected machine)
        const targets = selectedMachineId
          ? onlineMachines.filter(m => m.id === selectedMachineId)
          : onlineMachines;

        const results = await Promise.allSettled(
          targets.map(m => apiClient.getProjects(m.id))
        );

        for (const r of results) {
          if (r.status === 'fulfilled') {
            projects.push(...r.value);
          }
        }
      }

      setAllProjects(projects);
    } catch (err: any) {
      setError(err.message || 'Failed to load projects');
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, isLocal, onlineMachines, selectedMachineId]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // Filter by selected machine, sort git projects first + most recently used
  const projects = useMemo(() => {
    // Find if the selected machine is the local one (may have gatewayId instead of 'localhost')
    const selectedIsLocal = selectedMachineId
      ? machines.find(m => m.id === selectedMachineId)?.isLocal
      : false;
    let result = selectedMachineId
      ? allProjects.filter(p =>
          p.machineId === selectedMachineId ||
          // In local mode, projects have machineId='localhost' but machine may use gatewayId
          (selectedIsLocal && (p.machineId === 'localhost' || p.machineId === selectedMachineId))
        )
      : [...allProjects];
    // Sort: git projects first, then by most recent activity
    result.sort((a, b) => {
      const aGit = a.isGitProject !== false ? 1 : 0;
      const bGit = b.isGitProject !== false ? 1 : 0;
      if (aGit !== bGit) return bGit - aGit;
      const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return bTime - aTime;
    });
    return result;
  }, [allProjects, selectedMachineId]);

  return { projects, allProjects, isLoading, error, refetch: fetchProjects };
}
