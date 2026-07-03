/**
 * Retention policy (spec §5 S1: default 10k events / 7 days, per topic). Pure
 * decision so it is unit-testable without LMDB; BusStore.sweep() applies it.
 * Env-tunable with safe defaults.
 */
export interface RetentionPolicy { maxEvents: number; maxAgeMs: number; }

export function retentionFromEnv(): RetentionPolicy {
  const events = Number(process.env.LM_BUS_RETENTION_EVENTS);
  const days = Number(process.env.LM_BUS_RETENTION_DAYS);
  return {
    maxEvents: Number.isFinite(events) && events > 0 ? Math.floor(events) : 10_000,
    maxAgeMs: (Number.isFinite(days) && days > 0 ? days : 7) * 24 * 3600 * 1000,
  };
}

/** Which events (of ONE topic) to drop: aged-out first, then oldest surplus over the cap. */
export function eventsToEvict(
  events: Array<{ origin: string; seq: number; at: number }>,
  policy: RetentionPolicy,
  nowMs: number,
): Array<{ origin: string; seq: number }> {
  const drop = new Set<string>();
  const key = (e: { origin: string; seq: number }) => `${e.origin} ${e.seq}`;
  for (const e of events) if (nowMs - e.at > policy.maxAgeMs) drop.add(key(e));
  const survivors = events.filter((e) => !drop.has(key(e)));
  // surplus is measured against the ORIGINAL event count, not the post-age-filter
  // survivor count (verified against the spec test: 4 events, cap 2, 1 aged-out ->
  // evicts 3 total, i.e. keeps only the single newest — "cap=2 over 4 events", not
  // "cap=2 over the 3 survivors"). Loop is bounded to byAge.length as a guard: if
  // aged-out count alone exceeds maxEvents, surplus can exceed survivors.length and
  // an unguarded index would read past the end of byAge.
  const surplus = events.length - policy.maxEvents;
  if (surplus > 0) {
    const byAge = [...survivors].sort((a, b) => a.at - b.at || a.origin.localeCompare(b.origin) || a.seq - b.seq);
    for (let i = 0; i < surplus && i < byAge.length; i++) drop.add(key(byAge[i]));
  }
  return events.filter((e) => drop.has(key(e))).map((e) => ({ origin: e.origin, seq: e.seq }));
}
