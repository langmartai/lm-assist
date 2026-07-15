import { describe, it, expect } from 'vitest';
import {
  parseEnvelopeError,
  deriveStateFromStatus,
  deriveStateFromResume,
  findMissionForSid,
  type MissionLite,
} from '../ccr-interact';

// ── parseEnvelopeError ──────────────────────────────────────────────────────
// fetchJson throws `API 400: {"success":false,"error":{code,message}}` — the code
// is how the UI distinguishes the onboarded rails (STANDBY_MODE / ONBOARDED_PROTECTED).

describe('parseEnvelopeError', () => {
  it('extracts code+message from a fetchJson error embedding the envelope', () => {
    const e = new Error('API 400: {"success":false,"error":{"code":"STANDBY_MODE","message":"mission is standby — the human runs this session; switch manageMode to handoff to drive"}}');
    expect(parseEnvelopeError(e)).toEqual({
      code: 'STANDBY_MODE',
      message: 'mission is standby — the human runs this session; switch manageMode to handoff to drive',
    });
  });

  it('extracts ONBOARDED_PROTECTED (the stop force-gate)', () => {
    const e = new Error('API 400: {"success":false,"error":{"code":"ONBOARDED_PROTECTED","message":"this is the user\'s own session — stop requires force:true from a human"}}');
    expect(parseEnvelopeError(e).code).toBe('ONBOARDED_PROTECTED');
  });

  it('falls back to the raw message when no JSON is embedded', () => {
    expect(parseEnvelopeError(new Error('network down'))).toEqual({ message: 'network down' });
  });

  it('keeps the raw message when the JSON has no error field', () => {
    const raw = 'API 400: {"success":false}';
    expect(parseEnvelopeError(new Error(raw))).toEqual({ message: raw });
  });

  it('stringifies non-Error inputs', () => {
    expect(parseEnvelopeError('boom')).toEqual({ message: 'boom' });
  });
});

// ── deriveStateFromStatus ───────────────────────────────────────────────────
// GET /mission/session/:sid/status → {transport, alive}. May arrive enveloped
// ({data:{…}}) or unwrapped (fetchJson unwraps {data}). A failed/garbage check
// assumes live — same as the missions page — so a status hiccup never locks the UI.

describe('deriveStateFromStatus', () => {
  it('maps alive native → live', () => {
    expect(deriveStateFromStatus({ transport: 'native', alive: true })).toEqual({ transport: 'native', state: 'live' });
  });

  it('unwraps an enveloped payload', () => {
    expect(deriveStateFromStatus({ data: { transport: 'cloud', alive: false } })).toEqual({ transport: 'cloud', state: 'idle' });
  });

  it('assumes live on garbage input (never block the user on a failed check)', () => {
    expect(deriveStateFromStatus(null)).toEqual({ transport: null, state: 'live' });
    expect(deriveStateFromStatus({})).toEqual({ transport: null, state: 'live' });
  });
});

// ── deriveStateFromResume ───────────────────────────────────────────────────
// POST /mission/session/:sid/resume → ResumeResult {resumed, reason, autoCloseAt?}.

describe('deriveStateFromResume', () => {
  it('ok → live with a resumed notice', () => {
    const r = deriveStateFromResume({ resumed: true, transport: 'native', sid: 'x', reason: 'ok' });
    expect(r.state).toBe('live');
    expect(r.notice).toMatch(/resumed/i);
  });

  it('ok with autoCloseAt → notice mentions auto-close', () => {
    const r = deriveStateFromResume({ data: { resumed: true, reason: 'ok', autoCloseAt: 123 } });
    expect(r.state).toBe('live');
    expect(r.notice).toMatch(/auto-close/i);
  });

  it('alive → live, no notice needed', () => {
    expect(deriveStateFromResume({ resumed: true, reason: 'alive' })).toEqual({ state: 'live', notice: null });
  });

  it('status-unknown (transient) → live (grace)', () => {
    expect(deriveStateFromResume({ resumed: true, reason: 'status-unknown' }).state).toBe('live');
  });

  it('gone → gone with notice', () => {
    const r = deriveStateFromResume({ resumed: false, reason: 'gone' });
    expect(r.state).toBe('gone');
    expect(r.notice).toBeTruthy();
  });

  it('conflict → conflict ("live elsewhere")', () => {
    const r = deriveStateFromResume({ data: { resumed: false, reason: 'conflict' } });
    expect(r.state).toBe('conflict');
    expect(r.notice).toMatch(/elsewhere/i);
  });

  it('needs-force → needs-force (UI offers a force retry)', () => {
    const r = deriveStateFromResume({ resumed: false, reason: 'needs-force' });
    expect(r.state).toBe('needs-force');
    expect(r.notice).toMatch(/force/i);
  });

  it('kill-failed / unknown shapes → gone with a generic notice', () => {
    expect(deriveStateFromResume({ resumed: false, reason: 'kill-failed' }).state).toBe('gone');
    expect(deriveStateFromResume(null).state).toBe('gone');
  });
});

// ── findMissionForSid ───────────────────────────────────────────────────────
// Resolve the mission bound to a sid so resume can pass missionId (a dead
// mission-bound native relaunches in its worktree) and drive/stop errors can
// name the onboarded mission. Matches binding.sessionId OR binding.ccr.sid;
// done/failed missions are stale bindings and never match.

describe('findMissionForSid', () => {
  const missions: MissionLite[] = [
    { id: 'mission_a', status: 'active', binding: { sessionId: 'uuid-1', node: 'node-x' } },
    { id: 'mission_b', status: 'waiting', binding: { sessionId: 'cse_b', ccr: { sid: 'session_b' } } },
    { id: 'mission_c', status: 'done', binding: { sessionId: 'uuid-2' } },
    { id: 'mission_d', status: 'active', binding: null },
  ];

  it('matches binding.sessionId', () => {
    expect(findMissionForSid(missions, 'uuid-1')?.id).toBe('mission_a');
  });

  it('matches binding.ccr.sid', () => {
    expect(findMissionForSid(missions, 'session_b')?.id).toBe('mission_b');
  });

  it('skips done/failed missions (stale bindings)', () => {
    expect(findMissionForSid(missions, 'uuid-2')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(findMissionForSid(missions, 'nope')).toBeNull();
  });

  it('handles an enveloped/loose mission list defensively', () => {
    expect(findMissionForSid([], 'uuid-1')).toBeNull();
  });
});
