'use client';
import Link from 'next/link';
import { useMissionDetail } from '@/hooks/useMissionDetail';
import type { MissionEdge } from '@/lib/mission-graph-types';

const STATUS_COLOR: Record<string, string> = {
  active: '#34d399', waiting: '#fbbf24', paused: '#9ca3af', blocked: '#f87171', done: '#60a5fa', failed: '#ef4444', draft: '#6b7280',
};

function rel(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function MissionNodeDetail({ nodeId, edges, onSelect, onClose }: {
  nodeId: string | null;
  edges: MissionEdge[];
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  const { mission, schedule, sessions, loading } = useMissionDetail(nodeId);
  if (!nodeId) return null;

  // relationships from the loaded graph edges (parent edge = {from:parentId,to:childId}; dependsOn = {from:me,to:dep})
  const children = edges.filter((e) => e.type === 'parent' && e.from === nodeId).map((e) => e.to);
  const dependents = edges.filter((e) => e.type === 'dependsOn' && e.to === nodeId).map((e) => e.from);
  const parentId = mission?.parentId ?? null;
  const dependsOn = mission?.dependsOn ?? [];

  // this mission's scheduling state
  const blocked = schedule?.blocked.find((b) => b.id === nodeId);
  const serial = schedule?.serializeGroups.find((g) => g.missionIds.includes(nodeId));
  const epic = schedule?.epicRollups.find((r) => r.parentId === nodeId);
  const sched = blocked ? `Blocked: ${blocked.reason}${blocked.waitOn?.length ? ` (waiting on ${blocked.waitOn.join(', ')})` : ''}`
    : schedule?.ready.includes(nodeId) ? 'Ready'
    : epic ? `Epic: ${epic.doneCount}/${epic.childCount} done`
    : serial ? `Serialized in "${serial.group}"${serial.running && serial.running !== nodeId ? ' (queued)' : ''}`
    : null;

  const Chip = ({ id }: { id: string }) => (
    <button onClick={() => onSelect(id)} className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-blue-300 hover:border-blue-400 hover:text-blue-200" title={id}>{id}</button>
  );

  return (
    <div className="w-80 shrink-0 overflow-y-auto border-l border-neutral-800 p-4 text-sm">
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="font-semibold text-neutral-100">{mission?.title ?? nodeId}</h3>
        <button onClick={onClose} className="shrink-0 text-neutral-500 hover:text-neutral-200">✕</button>
      </div>
      <div className="mb-3 flex items-center gap-2 text-xs">
        <span className="rounded px-1.5 py-0.5" style={{ background: (STATUS_COLOR[mission?.status ?? ''] ?? '#6b7280') + '33', color: STATUS_COLOR[mission?.status ?? ''] ?? '#9ca3af' }}>{mission?.status ?? '…'}</span>
        {mission?.progress?.percent != null && <span className="text-neutral-400">{mission.progress.percent}%</span>}
        {sched && <span className="text-neutral-400">· {sched}</span>}
      </div>
      {loading && !mission && <div className="text-xs text-neutral-500">Loading…</div>}

      {mission?.objective && <Section title="Objective"><p className="text-neutral-300">{mission.objective}</p></Section>}
      {mission?.plan && <Section title="Plan"><p className="whitespace-pre-wrap text-neutral-300">{mission.plan}</p></Section>}
      {mission?.nextSteps?.length ? <Section title="Next steps"><ul className="list-disc pl-4 text-neutral-300">{mission.nextSteps.map((s, i) => <li key={i}>{s}</li>)}</ul></Section> : null}

      {mission?.tags && Object.keys(mission.tags).length > 0 && (
        <Section title="Tags">
          <div className="space-y-1">
            {Object.entries(mission.tags).map(([dim, vals]) => (
              <div key={dim} className="flex flex-wrap items-center gap-1 text-xs">
                <span className={dim.startsWith('ctl:') ? 'text-amber-400' : 'text-neutral-500'}>{dim}{dim.startsWith('ctl:') ? ' (controller)' : ''}:</span>
                {vals.map((v) => <span key={v} className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-200">{v}</span>)}
              </div>
            ))}
          </div>
        </Section>
      )}

      {(parentId || dependsOn.length || children.length || dependents.length) ? (
        <Section title="Relationships">
          <div className="space-y-1 text-xs">
            {parentId && <div className="flex flex-wrap items-center gap-1"><span className="text-neutral-500">parent:</span> <Chip id={parentId} /></div>}
            {dependsOn.length > 0 && <div className="flex flex-wrap items-center gap-1"><span className="text-neutral-500">depends on:</span> {dependsOn.map((d) => <Chip key={d} id={d} />)}</div>}
            {dependents.length > 0 && <div className="flex flex-wrap items-center gap-1"><span className="text-neutral-500">blocks:</span> {dependents.map((d) => <Chip key={d} id={d} />)}</div>}
            {children.length > 0 && <div className="flex flex-wrap items-center gap-1"><span className="text-neutral-500">children:</span> {children.map((d) => <Chip key={d} id={d} />)}</div>}
          </div>
        </Section>
      ) : null}

      {mission?.history?.length ? (
        <Section title="Recent changes">
          <div className="space-y-1 text-[11px] text-neutral-400">
            {mission.history.slice(-5).reverse().map((h) => (
              <div key={h.rev}>r{h.rev} · {h.actor?.label ?? h.actor?.kind ?? 'unknown'} · {rel(h.at)} · {Object.keys(h.changes ?? {}).join(', ')}</div>
            ))}
          </div>
        </Section>
      ) : null}

      {sessions.length > 0 && (
        <Section title="Sessions">
          <div className="space-y-1 text-[11px] text-neutral-400">{sessions.map((s) => <div key={s.sid}>{s.sid.slice(0, 12)} · {s.status ?? s.transport ?? ''}</div>)}</div>
        </Section>
      )}

      <Link href={`/missions?mission=${encodeURIComponent(nodeId)}`} className="mt-3 inline-block text-xs text-blue-400 hover:underline">Open in Missions →</Link>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 border-t border-neutral-800 pt-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">{title}</div>
      {children}
    </div>
  );
}
