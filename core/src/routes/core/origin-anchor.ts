/** Shared dataset-ORIGIN write anchoring (assist-content design §2b).
 *
 *  A fleet registry dataset (mission-workflows, mcp-tool-registry, assist-content-
 *  registry) is writable only on the node that first created it — its descriptor
 *  `origin` — while every other node holds a READ_ONLY_REPLICA whose writes the data
 *  service refuses (the 2026-07-15 silent-drop incident). Registry WRITES therefore
 *  proxy to `origin.machineId`, handle locally when the descriptor is unstamped/self
 *  (which also terminates the proxied hop on the origin node — no loop), and fail
 *  CLOSED when the origin is unreachable: a silent local fallback would recreate the
 *  silent-drop defect this anchoring exists to fix.
 *
 *  Extracted from mcp-tools.routes.ts (the IMPROVED variant of the pattern — origin
 *  refusals relay VERBATIM instead of masquerading as ORIGIN_UNREACHABLE) so the
 *  three registries share one implementation instead of three copies. mission.routes'
 *  older copy gained the verbatim-refusal semantics by moving onto this module. */

export interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string } }

/** Below the relay's own 25s local-request / 30s gateway cut-offs, so a stuck hop is
 *  reported as a timeout by US (with the origin named) rather than by the relay. */
export const ORIGIN_PROXY_TIMEOUT_MS = 20_000;

export interface OriginAnchorDeps {
  getOrigin: () => Promise<string | null>;
  thisNode: () => string;
  proxyPost: (node: string, path: string, body: unknown) => Promise<unknown>;
}

/** Live deps for one dataset: origin from the dataset registry, self from the mission
 *  store, and a proxyPost that PARSES non-2xx bodies — the rest-server maps an
 *  origin-side refusal envelope (PROTECTED_TOOL, HUMAN_ONLY_DOC, OVERRIDE_TOO_LARGE,
 *  rollback NOT_FOUND…) to HTTP 400, and the caller must see the REAL refusal.
 *  (peer-client's proxyPost throws the body away on non-2xx — do not use it here.) */
