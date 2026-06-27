'use client';
import { useState, useEffect } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import type { MissionFull } from '@/lib/mission-graph-types';

export type ScheduleData = {
  ready: string[];
  blocked: { id: string; reason: string; waitOn?: string[] }[];
  serializeGroups: { group: string; missionIds: string[]; running: string | null }[];
  epicRollups: { parentId: string; status: string; progressPercent: number; childCount: number; doneCount: number }[];
  containers: string[];
};
export type SessionInfo = { sid: string; kind?: string; role?: string; lastContact?: number };

export function useMissionDetail(id: string | null) {
  const { apiClient, proxy } = useAppMode();
  const [mission, setMission] = useState<MissionFull | null>(null);
  const [schedule, setSchedule] = useState<ScheduleData | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) { setMission(null); setSchedule(null); setSessions([]); setError(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    const mid = proxy.machineId || undefined;
    Promise.all([
      apiClient.fetchPath<MissionFull>(`/mission/${encodeURIComponent(id)}`, { machineId: mid }),
      apiClient.fetchPath<ScheduleData>('/mission/schedule', { method: 'POST', body: {}, machineId: mid }).catch(() => null),
      apiClient.fetchPath<unknown>(`/mission/${encodeURIComponent(id)}/sessions`, { machineId: mid }).catch(() => null),
    ]).then(([m, sch, sessRaw]) => {
      if (cancelled) return;
      setMission(m ?? null);
      setSchedule(sch ?? null);
      // sessions route shape is best-effort: accept an array or {sessions:[...]}
      const arr = Array.isArray(sessRaw) ? sessRaw : ((sessRaw as { sessions?: SessionInfo[] })?.sessions ?? []);
      setSessions(arr as SessionInfo[]);
    }).catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, apiClient, proxy.machineId]);

  return { mission, schedule, sessions, loading, error };
}
