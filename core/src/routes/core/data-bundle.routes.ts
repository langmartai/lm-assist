/**
 * Data bundle routes — export / import snapshots of this node's lm-assist data, and the guarded
 * replica takeover (spec: docs/superpowers/specs/2026-09-23-data-export-import-design.md,
 * "Surfaces > REST"). Thin by design: each route validates its input, calls the ONE
 * BundleService, and maps the service's coded error onto an HTTP status.
 *
 *   GET    /data/bundles/inventory        what an export would hold + sync health ("is my data safe")
 *   GET    /data/bundles                  stored bundles, newest first
 *   POST   /data/bundles                  create an export {sections?, datasets?, includeReplicas?,
 *                                         includeKnowledge?, includeClaudeMemory?, note?}
 *   POST   /data/bundles/upload           one chunk of an upload {uploadId?, index, total, name?, dataB64, sha256?}
 *   POST   /data/bundles/fetch            pull a bundle from another node {fromNode, bundleId}
 *   POST   /data/bundles/received/:name   adopt ONE file from the file-transfer inbox
 *   GET    /data/bundles/:id              the manifest (fast; plan/apply check integrity)
 *   GET    /data/bundles/:id/chunk        ?offset=&length= → {offset,length,total,dataB64,done}
 *   GET    /data/bundles/:id/download     raw application/gzip attachment, DIRECT callers only
 *   DELETE /data/bundles/:id              delete a stored bundle
 *   POST   /data/bundles/:id/plan         dry run {policy?, sections?, datasets?, takeOwnership?, force?}
 *   POST   /data/bundles/:id/apply        the same plus confirm:true (CONFIRM_REQUIRED otherwise)
 *   POST   /data/datasets/:id/takeover    {force?} promote a replica whose origin is gone
 *
 * REGISTERED BEFORE createDataRoutes, because the first match wins: the data routes'
 * `/data/:dataset/fetch` would otherwise capture POST /data/bundles/fetch. The reverse cannot
 * happen: `bundles` is a reserved dataset id, so no /data/:dataset/* route can address a real
 * dataset under this prefix. The hub relay already allows the whole `/data` prefix
 * (api-relay-handler ALLOWED_API_PREFIXES), so nothing is added there.
 *
 * AUTH (user-approved): the node OWNER, including remote callers — LAN web, hub web, and the
 * claude.ai connector — the same exposure as the registry write routes. Every request already
 * passed the API-token gate or came through the hub relay. The service runs with the internal
 * local ctx, so THIS file is the boundary. Two narrowings, both about transports, not people:
 *   - download refuses any relayed caller. The hub relay re-encodes an application/gzip body as
 *     UTF-8 text and the fabric as JSON, so the bytes would arrive corrupted. /chunk is for them.
 *   - fetch refuses a fabric peer. The fabric's sync-read allow-list admits the
 *     `/data/:ds/fetch` shape, and /data/bundles/fetch has that shape by accident.
 *
 * Bodies follow the registry write rules (docs/backlog-registry.md): transport keys are
 * consumed first, then unknown fields are refused LOUDLY (a typo must not change nothing),
 * plausible forms are coerced ("true", "add_missing", a CSV list) and anything else is
 * refused echoing what was sent. The one exception is confirm, which is a write gate: only
 * the JSON boolean true opens it.
 */

import * as fs from 'fs';
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import type { ApiResponse } from '../../types/control-api';
import { wrapResponse, wrapError } from '../../api/helpers';
import { stripRoutingKeys } from './transport-keys';
import { DATASET_ID_RE } from '../../data/dataset-registry';
import {
  BundleError, BundleServiceError, BUNDLE_EXT, BUNDLE_ID_RE, MAX_CHUNK_BYTES, MAX_UPLOAD_CHUNK_B64,
  getBundleService, getBundleStore, isBundleId, isImportPolicy,
  type BundleService, type BundleStore, type ExportOptions, type ImportOptions, type UploadChunkInput,
} from '../../data/bundle';

// ─── deps ───────────────────────────────────────────────────────────────────

