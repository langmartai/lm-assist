/**
 * Node-profile model — the LEARNED layer of node selection (design
 * `docs/superpowers/specs/2026-07-27-native-default-and-node-selection-design.md`).
 *
 * Fourth instantiation of the overlay-doc registry family (mcp-tool registry,
 * assist-content, backlog precede it), so `id = name` and `version = rev` alias the
 * same OverlayDoc bookkeeping.
 *
 * 🔴 WHAT BELONGS HERE — and what emphatically does not.
 * A profile holds ONLY what Core cannot observe for itself: qualitative, learned
 * traits like "the claude.ai cookie on this node is IP-pinned" or "headless Chrome
 * here cannot navigate". Everything observable — online status, platform, cluster
 * membership, repos present, current conflicts, credential health — is read LIVE at
 * selection time (`node-facts.ts`) and must never be copied in here. A declared fact
 * goes stale silently, and a stale placement fact is worse than a missing one: it is
 * confidently wrong, and it is wrong in the direction of "yes, place work there".
 *
 * 🔴 THIS REGISTRY IS TAUGHT BY LLMs, FROM MCP. That is its purpose, not a side
 * effect. Every fact it will ever hold cost some session a discovery; the write path
 * (`node_profile`) exists so the next placement starts from that lesson instead of
 * re-paying for it.
 *
 * No IO — safe anywhere in the import graph (the content-model precedent).
 */
import type { Validation } from './doc-model';

export const NODE_PROFILE_DATASET = 'node-profiles';
export const NODE_PROFILE_HISTORY_CAP = 20;

export const MAX_CAPABILITIES = 40;
export const MAX_AVOID = 40;
/** Long enough for `repo:/very/long/absolute/path`, short enough to stay a LABEL. */
export const MAX_TOKEN_CHARS = 80;
export const MAX_NOTES_CHARS = 4000;
/** Symmetric so a strong preference and a strong veto are equally expressible. */
export const MIN_WEIGHT = -100;
export const MAX_WEIGHT = 100;

export type NodeProfileState = {
  /** Declared traits Core CANNOT detect: `claudeai-cookie`, `elevated-worker`, … */
  capabilities: string[];
  /** Needs this node must not serve: `browser-navigation`, `lm-assist-install`, … */
  avoid: string[];
  /** Tie-break preference. 0 = neutral; negative de-prioritises without excluding. */
  weight: number;
  /** The meta-reasoning prose — WHY. Read by the controller, never by the ranker. */
  notes: string;
};

export const NODE_PROFILE_DEFAULTS: NodeProfileState = {
  capabilities: [], avoid: [], weight: 0, notes: '',
};

/**
 * Tokens are matched by EXACT string against a `need`, so they must be predictable
 * to type from memory: lowercase, no spaces. A permissive grammar here would produce
 * `Claude.ai Cookie` vs `claudeai-cookie` and silently never match — the failure mode
 * would look like "the registry is ignored" rather than "the token was misspelled".
 */
const TOKEN_RE = /^[a-z0-9][a-z0-9._:/-]*$/;

function validateTokenList(v: unknown, field: string, cap: number): Validation {
  if (!Array.isArray(v)) {
    return { ok: false, code: 'INVALID_FIELD', message: `${field} must be an array of lowercase tokens — got ${typeof v}` };
  }
  if (v.length > cap) {
    return { ok: false, code: 'TOO_MANY', message: `${field} has ${v.length} entries, cap is ${cap}` };
  }
  for (const t of v) {
    if (typeof t !== 'string' || !t.trim()) {
      return { ok: false, code: 'INVALID_FIELD', message: `${field} entries must be non-empty strings` };
    }
    if (t.length > MAX_TOKEN_CHARS) {
      return { ok: false, code: 'INVALID_FIELD', message: `${field} entry "${t.slice(0, 30)}…" is ${t.length} chars, cap is ${MAX_TOKEN_CHARS}` };
    }
    if (!TOKEN_RE.test(t)) {
      // Echo what was sent — the backlog write-path lesson: a refusal that does not
      // show the offending value gets retried verbatim forever.
      return {
        ok: false, code: 'INVALID_FIELD',
        message: `${field} entry "${t}" is not a valid token — use lowercase letters, digits and . _ : / - (e.g. "claudeai-cookie", "repo:/home/ubuntu/lm-assist")`,
      };
    }
  }
  return { ok: true };
}

export function validateCapabilities(v: unknown): Validation {
  return validateTokenList(v, 'capabilities', MAX_CAPABILITIES);
}

export function validateAvoid(v: unknown): Validation {
  return validateTokenList(v, 'avoid', MAX_AVOID);
}

export function validateWeight(v: unknown): Validation {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { ok: false, code: 'INVALID_FIELD', message: `weight must be a finite number — got ${JSON.stringify(v)}` };
  }
  if (v < MIN_WEIGHT || v > MAX_WEIGHT) {
    return { ok: false, code: 'INVALID_FIELD', message: `weight ${v} is outside ${MIN_WEIGHT}..${MAX_WEIGHT}` };
  }
  return { ok: true };
}

export function validateNotes(v: unknown): Validation {
  if (typeof v !== 'string') {
    return { ok: false, code: 'INVALID_FIELD', message: `notes must be a string — got ${typeof v}` };
  }
  if (v.length > MAX_NOTES_CHARS) {
    return { ok: false, code: 'TOO_LONG', message: `notes is ${v.length} chars, cap is ${MAX_NOTES_CHARS}` };
  }
  return { ok: true };
}

/**
 * A profile is keyed by hostId (gatewayId), NOT hostname.
 *
 * That distinction is load-bearing and was learned the hard way: THREE entries in a
 * fleet credential sweep shared the hostname `ubuntu-Virtual-Machine`, and one of
 * them rendered as `ubuntu-Virtual-Machine (dev)` — which read as a separate machine
 * and was in fact the SAME node under its display name. A display name is not an
 * identity. Keying on it would attach a node's learned traits to the wrong host.
 */
export function validateNodeId(name: string): Validation {
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, code: 'INVALID_NODE', message: 'node id is required (the hostId/gatewayId, not the hostname)' };
  }
  if (name.length > 200) {
    return { ok: false, code: 'INVALID_NODE', message: `node id is ${name.length} chars, cap is 200` };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return { ok: false, code: 'INVALID_NODE', message: `node id "${name}" is not a valid hostId — expected e.g. "gw4-332c6620-92db-4d57-99dc-db49f29faa39"` };
  }
  return { ok: true };
}

/** Deep-equality for the token arrays, so an identical re-write stays `changed:false`
 *  instead of minting a junk rev (the backlog array-field precedent). */
export function tokensEqual(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  if (a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}
