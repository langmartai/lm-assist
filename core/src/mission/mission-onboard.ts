/** Pure helpers for onboarding EXISTING sessions into mission control. No IO. */
import { Mission, MissionActor, ManageMode, newMission } from './mission-model';

export const MISSION_CONTROL_MARKER = '⟦MISSION-CONTROL⟧';

export function markDriveText(text: string): string {
  return text.startsWith(MISSION_CONTROL_MARKER) ? text : `${MISSION_CONTROL_MARKER} ${text}`;
}

export function isOnboarded(m: Pick<Mission, 'origin'>): boolean { return m.origin === 'onboarded'; }

export function onboardTitle(sid: string): string { return `Onboarded: ${sid.slice(0, 12)}…`; }

const CLOUD_RE = /^(cse_|session_)/;
export function detectTransport(sid: string): 'cloud' | 'native' { return CLOUD_RE.test(sid) ? 'cloud' : 'native'; }

export function buildOnboardMission(
  input: { sid: string; node: string; transport: 'cloud' | 'native'; mode: ManageMode; note?: string; crossCluster: boolean; ownerNode: string; createdBy: MissionActor },
  now: number,
  genId: () => string,
): Mission {
  const m = newMission({
    title: onboardTitle(input.sid),
    objective: `Manage the onboarded session ${input.sid} (analysis pending — see onboard.analyze).`,
    ownerNode: input.ownerNode,
    createdBy: input.createdBy,
    tags: {
      'onboard:state': ['analyzing'],
      ...(input.crossCluster ? { 'onboard:cross-cluster': ['true'] } : {}),
    },
    nextSteps: input.note ? [`Human note: ${input.note}`] : undefined,
    env: { isolation: 'shared', host: input.node === 'cloud' ? undefined : input.node, resources: [] },
  }, now, genId);
  m.origin = 'onboarded';
  m.manageMode = input.mode;
  m.binding = { sessionId: input.sid, node: input.node, kind: 'onboarded', boundAt: now };
  return m;
}

/** Lowest online gatewayId belonging to `cluster` (records with no cluster count as 'default'). */
export function pickClusterLeader(
  cluster: string,
  records: Array<{ gatewayId: string; cluster?: string | null }>,
  online: string[],
): string | null {
  const onlineSet = new Set(online);
  const members = records
    .filter((r) => (r.cluster ?? 'default') === cluster && onlineSet.has(r.gatewayId))
    .map((r) => r.gatewayId)
    .sort();
  return members[0] ?? null;
}

/** True when any NEW user-role message is a plain human prompt (not our marker, not harness/tooling noise). */
export function detectHumanActivity(msgs: Array<{ role: string; text: string }>): boolean {
  for (const m of msgs) {
    if (m.role !== 'user') continue;
    const t = (m.text || '').trim();
    if (!t) continue;
    if (t.startsWith(MISSION_CONTROL_MARKER)) continue;
    if (t.startsWith('<system')) continue;          // <system-reminder> harness injections
    if (t.startsWith('[{')) continue;               // serialized tool_result arrays
    if (t.startsWith('Run a controller pass')) continue; // supervisor directives (controller session)
    if (t.startsWith('⟦INVARIANTS')) continue;      // registry-rendered directive text (renderWorkflowText prepends the invariant preamble) — not a human prompt
    return true;
  }
  return false;
}