/** The BundleService surface these routes call (a narrower fake is enough in tests). */
export type BundleRoutesService = Pick<BundleService,
  | 'inventory' | 'listBundles' | 'createExport' | 'inspect' | 'readChunk' | 'deleteBundle'
  | 'uploadChunk' | 'importReceived' | 'fetchFromPeer' | 'plan' | 'apply' | 'takeover'>;

export interface DataBundleRouteDeps {
  service?: () => BundleRoutesService;
  /** Where download reads the file. It must be the service's own store (default: the shared one). */
  store?: () => Pick<BundleStore, 'resolveExisting'>;
}

// ─── envelopes + errors ─────────────────────────────────────────────────────

type Envelope = ApiResponse<unknown> & { httpStatus?: number };

/** A refusal raised by the route itself (input validation), caught like a service error. */
class RouteRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RouteRefusal';
  }
}

/**
 * HTTP status per code. rest-server honours a top-level `httpStatus`; without one every
 * failure goes out as 400, so only the codes that are NOT a caller's input mistake strictly
 * need an entry. The 400s are listed anyway so the whole vocabulary reads in one place.
 * An unlisted code (e.g. a DataService code surfacing through the service) stays 400.
 */
const HTTP_STATUS: Record<string, number> = {
  BAD_REQUEST: 400, BAD_BUNDLE_ID: 400, BUNDLE_ID_INVALID: 400, BAD_DATASET_ID: 400,
  UNSUPPORTED_FIELD: 400, CONFIRM_REQUIRED: 400, INVALID_RANGE: 400, UPLOAD_INVALID: 400,
  RECEIVED_NAME_INVALID: 400, DOWNLOAD_NOT_RELAYABLE: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404, BUNDLE_NOT_FOUND: 404, UPLOAD_NOT_FOUND: 404, RECEIVED_NOT_FOUND: 404,
  NOT_A_REPLICA: 409, ORIGIN_ONLINE: 409, OWNER_ONLINE: 409, ROSTER_UNAVAILABLE: 409, UPLOAD_CONFLICT: 409,
  NOT_SUPPORTED: 422,
  BUNDLE_TOO_LARGE: 413, CHUNK_TOO_LARGE: 413,
  BUNDLE_CORRUPT: 422, BUNDLE_FORMAT: 422, UPLOAD_SHA_MISMATCH: 422,
  INTERNAL_ERROR: 500, EXPORT_FAILED: 500, EXPORT_INCOMPLETE: 500, TAKEOVER_FAILED: 500, NO_BACKEND: 500,
  FETCH_FAILED: 502,
  DISK_LOW: 507,
};

function fail(code: string, message: string, start: number, details?: Record<string, unknown>): Envelope {
  const env: Envelope = wrapError(code, message, start);
  if (details && Object.keys(details).length) env.error!.details = details;
  const status = HTTP_STATUS[code];
  return status ? { ...env, httpStatus: status } : env;
}

/**
 * Map a thrown error to an envelope. Only the bundle layer's own coded errors keep their
 * code: an fs error also carries a string `.code` (ENOENT, EACCES), and passing that
 * through would dress an internal failure up as a caller mistake.
 */
function failFrom(e: unknown, start: number): Envelope {
  if (e instanceof RouteRefusal) return fail(e.code, e.message, start);
  if (e instanceof BundleServiceError) return fail(e.code, e.message, start, e.details);
  if (e instanceof BundleError) {
    return fail(e.code, e.message, start, { ...(e.details ?? {}), ...(e.check ? { check: e.check } : {}) });
  }
  return fail('INTERNAL_ERROR', (e as Error)?.message || String(e), start);
}

// ─── input helpers ──────────────────────────────────────────────────────────

