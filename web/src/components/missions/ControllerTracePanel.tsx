'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw } from 'lucide-react';

/**
 * Controller trace — the tractability cockpit, in the UI. The TOGGLE lives in
 * the controller header row (MissionsPage owns it); this component renders the
 * expanded body: a one-line HEALTH SUMMARY synthesized from the data, then the
 * control journal and controller lineage as plain-language timelines a user
 * can read without knowing the internals.
 */

interface TraceData {
  election: { isMonitor?: boolean; monitorNodeId?: string | null; indeterminate?: boolean; stale?: boolean } | null;
  record: { sessionId?: string; tmux?: string; cse?: string | null; startedAt?: number } | null;
  live: boolean;
  lineage: Array<{ at: number; event: string; sessionId?: string | null; tmux?: string | null; reason?: string }>;
  journal: Array<{ at: number; kind: string; [k: string]: unknown }>;
}

const ago = (at: number, now: number): string => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

type Tone = 'good' | 'warn' | 'bad' | 'info';
const TONE_COLOR: Record<Tone, string> = {
  good: 'var(--color-status-green)',
  warn: 'var(--color-status-orange, #b8860b)',
  bad: 'var(--color-status-red)',
  info: 'var(--color-text-secondary)',
};

/** Plain-language rendering of a journal entry: what happened + why it matters. */
export function describeJournal(e: TraceData['journal'][number]): { label: string; detail: string; tone: Tone } {
  const sid = String(e.sid ?? e.record ?? '').slice(0, 8);
  switch (e.kind) {
    case 'drive': {
      const via = e.transport === 'cloud' ? 'via its claude.ai bridge' : 'into its terminal';
      return e.ok
        ? { label: 'Pass delivered', detail: `sent the controller its work directive ${via}`, tone: 'good' }
        : { label: 'Pass FAILED', detail: `couldn't deliver the directive ${via}${e.error ? ` — ${String(e.error).slice(0, 70)}` : ''} (3 in a row triggers auto-relaunch)`, tone: 'bad' };
    }
    case 'boot':
      return {
        label: 'Core started',
        detail: e.record
          ? `found controller ${sid} ${e.live ? 'running' : 'not running'}; this node ${e.isMonitor ? 'is' : 'is not'} the leader`
          : 'no controller on record yet',
        tone: 'info',
      };
    case 'lifecycle':
      if (e.event === 'resumed') return { label: 'Controller resumed', detail: `continued the SAME session ${sid} from its history — context preserved`, tone: 'good' };
      if (e.event === 'launched') return { label: 'New controller started', detail: `fresh session ${sid} (no usable history to resume)`, tone: 'warn' };
      return { label: 'Controller stopped', detail: `session ${sid} torn down`, tone: 'warn' };
    case 'election': {
      return e.isMonitor
        ? { label: 'Became leader', detail: 'this node now runs the controller', tone: 'good' }
        : { label: 'Lost leadership', detail: `another node (${String(e.monitorNodeId ?? '?').slice(0, 12)}…) is the leader now`, tone: 'warn' };
    }
    default: { // tick decisions
      const a = String(e.action ?? 'tick');
      if (a === 'churn-backoff') return { label: 'Held a relaunch', detail: `${e.launchesInWindow} launches in 10 min — pausing so a crash cycle can't run away`, tone: 'warn' };
      if (a === 'launch') return { label: 'Relaunching controller', detail: String(e.reason ?? 'no live session found — will resume from history if possible'), tone: 'warn' };
      if (a === 'teardown') return { label: 'Tearing down', detail: `confirmed not the leader for ${e.notMonitorStreak ?? 2}+ checks — cleaning up`, tone: 'bad' };
      if (a === 'drive') return { label: 'Work pass due', detail: 'sending the controller its periodic directive', tone: 'info' };
      const flags = [e.indeterminate ? 'election could not be determined (holding safely)' : null, e.stale ? 'using last known election result' : null].filter(Boolean).join('; ');
      return { label: a, detail: flags || `leader=${String(e.isMonitor)}`, tone: 'info' };
    }
  }
}

/** Plain-language rendering of a lineage (identity) event. */
export function describeLineage(e: TraceData['lineage'][number]): { label: string; detail: string; tone: Tone } {
  const sid = (e.sessionId || '').slice(0, 8);
  switch (e.event) {
    case 'resumed': return { label: 'Resumed', detail: `same session ${sid} continued in ${e.tmux ?? 'a new terminal'} — nothing lost`, tone: 'good' };
    case 'launched': return { label: 'Started fresh', detail: `new session ${sid}${e.tmux ? ` in ${e.tmux}` : ''}`, tone: 'warn' };
    case 'adopted': return { label: 'Adopted', detail: `${sid} put in charge${e.reason ? ` — ${e.reason.slice(0, 60)}` : ''}`, tone: 'good' };
    case 'teardown': return { label: 'Torn down', detail: `${sid} stopped${e.reason ? ` — ${e.reason.slice(0, 60)}` : ''} (resumable later)`, tone: 'bad' };
    case 'resume-failed': return { label: 'Resume failed', detail: `${sid} could not be continued — skipped as a candidate`, tone: 'bad' };
    default: return { label: e.event, detail: sid, tone: 'info' };
  }
}