export function realOriginAnchor(dataset: string): OriginAnchorDeps {
  return {
    getOrigin: async () => {
      const { getDatasetRegistry } = require('../../data/dataset-registry') as typeof import('../../data/dataset-registry');
      return getDatasetRegistry().get(dataset)?.origin?.machineId ?? null;
    },
    thisNode: () => {
      const { thisNode } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');
      return thisNode();
    },
    proxyPost: async (n, p, b) => {
      const { getHubConfig } = require('../../hub-client/hub-config') as typeof import('../../hub-client/hub-config');
      const { getHubHttpUrl } = require('../../hub-client/hub-proxy') as typeof import('../../hub-client/hub-proxy');
      // Bounded on purpose: the relay itself gives up at 25s (local request) / 30s
      // (gateway) and answers 504, so an UNBOUNDED fetch here would sit past the point
      // where the origin may already have committed — the lost-ack shape. Aborting
      // first keeps that case classifiable as ORIGIN_TIMEOUT instead of a hang.
      const res = await fetch(`${getHubHttpUrl()}/api/tier-agent/machines/${n}/proxy${p}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getHubConfig().apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(b),
        signal: AbortSignal.timeout(ORIGIN_PROXY_TIMEOUT_MS),
      });
      const text = await res.text();
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { /* non-JSON relay error */ }
      if (json && typeof json === 'object' && 'success' in (json as object)) return json;
      if (!res.ok) {
        // `body` rides along so the classifier can tell the hub's own pre-dispatch "machine
        // offline" 503 (nothing forwarded) from a 5xx after forwarding (may have landed).
        // Kept OFF the message on purpose: IN_FLIGHT_RE matches message text, and an
        // arbitrary body mentioning "abort"/"timeout" must not reclassify a 4xx.
        const e = new Error(`Proxy POST to ${n}${p} returned ${res.status}`) as Error & { status?: number; body?: string };
        e.status = res.status;
        e.body = text.slice(0, 400);
        throw e;
      }
      return json ?? text;
    },
  };
}

/** A response we can safely surface as the origin's own answer: success, or a
 *  refusal that carries a proper {code,message}. Hub/relay failure bodies (string
 *  `error`, no code) must NOT masquerade as origin envelopes. */
export function isRegistryEnvelope(v: unknown): v is Envelope {
  if (!v || typeof v !== 'object' || typeof (v as { success?: unknown }).success !== 'boolean') return false;
  const e = v as { success: boolean; error?: unknown };
  if (e.success) return true;
  return !!e.error && typeof e.error === 'object' && typeof (e.error as { code?: unknown }).code === 'string';
}

/** Positive evidence that the request was IN FLIGHT when it failed — i.e. the origin
 *  may already have committed the write and only the ack died. That is the case a
 *  caller must not blindly retry.
 *
 *  Classified on evidence rather than by defaulting: ORIGIN_UNREACHABLE is a long-
 *  standing fail-closed contract shared by four registries (workflow, tool-registry,
 *  assist-content, backlog), and an unclassifiable throw from the proxy is almost
 *  always connection-level — nothing was sent. A carried HTTP `status` counts as
 *  evidence because it proves the request DID reach the hub. */
const IN_FLIGHT_RE = /timeout|timed out|abort|socket hang up|ECONNRESET|EPIPE|ETIMEDOUT/i;
const IN_FLIGHT_NAMES = new Set(['AbortError', 'TimeoutError']);

/** The hub's machine-proxy answers a request for a machine that is not connected with a
 *  503 saying so ("Machine offline") — decided at the hub BEFORE anything is forwarded, so
 *  it proves nothing was written. Matched defensively (case-insensitive 'offline' anywhere
 *  in the response BODY — never the error message, which embeds the request path) because
 *  the exact wording is the hub's, not ours. Only a 503 counts: a 500/502 that mentions
 *  "offline" is an answer from somewhere past the hub, and stays ambiguous. */
const HUB_OFFLINE_RE = /offline/i;

function hubSaidOffline(e: unknown): boolean {
  const err = e as Error & { status?: number; body?: unknown };
  return err?.status === 503 && typeof err.body === 'string' && HUB_OFFLINE_RE.test(err.body);
}

/** A relay/hub FAILURE body (a string `error`, no {code,message} envelope) saying the
 *  target machine is offline — the `{success:false, error:"machine offline"}` shape.
 *  Requires a string `error` and no `success:true`, so a successful write's body that
 *  merely mentions "offline" somewhere can never be reported as not-applied. */
function offlineBody(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { success?: unknown; error?: unknown; message?: unknown };
  if (o.success === true || typeof o.error !== 'string') return null;
  const text = [o.error, o.message].filter((x): x is string => typeof x === 'string').join(' ');
  return HUB_OFFLINE_RE.test(text) ? text.slice(0, 160) : null;
}

function failedInFlight(e: unknown): boolean {
  const err = e as Error & { status?: number };
  if (IN_FLIGHT_NAMES.has(err?.name)) return true;
  if (typeof err?.message === 'string' && IN_FLIGHT_RE.test(err.message)) return true;
  return typeof err?.status === 'number' && (err.status === 408 || err.status >= 500);
}

/** Relay shapes that mean "the hop timed out somewhere" rather than "here is a body":
 *  the ApiRelayHandler answers 504 `Gateway timeout - local API did not respond` after
 *  30s, and its inner local request gives up at 25s. */
function relayTimedOut(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as { status?: unknown; error?: unknown };
  if (typeof o.status === 'number' && [408, 504, 522, 524].includes(o.status)) return true;
  return typeof o.error === 'string' && /timeout|timed out/i.test(o.error);
}

function unreachableEnvelope(label: string, target: string, detail: string): Envelope {
  return {
    success: false,
    error: {
      code: 'ORIGIN_UNREACHABLE',
      message: `${label} dataset origin "${target}" unreachable — the write was NOT applied; retry shortly (${detail})`,
    },
  };
}

function timeoutEnvelope(label: string, target: string, detail: string): Envelope {
  return {
    success: false,
    error: {
      code: 'ORIGIN_TIMEOUT',
      message: `${label} dataset origin "${target}" did not answer in time — the write MAY HAVE BEEN APPLIED there. `
        + `Do NOT blindly retry: re-send with the SAME requestId, which resolves to the item that was created instead of minting a duplicate. `
        + `Verify with a read if unsure. (${detail})`,
    },
  };
}

/** Proxy a write to the dataset origin when it is another node; null ⇒ handle locally
 *  (owned here / unstamped / no deps). Fail-CLOSED on proxy errors. `label` names the
 *  registry in error messages (e.g. "workflow", "tool-registry", "assist-content").
 *
 *  Three distinguishable outcomes, because "it failed" is not actionable on a WRITE:
 *   - the origin's own refusal, relayed VERBATIM (rejected ⇒ nothing written, retry safe);
 *   - ORIGIN_UNREACHABLE (provably never sent ⇒ nothing written, retry safe) — including
 *     the hub's own 503 "machine offline", which it answers before forwarding anything;
 *   - ORIGIN_TIMEOUT (ambiguous ⇒ may have landed, retry only with the same requestId). */
export async function anchorToOrigin(
  origin: OriginAnchorDeps | undefined,
  path: string,
  body: unknown,
  label: string,
): Promise<Envelope | null> {
  if (!origin) return null;
  let target: string | null;
  try { target = await origin.getOrigin(); } catch { return null; }
  if (!target || target === origin.thisNode()) return null;
  try {
    // `_originHop` marks the proxied request so the receiver NEVER re-anchors it
    // (`_actor`-style transport hint, stripped at handler entry). Without it, a
    // mixed-version fleet loops: an old-build origin node still leader-anchors the
    // write back to a new-build leader, which would origin-anchor it away again.
    const result = await origin.proxyPost(target, path, { ...(body as Record<string, unknown> ?? {}), _originHop: true });
    if (isRegistryEnvelope(result)) return result;
    // A relay TIMEOUT body has no `success`, so it used to slip through the branch below
    // and masquerade as a successful write — the worst possible answer for this class.
    // Checked BEFORE the offline marker: any timeout signal means it may have landed.
    if (relayTimedOut(result)) return timeoutEnvelope(label, target, `relay reported ${JSON.stringify(result).slice(0, 120)}`);
    const offline = offlineBody(result);
    if (offline) return unreachableEnvelope(label, target, `hub reports the origin machine offline: ${offline}`);
    if (result && typeof result === 'object' && !('success' in (result as object))) {
      return { success: true, data: (result as { data?: unknown })?.data ?? result };
    }
    return unreachableEnvelope(label, target, 'unrecognized relay response');
  } catch (e) {
    const detail = (e as Error).message;
    if (hubSaidOffline(e)) {
      const body = (e as { body?: unknown }).body;
      return unreachableEnvelope(label, target, `hub reports the origin machine offline: ${typeof body === 'string' && body ? body.slice(0, 160) : detail}`);
    }
    return failedInFlight(e)
      ? timeoutEnvelope(label, target, detail)
      : unreachableEnvelope(label, target, detail);
  }
}