function header(req: ParsedRequest, name: string): string | undefined {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Hub relay (`hub`) or fabric (`peer`): both set it server-side; a direct caller sends none. */
const isRelayed = (req: ParsedRequest) => header(req, 'x-relay-source') !== undefined;

function decodeParam(v: string | undefined): string {
  try { return decodeURIComponent(v ?? ''); } catch { return v ?? ''; }
}

function bundleIdParam(req: ParsedRequest): string {
  const id = decodeParam(req.params.id);
  if (BUNDLE_ID_RE.test(id)) return id;
  const hint = id.startsWith('received:')
    ? ` — to import a file from the inbox, POST /data/bundles/received/${id.slice('received:'.length)} first and use the bundleId it returns`
    : '';
  throw new RouteRefusal('BAD_BUNDLE_ID', `invalid bundle id ${JSON.stringify(id)} — expected lmb-<yyyymmdd>-<hhmmss>-<6 hex>${hint}`);
}

/**
 * The request body as a fresh object, transport keys consumed, unknown fields refused.
 * `_actor` is dropped too: no bundle route attributes a write to an actor.
 */
function bodyOf(req: ParsedRequest, allowed: readonly string[], hint?: string): Record<string, unknown> {
  const raw = req.body as unknown;
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new RouteRefusal('BAD_REQUEST', 'the request body must be a JSON object');
  }
  const b: Record<string, unknown> = { ...((raw as Record<string, unknown> | null | undefined) ?? {}) };
  // parseBody hands back {} for a body that did not parse; that must not read as "no options".
  if (Object.keys(b).length === 0 && req.rawBody && req.rawBody.trim()) {
    try { JSON.parse(req.rawBody); } catch { throw new RouteRefusal('BAD_REQUEST', 'the request body is not valid JSON'); }
  }
  stripRoutingKeys(b, ['_actor']);
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new RouteRefusal('UNSUPPORTED_FIELD',
      `unsupported field(s): ${unknown.map((k) => `"${k}"`).join(', ')} — supported: ${allowed.join(', ') || '(none)'}${hint ? ` (${hint})` : ''}`);
  }
  return b;
}

function boolField(b: Record<string, unknown>, key: string): boolean | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'false') return v === 'true';
  throw new RouteRefusal('BAD_REQUEST', `${key} must be true or false (got ${JSON.stringify(v)})`);
}

/** An array of strings, or a comma-separated string of them. */
function listField(b: Record<string, unknown>, key: string): string[] | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  throw new RouteRefusal('BAD_REQUEST', `${key} must be an array of strings (got ${JSON.stringify(v).slice(0, 120)})`);
}

/** merge | add-missing | replace, forgiving case and `_`/space for `-`. */
function policyField(b: Record<string, unknown>): string | undefined {
  const v = b.policy;
  if (v === undefined || v === null || v === '') return undefined;
  const p = typeof v === 'string' ? v.trim().toLowerCase().replace(/[_\s]+/g, '-') : '';
  const norm = p === 'addmissing' ? 'add-missing' : p;
  if (!isImportPolicy(norm)) {
    throw new RouteRefusal('BAD_REQUEST', `unknown policy ${JSON.stringify(v)} — expected merge | add-missing | replace`);
  }
  return norm;
}

/** A decimal-integer string becomes a number; anything else passes through for the store to judge. */
const intish = (v: unknown): unknown => (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v);

function queryInt(v: string | undefined, name: string, dflt: number): number {
  if (v === undefined || v === '') return dflt;
  if (!/^\d{1,15}$/.test(v)) throw new RouteRefusal('INVALID_RANGE', `${name} must be a non-negative integer (got ${JSON.stringify(v)})`);
  return Number(v);
}

const EXPORT_FIELDS = ['sections', 'datasets', 'includeReplicas', 'includeKnowledge', 'includeClaudeMemory', 'note'] as const;
const IMPORT_FIELDS = ['policy', 'sections', 'datasets', 'takeOwnership', 'force'] as const;
const UPLOAD_FIELDS = ['uploadId', 'index', 'total', 'name', 'dataB64', 'sha256'] as const;

function importOptions(b: Record<string, unknown>): ImportOptions {
  const o: ImportOptions = {};
  const policy = policyField(b);
  if (policy) o.policy = policy;
  const sections = listField(b, 'sections');
  if (sections) o.sections = sections;
  const datasets = listField(b, 'datasets');
  if (datasets) o.datasets = datasets;
  const takeOwnership = boolField(b, 'takeOwnership');
  if (takeOwnership !== undefined) o.takeOwnership = takeOwnership;
  const force = boolField(b, 'force');
  if (force !== undefined) o.force = force;
  return o;
}

