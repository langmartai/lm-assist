/** Pure MCP tool-registry model (spec §4.1): overlay-only docs keyed by tool name.
 *  Defaults ALWAYS come from code — a doc stores only the delta {descriptionOverride, enabled}.
 *  Names/schemas/scopes/handlers are code-owned and never appear here. No IO.
 *
 *  The doc/change/port shapes are the GENERIC overlay-doc types (doc-model.ts) shared
 *  with the assist-content registry — persisted records are byte-identical to before
 *  the extraction. */
import type { OverlayChange, OverlayDoc, Validation as GenericValidation } from './doc-model';

/** The tool registry's delta state — everything else on a doc is bookkeeping.
 *  (A type alias, not an interface: aliases satisfy the generic store's
 *  Record<string, unknown> constraint; interfaces lack the implicit index signature.) */
export type ToolRegistryState = {
  descriptionOverride: string | null;  // null ⇒ the code default stands
  enabled: boolean;                    // false ⇒ omitted from tools/list + calls rejected
};

/** One registry revision. `state` carries the FULL post-change delta so rollback can
 *  reproduce any listed rev without a separate snapshot dataset (docs are tiny —
 *  the deliberate deviation from workflow-store's 64KiB-body snapshots). */
export type ToolRegistryChange = OverlayChange<ToolRegistryState>;

export type ToolRegistryDoc = OverlayDoc<ToolRegistryState>;

export const MAX_DESCRIPTION_OVERRIDE_BYTES = 2048;
export const TOOL_REGISTRY_HISTORY_CAP = 20;

/** Tools that refuse `enabled:false` (spec §4.1): the orientation surface an agent
 *  needs to discover everything else — disabling any of them could lock a connector
 *  out of self-help. The registry's own management surface is REST/web (not an MCP
 *  tool), so nothing else needs protecting. Description overrides remain allowed. */
export const PROTECTED_TOOLS: ReadonlySet<string> = new Set(['bootstrap', 'guide', 'session_status']);

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Literal segments under /mcp-tools/ — a doc with one of these names would be
 *  unreachable (its GET is shadowed by the literal route) and mintable by a
 *  mistaken POST against the read endpoint. */
const RESERVED_NAMES: ReadonlySet<string> = new Set(['overlay']);

export type Validation = GenericValidation;

export function validateToolName(name: string): Validation {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return { ok: false, code: 'INVALID_INPUT', message: `invalid tool name "${name}" (want ${String(NAME_RE)})` };
  }
  if (RESERVED_NAMES.has(name)) {
    return { ok: false, code: 'RESERVED_NAME', message: `"${name}" is reserved under /mcp-tools/ and cannot be a registry doc` };
  }
  return { ok: true };
}

/** null clears the override; a string must be non-empty and within the byte cap. */
export function validateDescriptionOverride(v: string | null): Validation {
  if (v === null) return { ok: true };
  if (typeof v !== 'string' || v.length === 0) {
    return { ok: false, code: 'INVALID_INPUT', message: 'descriptionOverride must be a non-empty string, or null to clear' };
  }
  if (Buffer.byteLength(v, 'utf8') > MAX_DESCRIPTION_OVERRIDE_BYTES) {
    return { ok: false, code: 'OVERRIDE_TOO_LARGE', message: `descriptionOverride exceeds ${MAX_DESCRIPTION_OVERRIDE_BYTES} bytes` };
  }
  return { ok: true };
}

/** True when the write would actually change the doc (else putToolDoc no-ops). */
export function toolRegistryChanged(
  old: ToolRegistryDoc | null,
  next: { descriptionOverride: string | null; enabled: boolean },
): boolean {
  if (!old) return true;
  return old.descriptionOverride !== next.descriptionOverride || old.enabled !== next.enabled;
}
