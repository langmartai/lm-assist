import type { Machine, Session } from './types';

/** Anything with the two fields the session list is keyed and ordered by. */
interface SessionLike {
  sessionId: string;
  lastModified: string;
}

/**
 * Newest first, in place — the ordering the sessions list has always used.
 *
 * Kept as a shared helper so the first-paint slice and the background fill can
 * never disagree about ordering. Ties keep insertion order (Array#sort is
 * stable), which is what makes the merge below deterministic.
 */
export function sortByLastModifiedDesc<T extends SessionLike>(list: T[]): T[] {
  return list.sort((a, b) =>
    new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
  );
}

/**
 * Union two session lists by sessionId, newest first.
 *
 * Used for the progressive load: `base` is the fast limit=N slice already on
 * screen, `incoming` is the full list that landed after first paint.
 *
 * `incoming` wins on conflict — it is the newer, fuller fetch. Rows that only
 * `base` has are KEPT rather than dropped: the two fetches are ~1s apart, and
 * keeping them means the rows the user is already looking at never flicker out.
 * A row deleted server-side in that window survives one poll cycle at most, then
 * the next batch-check-driven refetch replaces the list wholesale.
 */
export function mergeSessionLists<T extends SessionLike>(base: T[], incoming: T[]): T[] {
  const byId = new Map<string, T>();
  for (const s of base) byId.set(s.sessionId, s);
  for (const s of incoming) byId.set(s.sessionId, s);
  return sortByLastModifiedDesc([...byId.values()]);
}

/**
 * Overlay LLM summaries / display names onto a session list.
 *
 * IMMUTABLE on purpose. These Session objects are also held by the
 * ifModifiedSince merge cache in api-client (localSessionsCache), so writing
 * `session.llmSummary = …` in place — as this used to — quietly poisons the
 * cached copies that later polls merge against.
 *
 * Returns the SAME array identity when nothing matched, so an enrichment pass
 * that found nothing doesn't trigger a re-render.
 */
export function applySummaries(
  sessions: Session[],
  summaries: Map<string, { summary: string; displayName?: string }>,
): Session[] {
  if (sessions.length === 0 || summaries.size === 0) return sessions;

  let changed = false;
  const out = sessions.map(session => {
    const entry = summaries.get(session.sessionId);
    if (!entry) return session;
    changed = true;
    const next: Session = { ...session, llmSummary: entry.summary };
    // A title the user set explicitly always wins over the generated one.
    if (entry.displayName && !session.customTitle) next.displayName = entry.displayName;
    return next;
  });
  return changed ? out : sessions;
}

/**
 * A change-detection signature for the machine list.
 *
 * `useMachines` polls getMachines() every 10s and every response is a brand-new
 * array. That new identity used to propagate through
 * MachineContext.onlineMachines into the useCallback deps of useProjects and
 * useSessions, refiring both — which is how one page load turned into six
 * /projects fetches and two 9.5MB session-list fetches. Comparing this
 * signature before setMachines() keeps the array identity stable across polls
 * that changed nothing.
 *
 * `lastHeartbeat` is excluded because getMachines() stamps the LOCAL machine
 * with `new Date().toISOString()` on every call (api-client.ts), so it differs
 * on every poll by construction. Nothing in the UI reads it. Every other field
 * — including the client-enriched counts — is included, so real changes still
 * propagate.
 */
export function machinesSignature(machines: Machine[]): string {
  return JSON.stringify(machines.map(m => {
    const { lastHeartbeat: _ignored, ...rest } = m;
    // Sort keys so a differing property order can never look like a change.
    return Object.keys(rest).sort().map(k => [k, (rest as Record<string, unknown>)[k]]);
  }));
}
