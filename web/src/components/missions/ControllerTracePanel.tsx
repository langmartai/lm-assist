'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Activity, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';

/**
 * Controller trace — the tractability cockpit, in the UI. One collapsible
 * panel over GET /mission/controller/trace: election verdict (with the
 * indeterminate/stale flags), the controller record + liveness, the lineage
 * (which session is in charge and how it got there) and the control journal
 * (every decision with its inputs, every drive with its outcome).
 */

interface TraceData {
  election: { isMonitor?: boolean; monitorNodeId?: string | null; indeterminate?: boolean; stale?: boolean } | null;
  record: { sessionId?: string; tmux?: string; cse?: string | null; startedAt?: number } | null;
  live: boolean;
  lineage: Array<{ at: number; event: string; sessionId?: string | null; tmux?: string | null; reason?: string }>;
  journal: Array<{ at: number; kind: string; [k: string]: unknown }>;
}

const KIND_COLOR: Record<string, string> = {
  boot: 'var(--color-accent)',
  tick: 'var(--color-status-orange, #b8860b)',
  election: 'var(--color-status-orange, #b8860b)',
  drive: 'var(--color-status-green)',
  lifecycle: 'var(--color-text-secondary)',
};

const ago = (at: number, now: number): string => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

function journalLine(e: TraceData['journal'][number]): string {
  if (e.kind === 'drive') return `drive → ${e.transport}${e.ok ? ' ok' : ` FAILED${e.error ? `: ${String(e.error).slice(0, 60)}` : ''}`}`;
  if (e.kind === 'boot') return `boot — record ${String(e.record ?? 'none').slice(0, 8)} live=${String(e.live)} monitor=${String(e.isMonitor)}`;
  if (e.kind === 'lifecycle') return `${e.event} ${String(e.sessionId ?? '').slice(0, 8)}${e.tmux ? ` · ${e.tmux}` : ''}`;
  const bits = [`${e.action ?? 'tick'}`, `monitor=${String(e.isMonitor)}`];
  if (e.indeterminate) bits.push('indeterminate');
  if (e.stale) bits.push('stale');
  if (typeof e.notMonitorStreak === 'number' && (e.notMonitorStreak as number) > 0) bits.push(`streak=${e.notMonitorStreak}`);
  if (e.reason) bits.push(String(e.reason).slice(0, 80));
  return bits.join(' · ');
}

export function ControllerTracePanel({ apiFetch }: {
  apiFetch: <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<TraceData | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch<{ data?: TraceData } & TraceData>('/mission/controller/trace');
      const d = (res as { data?: TraceData }).data ?? (res as TraceData);
      if (d && 'journal' in d) { setData(d); setNowMs(Date.now()); }
    } catch { /* keep last */ }
    finally { setBusy(false); }
  }, [apiFetch]);

  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    if (!open) return;
    loadRef.current();
    const t = setInterval(() => loadRef.current(), 10000);
    return () => clearInterval(t);
  }, [open]);

  const el = data?.election;
  const electionPill = el
    ? el.indeterminate ? { label: 'indeterminate', cls: 'badge-default' }
      : el.stale ? { label: `monitor (stale)`, cls: 'badge-orange' }
      : el.isMonitor ? { label: 'monitor', cls: 'badge-green' }
      : { label: 'not monitor', cls: 'badge-orange' }
    : null;

  return (
    <div style={{ borderBottom: '1px solid var(--color-border-subtle)', flexShrink: 0 }}>
      <button onClick={() => setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '6px 16px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 11.5, color: 'var(--color-text-secondary)', textAlign: 'left' }}
        title="Election verdict + lineage + control journal (GET /mission/controller/trace)">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Activity size={12} />
        <span style={{ fontWeight: 600 }}>Trace</span>
        {open && electionPill && <span className={`badge ${electionPill.cls}`} style={{ fontSize: 9.5 }}>{electionPill.label}</span>}
        {open && data?.record?.sessionId && (
          <span style={{ color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
            {data.record.sessionId.slice(0, 8)} · {data.record.tmux}{data.live ? ' · live' : ' · dead'}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {open && (
          <span onClick={(e) => { e.stopPropagation(); loadRef.current(); }} title="Refresh" style={{ display: 'inline-flex', padding: 2 }}>
            <RefreshCw size={11} style={busy ? { animation: 'spin 1s linear infinite' } : undefined} />
          </span>
        )}
      </button>

      {open && data && (
        <div style={{ display: 'flex', gap: 0, maxHeight: 260, overflow: 'hidden', borderTop: '1px solid var(--color-border-subtle)' }}>
          {/* Control journal */}
          <div style={{ flex: 3, minWidth: 0, overflow: 'auto', padding: '6px 10px 8px 16px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>Control journal</div>
            {[...data.journal].reverse().map((e, i) => (
              <div key={`${e.at}-${i}`} title={JSON.stringify(e)} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11, padding: '1.5px 0', color: 'var(--color-text-secondary)' }}>
                <span style={{ color: 'var(--color-text-tertiary)', flexShrink: 0, minWidth: 26, textAlign: 'right' }}>{ago(e.at, nowMs)}</span>
                <span style={{ color: KIND_COLOR[e.kind] || 'var(--color-text-secondary)', flexShrink: 0, minWidth: 52, fontWeight: 600 }}>{e.kind}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{journalLine(e)}</span>
              </div>
            ))}
            {data.journal.length === 0 && <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>No journal entries yet.</div>}
          </div>
          {/* Lineage */}
          <div style={{ flex: 2, minWidth: 0, overflow: 'auto', padding: '6px 16px 8px 10px', borderLeft: '1px solid var(--color-border-subtle)' }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>Controller lineage</div>
            {[...data.lineage].reverse().map((e, i) => (
              <div key={`${e.at}-${i}`} title={e.reason || ''} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11, padding: '1.5px 0', color: 'var(--color-text-secondary)' }}>
                <span style={{ color: 'var(--color-text-tertiary)', flexShrink: 0, minWidth: 26, textAlign: 'right' }}>{ago(e.at, nowMs)}</span>
                <span style={{ color: e.event === 'teardown' || e.event === 'resume-failed' ? 'var(--color-status-red)' : 'var(--color-status-green)', flexShrink: 0, fontWeight: 600, minWidth: 62 }}>{e.event}</span>
                <span style={{ fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(e.sessionId || '').slice(0, 8)}{e.tmux ? ` · ${e.tmux}` : ''}</span>
              </div>
            ))}
            {data.lineage.length === 0 && <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>No lineage yet.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
