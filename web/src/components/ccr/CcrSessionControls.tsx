'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, OctagonX, Square, Play, RefreshCw, ShieldAlert } from 'lucide-react';
import type { ApiFetch, CcrRow } from './ccrTypes';
import {
  parseEnvelopeError, deriveStateFromStatus, deriveStateFromResume, findMissionForSid,
  type CcrSessionState, type MissionLite, type SessionTransport,
} from '@/lib/ccr-interact';

/**
 * Session management strip for the CCR detail view — interrupt / stop / resume via the
 * /mission/session/:sid/* stack (transport-resolving, carries the onboarded rails).
 * The visible state (live/idle/gone/…) decides which controls show:
 *   live → Interrupt + Stop (inline confirm; ONBOARDED_PROTECTED escalates to a force confirm)
 *   idle → Resume (the resume-first ladder; needs-force offers a force retry)
 *   gone/conflict → terminal notice
 */
export function CcrSessionControls({ row, apiFetch, onChanged }: {
  row: CcrRow; apiFetch: ApiFetch; onChanged: () => void;
}) {
  const [state, setState] = useState<CcrSessionState>('checking');
  const [transport, setTransport] = useState<SessionTransport | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // 'interrupt' | 'stop' | 'resume'
  const [confirmStop, setConfirmStop] = useState<'none' | 'confirm' | 'force'>('none');
  const [mission, setMission] = useState<MissionLite | null>(null);
  const sid = row.id;

  // ── status check (mount + row change + 20s + after actions) ──
  const checkStatus = useCallback(async () => {
    try {
      const res = await apiFetch<unknown>(`/mission/session/${encodeURIComponent(sid)}/status`);
      const d = deriveStateFromStatus(res);
      setTransport(d.transport);
      // never downgrade a terminal/manual state from a background poll
      setState((prev) => (prev === 'gone' || prev === 'conflict' || prev === 'needs-force' || prev === 'resuming' ? prev : d.state));
    } catch {
      setState((prev) => (prev === 'checking' ? 'live' : prev)); // assume live — never lock the UI on a failed check
    }
  }, [apiFetch, sid]);

  const checkRef = useRef(checkStatus);
  useEffect(() => { checkRef.current = checkStatus; }, [checkStatus]);
  useEffect(() => {
    setState('checking'); setNotice(null); setConfirmStop('none'); setMission(null);
    checkRef.current();
    const t = setInterval(() => checkRef.current(), 20000);
    return () => clearInterval(t);
  }, [sid]);

  // ── mission binding lookup (once per session) — for resume missionId + onboarded hints ──
  useEffect(() => {
    let cancelled = false;
    apiFetch<MissionLite[] | { data?: MissionLite[]; missions?: MissionLite[] }>('/mission')
      .then((res) => {
        if (cancelled) return;
        const r = res as { data?: MissionLite[]; missions?: MissionLite[] };
        const list = Array.isArray(res) ? res : Array.isArray(r?.data) ? r.data : (r?.missions ?? []);
        setMission(findMissionForSid(list, sid));
      })
      .catch(() => { /* best-effort — resume just omits missionId */ });
    return () => { cancelled = true; };
  }, [apiFetch, sid]);

  const control = useCallback(async (action: 'interrupt' | 'stop', force?: boolean) => {
    setBusy(action); setNotice(null);
    try {
      await apiFetch(`/mission/session/${encodeURIComponent(sid)}/control`, {
        method: 'POST', body: force ? { action, force: true } : { action },
      });
      setConfirmStop('none');
      if (action === 'stop') { setState('gone'); setNotice('Session stopped.'); onChanged(); }
      else { setNotice('Interrupt sent.'); setTimeout(() => checkRef.current(), 1200); }
    } catch (e) {
      const { code, message } = parseEnvelopeError(e);
      // I4(b) rail: stopping the user's own onboarded session needs an explicit human force.
      if (action === 'stop' && !force && code === 'ONBOARDED_PROTECTED') {
        setConfirmStop('force');
      } else {
        setConfirmStop('none');
        setNotice(`${action} failed: ${message}`);
      }
    } finally { setBusy(null); }
  }, [apiFetch, sid, onChanged]);

  const resume = useCallback(async (force?: boolean) => {
    setBusy('resume'); setState('resuming'); setNotice(null);
    try {
      const body: Record<string, unknown> = {};
      if (mission?.id) body.missionId = mission.id;
      if (force) body.force = true;
      const res = await apiFetch<unknown>(`/mission/session/${encodeURIComponent(sid)}/resume`, { method: 'POST', body });
      const d = deriveStateFromResume(res);
      setState(d.state); setNotice(d.notice);
      if (d.state === 'live') { onChanged(); setTimeout(() => checkRef.current(), 1500); }
    } catch (e) {
      const { message } = parseEnvelopeError(e);
      if (/not found for resume/i.test(message)) {
        // dead native session with no mission binding — the worktree relaunch has no anchor
        setState('idle');
        setNotice('Not mission-managed — auto-resume unavailable. Use Connect (home list) to relaunch it.');
      } else {
        setState('idle');
        setNotice(`Resume failed: ${message}`);
      }
    } finally { setBusy(null); }
  }, [apiFetch, sid, mission, onChanged]);

  const onboarded = mission?.origin === 'onboarded';
  const pill = (() => {
    switch (state) {
      case 'checking': return { label: 'checking…', color: 'var(--color-text-tertiary)' };
      case 'live': return { label: 'live', color: 'var(--color-status-green)' };
      case 'idle': return { label: 'idle', color: 'var(--color-status-orange)' };
      case 'resuming': return { label: 'resuming…', color: 'var(--color-status-orange)' };
      case 'needs-force': return { label: 'busy', color: 'var(--color-status-orange)' };
      case 'conflict': return { label: 'conflict', color: 'var(--color-status-red)' };
      case 'gone': return { label: 'gone', color: 'var(--color-text-tertiary)' };
    }
  })();

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderBottom: '1px solid var(--color-border-subtle)', fontSize: 11.5, flexWrap: 'wrap' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: pill.color }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: pill.color, display: 'inline-block' }} />
        {pill.label}
        {transport && <span style={{ color: 'var(--color-text-tertiary)' }}>· {transport}</span>}
      </span>
      {mission && (
        <span className="badge badge-outline" title={`bound to ${mission.id}`} style={{ fontSize: 10 }}>
          {onboarded ? `onboarded · ${mission.manageMode || 'standby'}` : mission.id}
        </span>
      )}

      <div style={{ flex: 1 }} />

      {(state === 'checking' || state === 'resuming') && busy !== 'resume' && (
        <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-text-tertiary)' }} />
      )}

      {state === 'live' && (
        <>
          <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => control('interrupt')}
            title="Interrupt the current action (session stays live)">
            {busy === 'interrupt' ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <OctagonX size={12} />} Interrupt
          </button>
          {confirmStop === 'none' && (
            <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => setConfirmStop('confirm')}
              title={transport === 'cloud' ? 'End this cloud session' : 'Stop the session (kills its tmux)'}>
              <Square size={12} /> Stop
            </button>
          )}
          {confirmStop === 'confirm' && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: 'var(--color-text-secondary)' }}>
                {onboarded ? 'Onboarded (user-owned) session — stop it?' : 'Stop this session?'}
              </span>
              <button className="btn btn-destructive btn-sm" disabled={!!busy} onClick={() => control('stop')}>
                {busy === 'stop' ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : 'Confirm stop'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmStop('none')}>✕</button>
            </span>
          )}
          {confirmStop === 'force' && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <ShieldAlert size={12} style={{ color: 'var(--color-status-orange)' }} />
              <span style={{ color: 'var(--color-status-orange)' }}>This is the user&apos;s own onboarded session — force stop?</span>
              <button className="btn btn-destructive btn-sm" disabled={!!busy} onClick={() => control('stop', true)}>
                {busy === 'stop' ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : 'Force stop'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmStop('none')}>✕</button>
            </span>
          )}
        </>
      )}

      {state === 'idle' && (
        <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => resume()}
          title={transport === 'cloud' ? 'Wake the cloud session (re-drive with bootstrap)' : 'Resume-first ladder: inject /remote-control or relaunch in its worktree'}>
          {busy === 'resume' ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={12} />} Resume
        </button>
      )}

      {state === 'needs-force' && (
        <button className="btn btn-destructive btn-sm" disabled={!!busy} onClick={() => resume(true)}
          title="Session is live but unreachable/busy — kill and relaunch it in place">
          {busy === 'resume' ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={12} />} Force resume
        </button>
      )}

      {(state === 'gone' || state === 'conflict') && (
        <button className="btn btn-ghost btn-sm" onClick={() => { setState('checking'); setNotice(null); checkRef.current(); }} title="Re-check status">
          <RefreshCw size={12} /> Re-check
        </button>
      )}

      {notice && <span style={{ color: 'var(--color-text-tertiary)', maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={notice}>{notice}</span>}
    </div>
  );
}
