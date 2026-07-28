/**
 * Relayed mission placement (bl_1c861246 step B) — spawning a mission on a node that is
 * NOT the leader.
 *
 * The transport is not new: `/mission` is already on the hub relay's allow-list, and a
 * human's `mission_spawn(node:X)` already places on X. What was missing is the leader
 * doing it unattended, safely.
 *
 * 🔴 THE FAILURE THIS MODULE EXISTS TO PREVENT: two executors on one mission, on two
 * machines. Everything below follows from refusing to guess.
 *
 * 🔴 AN OUTCOME CANNOT BE READ OFF THE HTTP STATUS. Measured live, prod 117 → stage 123:
 *   peer refusal       HTTP 400  {"success":false,"error":{"code":"MISSION_NOT_FOUND",…}}
 *   hub, node unknown  HTTP 404  {"error":"Machine not found","message":"Worker not found"}
 *   success            HTTP 200  {"success":true,…}
 * Two non-2xx answers with opposite meanings. The discriminator is the SHAPE of the body:
 * a `success` BOOLEAN is the peer's own envelope, so the peer ran the handler and its
 * answer is authoritative. The ABSENCE of that key means the answer never came from the
 * peer, and therefore says nothing about whether the spawn ran — that is precisely how a
 * relay 504 once slipped through as a successful write on the backlog path.
 */

export type RelayOutcome =
  | { status: 'placed'; binding: unknown }
  | { status: 'refused'; code: string; message: string }
  | { status: 'unreachable'; detail: string }
  | { status: 'unverified'; detail: string };

/** Raw result of one relayed POST, however it ended. */
export interface RelayResponse {
  httpStatus?: number;
  /** Parsed JSON body, when it parsed. */
  body?: unknown;
  /** Raw text when the body could not be parsed. */
  raw?: string;
  /** Transport/abort error message — the request may or may not have been delivered. */
  threw?: string;
}

/** The hub's own "that worker is not connected" answer. Pre-dispatch, so it PROVES
 *  non-delivery — the only non-peer answer that is safe to retry freely. */
/** Error codes `handleMissionSpawn` itself returns — i.e. the ROUTE ran and declined. Any
 *  other `success:false` may have come from the relay layer with the spawn still in flight. */
const ROUTE_REFUSALS = new Set([
  'MISSION_NOT_FOUND', 'PLACEMENT_NOT_GO', 'CLOUD_PLACEMENT', 'ALREADY_BOUND', 'BAD_KIND',
  'INVALID_REPO', 'INVALID_EFFORT', 'UNSUPPORTED_FIELD',
]);

const HUB_NO_MACHINE_RE = /machine not found|worker not found/i;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Classify one relayed response. PURE.
 *
 * Deliberately conservative: everything that is not provably one of the three definite
 * outcomes falls to `unverified`, which the caller must resolve by READING the target —
 * never by re-sending.
 */
export function classifyRelayResponse(r: RelayResponse): RelayOutcome {
  if (r.threw) return { status: 'unverified', detail: r.threw.slice(0, 200) };

  const body = asRecord(r.body);
  if (body && typeof body.success === 'boolean') {
    // The peer's own envelope — it ran the handler, so this answer is authoritative.
    if (body.success) {
      const data = asRecord(body.data);
      return { status: 'placed', binding: data?.binding ?? null };
    }
    const err = asRecord(body.error);
    const code = typeof err?.code === 'string' ? err.code : '';
    const message = typeof err?.message === 'string' ? err.message.slice(0, 300) : '';
    // 🔴 `success:false` is NOT proof that nothing happened. Measured on stage: the RELAY
    // LAYER emits `{success:false, error:{code:'INTERNAL_ERROR'}}` when its own local call to
    // the route TIMES OUT — while that call is still running. Only a code naming a decision
    // the ROUTE made proves the handler declined. Closed list, so a new code fails SAFE
    // (unverified → re-read) instead of silently meaning "nothing spawned".
    if (ROUTE_REFUSALS.has(code)) return { status: 'refused', code, message };
    return { status: 'unverified', detail: `peer error ${code || '?'}: ${message}` };
  }

  // No peer envelope. The ONE case that proves nothing was delivered is the hub telling us
  // the machine is not connected — it answers before dispatching to any worker.
  if (r.httpStatus === 404 && body) {
    const text = `${body.error ?? ''} ${body.message ?? ''}`;
    if (HUB_NO_MACHINE_RE.test(text)) {
      return { status: 'unreachable', detail: text.trim().slice(0, 200) };
    }
  }

  // Everything else — a 200 without `success`, a 502 HTML page, an empty body — is a
  // statement about the path, not about the spawn.
  const detail = r.raw ? r.raw.slice(0, 200) : JSON.stringify(r.body ?? null).slice(0, 200);
  return { status: 'unverified', detail: `http ${r.httpStatus ?? '?'}: ${detail}` };
}

export interface RelaySpawnDeps {
  /** POST the spawn to a peer through the hub machine-proxy. Must not throw — report via `threw`. */
  post: (node: string, path: string, body: unknown) => Promise<RelayResponse>;
  /** Re-read the mission ON THE TARGET NODE. Deliberately not the local synced replica:
   *  sync lag would make a landed binding look absent, which is the state that produces a
   *  duplicate. */
  readMission: (node: string, id: string) => Promise<{ binding?: { sessionId?: string } | null } | null>;
  sleep?: (ms: number) => Promise<void>;
  /** How many times to re-read before giving up and reporting `unverified`. Default 3. */
  verifyAttempts?: number;
  /** Delay between verification reads. Default 3s. */
  verifyDelayMs?: number;
}

/**
 * Relay ONE spawn and resolve its outcome honestly.
 *
 * 🔴 `post` is called EXACTLY ONCE. An ambiguous answer is resolved by re-reading the
 * mission on the target, never by sending again. `requestId` rides along so that even a
 * caller who ignores this rule is deduplicated on the target side.
 */
export async function relaySpawn(
  node: string,
  missionId: string,
  requestId: string,
  deps: RelaySpawnDeps,
): Promise<RelayOutcome> {
  const res = await deps.post(node, `/mission/${encodeURIComponent(missionId)}/spawn`, { requestId });
  const verdict = classifyRelayResponse(res);
  if (verdict.status !== 'unverified') return verdict;

  // Ambiguous. Look, don't send.
  const attempts = deps.verifyAttempts ?? 3;
  const delay = deps.verifyDelayMs ?? 3000;
  for (let i = 0; i < attempts; i++) {
    if (i > 0 && deps.sleep) await deps.sleep(delay);
    try {
      const m = await deps.readMission(node, missionId);
      const sid = m?.binding?.sessionId;
      if (sid) return { status: 'placed', binding: m!.binding };
    } catch {
      // A read that fails leaves us exactly as uncertain as before — it must never be
      // allowed to resolve the ambiguity in either direction.
    }
  }
  return verdict;
}

/** The in-flight marker persisted on a mission while a relayed spawn is outstanding. */
export interface SpawnInFlight { node: string; requestId: string; at: number }

/**
 * May this mission be relayed now?
 *
 * A marker younger than the TTL means a relay is still outstanding — sending another is
 * the duplicate-executor path. A STALE marker means the leader probably died mid-flight,
 * so the caller retries; `relaySpawn`'s read-before-conclude plus the target's `requestId`
 * dedupe make that retry safe.
 */
export function shouldRelaySpawn(
  control: { spawnInFlight?: SpawnInFlight },
  now: number,
  ttlMs: number,
): boolean {
  const f = control.spawnInFlight;
  if (!f) return true;
  return now - f.at >= ttlMs;
}