/** One-line health synthesis a user can act on. */
export function healthSummary(d: TraceData, now: number): { text: string; tone: Tone } {
  const el = d.election;
  if (!el) return { text: 'Election state unavailable.', tone: 'warn' };
  if (el.indeterminate) return { text: 'Cannot determine leadership right now (hub/cluster data unavailable) — holding safely, no destructive action will be taken.', tone: 'warn' };
  if (!el.isMonitor) return { text: `This node is not the leader — the controller runs on ${String(el.monitorNodeId ?? 'another node').slice(0, 16)}.`, tone: 'info' };
  if (!d.record) return { text: 'Leader confirmed, but no controller on record — one will be started (resuming history if available) on the next check.', tone: 'warn' };
  if (!d.live) return { text: 'Controller session is not running — it will be relaunched on the next check, resuming the same session from history.', tone: 'warn' };
  const lastDrive = [...d.journal].reverse().find((e) => e.kind === 'drive');
  if (lastDrive && lastDrive.ok === false) return { text: `Controller is live but the last work pass FAILED to deliver — after 3 consecutive failures it will be auto-relaunched (losslessly).`, tone: 'bad' };
  const stale = el.stale ? ' (election served from last known result)' : '';
  return {
    text: `Healthy — leader confirmed, controller session live${lastDrive ? `, last work pass delivered ${ago(lastDrive.at, now)}` : ''}${stale}.`,
    tone: 'good',
  };
}

export function ControllerTracePanel({ apiFetch, open }: {
  apiFetch: <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
  open: boolean;
}) {
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

  if (!open) return null;

  const health = data ? healthSummary(data, nowMs) : null;

  return (
    <div style={{ borderBottom: '1px solid var(--color-border-subtle)', flexShrink: 0 }}>
      {/* Health summary — the one line to read */}
      {health && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 16px', fontSize: 11.5, color: 'var(--color-text-secondary)', background: 'var(--color-bg-elevated)' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: TONE_COLOR[health.tone], flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={health.text}>{health.text}</span>
          <span style={{ flex: 1 }} />
          {data?.record?.sessionId && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
              {data.record.sessionId.slice(0, 8)} · {data.record.tmux}
            </span>
          )}
          <button onClick={() => loadRef.current()} title="Refresh trace" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', display: 'inline-flex', padding: 2 }}>
            <RefreshCw size={11} style={busy ? { animation: 'spin 1s linear infinite' } : undefined} />
          </button>
        </div>
      )}

      {data && (
        <div style={{ display: 'flex', gap: 0, maxHeight: 240, overflow: 'hidden' }}>
          {/* What the control loop DID (journal) */}
          <div style={{ flex: 3, minWidth: 0, overflow: 'auto', padding: '6px 10px 8px 16px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
              What the control loop did
            </div>
            {[...data.journal].reverse().map((e, i) => {
              const d = describeJournal(e);
              return (
                <div key={`${e.at}-${i}`} title={JSON.stringify(e)} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11, padding: '2px 0', color: 'var(--color-text-secondary)' }}>
                  <span style={{ color: 'var(--color-text-tertiary)', flexShrink: 0, minWidth: 52, textAlign: 'right' }}>{ago(e.at, nowMs)}</span>
                  <span style={{ color: TONE_COLOR[d.tone], flexShrink: 0, fontWeight: 600 }}>{d.label}</span>
                  <span style={{ color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.detail}</span>
                </div>
              );
            })}
            {data.journal.length === 0 && <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>Nothing recorded yet — entries appear as the loop makes decisions.</div>}
          </div>
          {/* WHICH session is the controller (lineage) */}
          <div style={{ flex: 2, minWidth: 0, overflow: 'auto', padding: '6px 16px 8px 10px', borderLeft: '1px solid var(--color-border-subtle)' }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
              Controller identity history
            </div>
            {[...data.lineage].reverse().map((e, i) => {
              const d = describeLineage(e);
              return (
                <div key={`${e.at}-${i}`} title={e.reason || ''} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11, padding: '2px 0', color: 'var(--color-text-secondary)' }}>
                  <span style={{ color: 'var(--color-text-tertiary)', flexShrink: 0, minWidth: 52, textAlign: 'right' }}>{ago(e.at, nowMs)}</span>
                  <span style={{ color: TONE_COLOR[d.tone], flexShrink: 0, fontWeight: 600 }}>{d.label}</span>
                  <span style={{ color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.detail}</span>
                </div>
              );
            })}
            {data.lineage.length === 0 && <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>No identity events yet.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
