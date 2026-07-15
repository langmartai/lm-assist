/** Pure assist-content registry model (design §2a/§3): override-only docs over the
 *  bootstrap/guide content the code ships. Ids are enumerated FROM the code —
 *  `bootstrap.<section>` / `guide.<topic>` — and stay stable; composition (section
 *  order, generated lists, aliases) is code-owned, only PROSE is overridable.
 *  No IO — safe anywhere in the import graph. */
import type { OverlayChange, OverlayDoc, Validation } from './doc-model';

/** The content registry's delta state. `contentOverride` replaces the unit's BODY;
 *  `blurbOverride` replaces the topic's one-liner in the generated guide index
 *  (gate guardrail 2: the index one-liners are emitted content, so they are editable
 *  too — on the owning topic's doc, not a separate id). */
export type ContentState = {
  contentOverride: string | null;
  blurbOverride: string | null;
};

export type ContentChange = OverlayChange<ContentState>;
export type ContentDoc = OverlayDoc<ContentState>;

export const CONTENT_REGISTRY_DATASET = 'assist-content-registry';
export const CONTENT_HISTORY_CAP = 20;
export const MAX_CONTENT_OVERRIDE_BYTES = 16384;
export const MAX_BLURB_OVERRIDE_BYTES = 300;

/** `bootstrap.` / `guide.` prefixed, lowercase, dot/hyphen-separated keys. The grammar
 *  itself keeps the id space clear of the /assist-content literal routes (`overlay`
 *  has no group prefix, so it can never be a doc id). Unknown-but-valid ids are
 *  allowed as scratch docs (never rendered). */
const ID_RE = /^(bootstrap|guide|content)\.[a-z0-9][a-z0-9.-]{0,80}$/;

export function validateContentId(id: string): Validation {
  if (typeof id !== 'string' || !ID_RE.test(id) || id.includes('..') || /[.-]$/.test(id)) {
    return { ok: false, code: 'INVALID_INPUT', message: `invalid content doc id "${id}" (want bootstrap.<section>, guide.<topic> or content.<unit>, lowercase [a-z0-9.-])` };
  }
  return { ok: true };
}

/** null clears the override; a string must be non-empty and within the byte cap. */
export function validateContentOverride(v: string | null): Validation {
  if (v === null) return { ok: true };
  if (typeof v !== 'string' || v.length === 0) {
    return { ok: false, code: 'INVALID_INPUT', message: 'contentOverride must be a non-empty string, or null to clear' };
  }
  if (Buffer.byteLength(v, 'utf8') > MAX_CONTENT_OVERRIDE_BYTES) {
    return { ok: false, code: 'OVERRIDE_TOO_LARGE', message: `contentOverride exceeds ${MAX_CONTENT_OVERRIDE_BYTES} bytes` };
  }
  return { ok: true };
}

/** Blurbs render inside a generated one-line-per-topic list — single line, small cap. */
export function validateBlurbOverride(v: string | null): Validation {
  if (v === null) return { ok: true };
  if (typeof v !== 'string' || v.length === 0) {
    return { ok: false, code: 'INVALID_INPUT', message: 'blurbOverride must be a non-empty string, or null to clear' };
  }
  if (/[\r\n]/.test(v)) {
    return { ok: false, code: 'INVALID_INPUT', message: 'blurbOverride must be a single line (it renders in the generated index list)' };
  }
  if (Buffer.byteLength(v, 'utf8') > MAX_BLURB_OVERRIDE_BYTES) {
    return { ok: false, code: 'BLURB_TOO_LARGE', message: `blurbOverride exceeds ${MAX_BLURB_OVERRIDE_BYTES} bytes` };
  }
  return { ok: true };
}
