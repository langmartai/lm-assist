/** Find this node's local sessions stalled on a server error. */
import { coreGet } from './loopback';
import { SERVER_STALL_STATES } from './stall-classify';

export interface LocalStall { sessionId: string; category: string }

/** GET /terminal/cc-sessions → driveable sessions; GET …/:id/screen → state.
 *  deps are injectable for tests. */
export async function findLocalStalls(deps?: {
  listDriveable?: () => Promise<{ sessionId: string }[]>;
  screenStateOf?: (id: string) => Promise<string>;
}): Promise<LocalStall[]> {
  const listDriveable = deps?.listDriveable ?? (async () => {
    const r = await coreGet('/terminal/cc-sessions');
    const list: any[] = r?.data?.sessions ?? r?.sessions ?? r?.data ?? [];
    return list
      .filter((s) => s && s.driveable === true && (s.sessionId || s.id))
      .map((s) => ({ sessionId: (s.sessionId || s.id) as string }));
  });
  const screenStateOf = deps?.screenStateOf ?? (async (id: string) => {
    const r = await coreGet(`/terminal/cc-sessions/${encodeURIComponent(id)}/screen`);
    return (r?.data?.state ?? r?.state ?? 'unknown') as string;
  });

  const out: LocalStall[] = [];
  for (const s of await listDriveable()) {
    const state = await screenStateOf(s.sessionId);
    if (SERVER_STALL_STATES.includes(state as any)) out.push({ sessionId: s.sessionId, category: state });
  }
  return out;
}