// ─── routes ─────────────────────────────────────────────────────────────────

export function createDataBundleRoutes(_ctx: RouteContext, deps: DataBundleRouteDeps = {}): RouteHandler[] {
  const svc = deps.service ?? getBundleService;
  const store = deps.store ?? getBundleStore;

  /** Every handler returns an envelope; a throw becomes a coded failure, never a bare 500. */
  const route = (method: string, pattern: RegExp, fn: (req: ParsedRequest, start: number) => Promise<unknown>): RouteHandler => ({
    method,
    pattern,
    handler: async (req) => {
      const start = Date.now();
      try { return await fn(req, start); } catch (e) { return failFrom(e, start); }
    },
  });

  return [
    // ─── collection ──────────────────────────────────────────────────────
    route('GET', /^\/data\/bundles\/inventory$/, async (_req, start) => wrapResponse(await svc().inventory(), start)),

    route('GET', /^\/data\/bundles$/, async (_req, start) => wrapResponse({ bundles: await svc().listBundles() }, start)),

    // Synchronous: seconds at current sizes. The service checks free disk before reading anything.
    route('POST', /^\/data\/bundles$/, async (req, start) => {
      const b = bodyOf(req, EXPORT_FIELDS);
      const o: ExportOptions = {};
      const sections = listField(b, 'sections');
      if (sections) o.sections = sections;
      const datasets = listField(b, 'datasets');
      if (datasets) o.datasets = datasets;
      for (const k of ['includeReplicas', 'includeKnowledge', 'includeClaudeMemory'] as const) {
        const v = boolField(b, k);
        if (v !== undefined) o[k] = v;
      }
      if (b.note !== undefined && b.note !== null) o.note = b.note as string; // the service bounds it
      return wrapResponse(await svc().createExport(o), start);
    }),

    // Each chunk ≤ 700 KB of base64, so a relayed body stays under the relay's 1,000,000-char cap.
    route('POST', /^\/data\/bundles\/upload$/, async (req, start) => {
      const b = bodyOf(req, UPLOAD_FIELDS);
      if (typeof b.dataB64 === 'string' && b.dataB64.length > MAX_UPLOAD_CHUNK_B64) {
        throw new RouteRefusal('CHUNK_TOO_LARGE',
          `upload chunk is ${b.dataB64.length} base64 chars; the cap is ${MAX_UPLOAD_CHUNK_B64} — split the file into more chunks`);
      }
      const input: UploadChunkInput = {
        index: intish(b.index) as number,
        total: intish(b.total) as number,
        dataB64: b.dataB64 as string,
      };
      if (b.uploadId !== undefined && b.uploadId !== null) input.uploadId = b.uploadId as string;
      if (b.name !== undefined && b.name !== null) input.name = b.name as string;
      if (b.sha256 !== undefined && b.sha256 !== null) input.sha256 = b.sha256 as string;
      return wrapResponse(await svc().uploadChunk(input), start);
    }),

    route('POST', /^\/data\/bundles\/fetch$/, async (req, start) => {
      if (header(req, 'x-relay-source') === 'peer') {
        throw new RouteRefusal('FORBIDDEN',
          'a fabric peer cannot start a bundle fetch — it reaches this path only through the data-sync read allow-list');
      }
      const b = bodyOf(req, ['fromNode', 'bundleId']);
      const fromNode = typeof b.fromNode === 'string' ? b.fromNode.trim() : '';
      if (!fromNode) throw new RouteRefusal('BAD_REQUEST', 'fromNode (the node holding the bundle) is required');
      const bundleId = typeof b.bundleId === 'string' ? b.bundleId : '';
      if (!isBundleId(bundleId)) {
        throw new RouteRefusal('BAD_BUNDLE_ID', `invalid bundleId ${JSON.stringify(b.bundleId ?? null)} — expected lmb-<yyyymmdd>-<hhmmss>-<6 hex>`);
      }
      return wrapResponse(await svc().fetchFromPeer(fromNode, bundleId), start);
    }),

    // Before the :id routes: a file named "plan" or "apply" is still a received import.
    route('POST', /^\/data\/bundles\/received\/(?<name>[^/]+)$/, async (req, start) => {
      bodyOf(req, []);
      return wrapResponse(await svc().importReceived(decodeParam(req.params.name)), start);
    }),

    // ─── one bundle ──────────────────────────────────────────────────────
    route('GET', /^\/data\/bundles\/(?<id>[^/]+)$/, async (req, start) => wrapResponse(await svc().inspect(bundleIdParam(req)), start)),

    // fetch.ts on a peer depends on EXACTLY this data shape.
    route('GET', /^\/data\/bundles\/(?<id>[^/]+)\/chunk$/, async (req, start) => {
      const id = bundleIdParam(req);
      const offset = queryInt(req.query?.offset, 'offset', 0);
      const length = Math.min(MAX_CHUNK_BYTES, queryInt(req.query?.length, 'length', MAX_CHUNK_BYTES));
      const c = svc().readChunk(id, offset, length);
      return wrapResponse({ offset: c.offset, length: c.length, total: c.total, dataB64: c.dataB64, done: c.done }, start);
    }),

    // rest-server writes a `binary` envelope's Buffer as-is with these headers.
    route('GET', /^\/data\/bundles\/(?<id>[^/]+)\/download$/, async (req) => {
      const id = bundleIdParam(req);
      if (isRelayed(req)) {
        throw new RouteRefusal('DOWNLOAD_NOT_RELAYABLE',
          `a relayed caller cannot take a raw download (the relay re-encodes the gzip bytes and would corrupt them) — page through GET /data/bundles/${id}/chunk?offset=&length= instead`);
      }
      const data = fs.readFileSync(store().resolveExisting(id));
      return {
        success: true,
        binary: true,
        data,
        headers: {
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="${id}${BUNDLE_EXT}"`,
          'Content-Length': String(data.length),
          'Cache-Control': 'no-store',
        },
      };
    }),

    route('DELETE', /^\/data\/bundles\/(?<id>[^/]+)$/, async (req, start) => wrapResponse(svc().deleteBundle(bundleIdParam(req)), start)),

    route('POST', /^\/data\/bundles\/(?<id>[^/]+)\/plan$/, async (req, start) => {
      const id = bundleIdParam(req);
      const b = bodyOf(req, IMPORT_FIELDS, 'plan never writes — to apply, POST /data/bundles/:id/apply with confirm:true');
      return wrapResponse(await svc().plan(id, importOptions(b)), start);
    }),

    route('POST', /^\/data\/bundles\/(?<id>[^/]+)\/apply$/, async (req, start) => {
      const id = bundleIdParam(req);
      const b = bodyOf(req, [...IMPORT_FIELDS, 'confirm']);
      if (b.confirm !== true) {
        throw new RouteRefusal('CONFIRM_REQUIRED', b.confirm === undefined || b.confirm === null
          ? `apply writes to this node — POST /data/bundles/${id}/plan first, then repeat with confirm:true`
          : `confirm must be the JSON boolean true (got ${JSON.stringify(b.confirm)}) — apply writes to this node`);
      }
      return wrapResponse(await svc().apply(id, { ...importOptions(b), confirm: true }), start);
    }),

    // ─── takeover ────────────────────────────────────────────────────────
    route('POST', /^\/data\/datasets\/(?<id>[^/]+)\/takeover$/, async (req, start) => {
      const id = decodeParam(req.params.id);
      if (!DATASET_ID_RE.test(id)) {
        throw new RouteRefusal('BAD_DATASET_ID', `invalid dataset id ${JSON.stringify(id)} — expected ${DATASET_ID_RE}`);
      }
      const b = bodyOf(req, ['force']);
      return wrapResponse(await svc().takeover(id, { force: boolField(b, 'force') === true }), start);
    }),
  ];
}
