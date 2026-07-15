/** Generic overlay-doc registry types (assist-content design §2a) — the shape shared by
 *  the MCP tool registry and the assist-content registry: tiny override-only docs over
 *  code-owned defaults, with inline FULL-STATE history so rollback needs no snapshot
 *  dataset.
 *
 *  PURE types + helpers only — NO IO imports. This module sits in the stdio plugin's
 *  import graph (model.ts → overlay.ts → configure.ts), so pulling the data service or
 *  any handler module here would bloat/break the stdio binary (the catalog.ts warning). */
import type { MissionActor } from '../../mission/mission-model';

/** One registry revision. `state` carries the FULL post-change delta so rollback can
 *  reproduce any listed rev without a separate snapshot dataset. */
export interface OverlayChange<S> {
  rev: number;
  at: number;
  actor: MissionActor;
  state: S;
  changes: Record<string, { from: unknown; to: unknown }>;
}

/** Persisted doc: the delta-state fields FLATTENED beside the bookkeeping — exactly the
 *  shape the fleet `mcp-tool-registry` dataset already stores (no migration). */
export type OverlayDoc<S> = {
  name: string;
  rev: number;
  history: OverlayChange<S>[];
  createdBy: MissionActor;
  lastUpdatedBy: MissionActor;
  createdAt: number;
  updatedAt: number;
} & S;

/** The seam a store reads/writes through. Tests inject an in-memory fake. */
export interface OverlayDocPort<S> {
  isEnabled(): boolean;
  get(name: string): Promise<OverlayDoc<S> | null>;
  list(): Promise<OverlayDoc<S>[]>;
  put(d: OverlayDoc<S>): Promise<void>;
}

export type Validation = { ok: true } | { ok: false; code: string; message: string };

/** Per-field contract of a delta state: how to validate a provided value, what a new
 *  doc defaults to, and how to summarize the value in the `changes` diff (e.g. `len:N`
 *  for long strings whose full text already lives in `state`). `validate`/`summarize`
 *  take `unknown` — per-field narrowing happens inside each spec (the field-literal
 *  union would otherwise force every callback to handle every field's type). */
export interface OverlayFieldSpec<S> {
  key: keyof S & string;
  defaultValue: S[keyof S];
  validate(v: unknown): Validation;
  summarize?(v: unknown): unknown;
}

/** Everything that distinguishes one overlay registry from another. */
export interface OverlayStoreSpec<S extends Record<string, unknown>> {
  dataset: string;
  datasetTitle: string;
  /** Human label for error messages, e.g. `tool-registry doc write "search"`. */
  label: string;
  historyCap: number;
  validateName(name: string): Validation;
  fields: ReadonlyArray<OverlayFieldSpec<S>>;
  /** Optional write-refusal hook evaluated on the MERGED next state (e.g. the
   *  PROTECTED_TOOLS disable refusal). Runs at the store so EVERY write path —
   *  including rollback — is covered. */
  refuseWrite?(name: string, next: S): Validation;
}

/** `len:N` summary for long string fields (full text lives in `state`). */
export function lenOf(v: string | null | undefined): string {
  return `len:${v == null ? 0 : v.length}`;
}

/** True when the write would actually change the doc (else put no-ops). */
export function overlayStateChanged<S extends Record<string, unknown>>(
  fields: ReadonlyArray<OverlayFieldSpec<S>>,
  old: OverlayDoc<S> | null,
  next: S,
): boolean {
  if (!old) return true;
  return fields.some((f) => (old as Record<string, unknown>)[f.key] !== next[f.key]);
}
