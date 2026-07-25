/** Keys that ride along on a relayed write but are NOT fields of the thing being
 *  written, so they must be consumed before an "unknown field" guard runs.
 *
 *  Why this exists (2026-07-25): `node` is the connector's ROUTING parameter — it is in
 *  the args of essentially every relayed MCP call and is consumed at the hub, long
 *  before a worker route sees it. `mission_update` forwarded its raw args, so the
 *  whitelist met a leftover `node` and refused the entire write:
 *      Error: unsupported field(s): "node" — supported: title, objective, plan, …
 *  `cluster` had already been given routing treatment in mission.routes; `node` never
 *  had. (`_actor` / `_originHop` are transport too, but each is consumed at its own
 *  precise point — `actorFor` needs `_actor` still present — so they are NOT stripped
 *  here.)
 *
 *  Deliberately a CLOSED list of known-transport keys, not a blanket "ignore anything
 *  unrecognized": the UNSUPPORTED_FIELD guard is what stops a misspelled field from
 *  silently changing nothing (the assist-content 200-noop lesson), and it must keep
 *  doing exactly that. */
export const ROUTING_KEYS = ['node'] as const;

/** Delete the routing keys from a request body. Mutates — request bodies here are
 *  already per-request objects. Returns the keys that were actually present. */
export function stripRoutingKeys(b: Record<string, unknown>, extra: readonly string[] = []): string[] {
  const seen: string[] = [];
  for (const k of [...ROUTING_KEYS, ...extra]) {
    if (k in b) { seen.push(k); delete b[k]; }
  }
  return seen;
}
