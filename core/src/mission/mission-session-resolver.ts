/** Pure: classify a mission session sid by transport (cloud cse_/session_ vs native UUID) + role. */
import { Mission } from './mission-model';
export type Transport = 'cloud' | 'native';
export type SessionRole = 'controller' | 'orchestrator' | 'worker';
export interface ResolvedSession { sid: string; transport: Transport; missionId: string | null; role: SessionRole }
const CLOUD_RE = /^(cse_|session_)/;
export function resolveMissionSession(sid: string, missions: Mission[], controllerSid?: string | null): ResolvedSession {
  const transport: Transport = CLOUD_RE.test(sid) ? 'cloud' : 'native';
  if (controllerSid && sid === controllerSid) return { sid, transport, missionId: null, role: 'controller' };
  for (const m of missions) {
    const b = m.binding; if (!b) continue;
    if (b.ccr?.sid === sid || b.sessionId === sid) {
      return { sid, transport, missionId: m.id, role: b.kind === 'orchestrator' ? 'orchestrator' : 'worker' };
    }
  }
  return { sid, transport, missionId: null, role: 'worker' };
}
