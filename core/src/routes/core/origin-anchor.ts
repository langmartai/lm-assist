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
      const res = await fetch(`${getHubHttpUrl()}/api/tier-agent/machines/${n}/proxy${p}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getHubConfig().apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(b),
      });
      const text = await res.text();
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { /* non-JSON relay error */ }
      if (json && typeof json === 'object' && 'success' in (json as object)) return json;
      if (!res.ok) throw new Error(`Proxy POST to ${n}${p} returned ${res.status}`);
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

/** Proxy a write to the dataset origin when it is another node; null ⇒ handle locally
 *  (owned here / unstamped / no deps). Fail-CLOSED on proxy errors. `label` names the
 *  registry in error messages (e.g. "workflow", "tool-registry", "assist-content"). */
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
    if (result && typeof result === 'object' && !('success' in (result as object))) {
      return { success: true, data: (result as { data?: unknown })?.data ?? result };
    }
    return { success: false, error: { code: 'ORIGIN_UNREACHABLE', message: `${label} dataset origin "${target}" returned an unrecognized relay response; retry shortly` } };
  } catch (e) {
    return { success: false, error: { code: 'ORIGIN_UNREACHABLE', message: `${label} dataset origin "${target}" unreachable; retry shortly (${(e as Error).message})` } };
  }
}
