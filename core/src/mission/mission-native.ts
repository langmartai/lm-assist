import type { MissionBinding } from './mission-model';

export function cseToSessionSid(id: string): string {
  return (id || '').replace(/^cse_/, 'session_');
}

export function isNativeBinding(b: MissionBinding | null): boolean {
  return !!b && !!b.sessionId && !/^session_/.test(b.sessionId); // native = a local UUID session (cloud sids are `session_…`); ccr optional
}

export function pickNewSession(baseline: string[], current: Array<{ sid: string; status?: string }>): { sid: string } | null {
  const base = new Set(baseline);
  const fresh = current.filter((s) => !base.has(s.sid));
  const active = fresh.find((s) => (s.status || '').toLowerCase() === 'active');
  const hit = active || fresh[0];
  return hit ? { sid: hit.sid } : null;
}
