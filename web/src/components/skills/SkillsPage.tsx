'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';
import { SkillList } from './SkillList';
import { SkillDetail } from './SkillDetail';
import { SkillAnalytics } from './SkillAnalytics';

export function SkillsPage() {
  const { apiClient, proxy } = useAppMode();
  const { selectedMachineId } = useMachineContext();

  const machineIdRef = useRef(selectedMachineId);
  machineIdRef.current = selectedMachineId;
  const apiClientRef = useRef(apiClient);
  apiClientRef.current = apiClient;

  const apiFetch = useCallback(async <T,>(path: string): Promise<T> => {
    return apiClientRef.current.fetchPath<T>(path, {
      machineId: machineIdRef.current || proxy.machineId || undefined,
    });
  }, [proxy.machineId]);

  const [selectedSkill, setSelectedSkill] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('lm-assist:selectedSkill') || null;
    }
    return null;
  });

  useEffect(() => {
    if (selectedSkill) {
      localStorage.setItem('lm-assist:selectedSkill', selectedSkill);
    } else {
      localStorage.removeItem('lm-assist:selectedSkill');
    }
  }, [selectedSkill]);

  return (
    <div style={{
      display: 'flex',
      height: '100%',
      overflow: 'hidden',
      background: 'var(--color-bg-root)',
    }}>
      {/* Left panel: Skill inventory */}
      <div style={{
        width: 280,
        flexShrink: 0,
        borderRight: '1px solid var(--color-border-default)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-bg-surface)',
      }}>
        <SkillList
          apiFetch={apiFetch}
          selectedSkill={selectedSkill}
          onSelectSkill={setSelectedSkill}
        />
      </div>

      {/* Center panel: Skill detail */}
      <div style={{
        flex: 1,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-bg-root)',
      }}>
        <SkillDetail
          apiFetch={apiFetch}
          skillName={selectedSkill}
        />
      </div>

      {/* Right panel: Analytics */}
      <div style={{
        width: 320,
        flexShrink: 0,
        borderLeft: '1px solid var(--color-border-default)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-bg-surface)',
      }}>
        <SkillAnalytics apiFetch={apiFetch} />
      </div>
    </div>
  );
}
