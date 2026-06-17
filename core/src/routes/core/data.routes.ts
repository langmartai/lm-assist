// core/src/routes/core/data.routes.ts
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { getDataService, getSyncEngine, type CallCtx } from '../../data/data-service';
import { getDatasetRegistry } from '../../data/dataset-registry';
import type { DataRecord } from '../../data/types';

function ctxOf(req: ParsedRequest): CallCtx {
  const svc = getDataService();
  const principal = svc.resolvePrincipal(req);
  const raw = req.headers?.['x-lm-access-key'];
  const keyHeader = Array.isArray(raw) ? raw[0] : raw;
  return { principal, keyHeader };
}

function recordFromBody(body: any): DataRecord {
  const now = new Date().toISOString();
  return {
    id: String(body?.id ?? ''),
    version: 0, // placeholder — engine overwrites in DataService.put
    fields: (body?.fields && typeof body.fields === 'object') ? body.fields : {},
    text: typeof body?.text === 'string' ? body.text : undefined,
    metadata: (body?.metadata && typeof body.metadata === 'object') ? body.metadata : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

export function createDataRoutes(_ctx: RouteContext): RouteHandler[] {
  const svc = () => getDataService();
  const disabled = (start: number) => wrapError('DATA_SERVICE_DISABLED', 'data service is disabled', start);

  return [
    // GET /data/catalog
    {
      method: 'GET',
      pattern: /^\/data\/catalog$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        return wrapResponse({ datasets: svc().catalog(svc().resolvePrincipal(req)) }, start);
      },
    },

    // POST /data/access  — request a scoped key
    {
      method: 'POST',
      pattern: /^\/data\/access$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const p = svc().resolvePrincipal(req);
        const res = await svc().requestAccess(p, req.body || { grants: [] });
        if (!res.ok) return wrapError(res.code, res.reason, start);
        return wrapResponse(res.value, start);
      },
    },

    // DELETE /data/access/:keyId — revoke
    {
      method: 'DELETE',
      pattern: /^\/data\/access\/(?<keyId>[^/]+)$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const ok = await svc().revoke(svc().resolvePrincipal(req), req.params.keyId);
        return wrapResponse({ revoked: ok }, start);
      },
    },

    // GET /data/datasets — list descriptors visible to caller (catalog alias for admin)
    {
      method: 'GET',
      pattern: /^\/data\/datasets$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        return wrapResponse({ datasets: svc().catalog(svc().resolvePrincipal(req)) }, start);
      },
    },

    // POST /data/datasets — create a dataset (LOCAL principal only in M1)
    {
      method: 'POST',
      pattern: /^\/data\/datasets$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const p = svc().resolvePrincipal(req);
        if (p.type !== 'local') return wrapError('FORBIDDEN', 'dataset creation is local-only', start);
        const b = req.body || {};
        try {
          // getDatasetRegistry is the same instance the service uses
          const d = getDatasetRegistry().create({
            id: b.id, backend: b.backend ?? 'cache', title: b.title,
            visibility: b.visibility, readOnly: b.readOnly, sensitive: b.sensitive,
            config: b.config ?? { kind: 'cache' }, acl: b.acl, syncMode: b.syncMode,
          });
          // ensure the backend allocates storage
          await svc().put({ principal: p }, d.id, recordFromBody({ id: '__init__', fields: {} }));
          await svc().del({ principal: p }, d.id, '__init__');
          return wrapResponse({ dataset: d }, start);
        } catch (e) {
          return wrapError('BAD_REQUEST', e instanceof Error ? e.message : String(e), start);
        }
      },
    },

    // GET /data/:dataset/records/:id
    {
      method: 'GET',
      pattern: /^\/data\/(?<dataset>[^/]+)\/records\/(?<id>[^/]+)$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const r = await svc().get(ctxOf(req), req.params.dataset, req.params.id);
        if (!r.ok) return wrapError(r.code, r.reason, start);
        return wrapResponse(r.value, start);
      },
    },

    // POST /data/:dataset/query
    {
      method: 'POST',
      pattern: /^\/data\/(?<dataset>[^/]+)\/query$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const r = await svc().query(ctxOf(req), req.params.dataset, req.body || {});
        if (!r.ok) return wrapError(r.code, r.reason, start);
        return wrapResponse(r.value, start);
      },
    },

    // PUT /data/:dataset/records
    {
      method: 'PUT',
      pattern: /^\/data\/(?<dataset>[^/]+)\/records$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const rec = recordFromBody(req.body);
        if (!rec.id) return wrapError('BAD_REQUEST', 'record id is required', start);
        const r = await svc().put(ctxOf(req), req.params.dataset, rec);
        if (!r.ok) return wrapError(r.code, r.reason, start);
        return wrapResponse(r.value, start);
      },
    },

    // DELETE /data/:dataset/records/:id
    {
      method: 'DELETE',
      pattern: /^\/data\/(?<dataset>[^/]+)\/records\/(?<id>[^/]+)$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const r = await svc().del(ctxOf(req), req.params.dataset, req.params.id);
        if (!r.ok) return wrapError(r.code, r.reason, start);
        return wrapResponse({ deleted: r.value }, start);
      },
    },

    // GET /data/sync/manifest — syncable datasets this node advertises (must precede :dataset wildcard)
    {
      method: 'GET',
      pattern: /^\/data\/sync\/manifest$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        return wrapResponse({ node: svc().nodeId(), datasets: svc().syncManifest(svc().resolvePrincipal(req)) }, start);
      },
    },

    // GET /data/:dataset/export?since=ISO  — records changed since watermark (for sync pull)
    {
      method: 'GET',
      pattern: /^\/data\/(?<dataset>[^/]+)\/export$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const r = await svc().exportDataset(ctxOf(req), req.params.dataset, req.query?.since);
        if (!r.ok) return wrapError(r.code, r.reason, start);
        return wrapResponse({ records: r.value }, start);
      },
    },

    // POST /data/:dataset/export — sync pull; key in body (hub proxy doesn't forward the key header)
    {
      method: 'POST',
      pattern: /^\/data\/(?<dataset>[^/]+)\/export$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const b = req.body || {};
        const ctx = { principal: svc().resolvePrincipal(req), keyHeader: typeof b.key === 'string' ? b.key : undefined };
        const r = await svc().exportDataset(ctx, req.params.dataset, typeof b.since === 'string' ? b.since : undefined);
        if (!r.ok) return wrapError(r.code, r.reason, start);
        return wrapResponse({ records: r.value }, start);
      },
    },

    // POST /data/:dataset/fetch — peer-facing single-record read for partial sync; key in body
    {
      method: 'POST',
      pattern: /^\/data\/(?<dataset>[^/]+)\/fetch$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const b = req.body || {};
        const ctx = { principal: svc().resolvePrincipal(req), keyHeader: typeof b.key === 'string' ? b.key : undefined };
        const r = await svc().getRecordRaw(ctx, req.params.dataset, String(b.id || ''));
        if (!r.ok) return wrapError(r.code, r.reason, start);
        return wrapResponse(r.value, start);
      },
    },

    // POST /data/sync — trigger a full reconcile against all peers (local-only)
    {
      method: 'POST',
      pattern: /^\/data\/sync$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const p = svc().resolvePrincipal(req);
        if (p.type !== 'local') return wrapError('FORBIDDEN', 'sync is local-only', start);
        const status = await getSyncEngine().reconcile();
        return wrapResponse(status, start);
      },
    },

    // GET /data/sync/status — current sync engine status (local-only)
    {
      method: 'GET',
      pattern: /^\/data\/sync\/status$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const p = svc().resolvePrincipal(req);
        if (p.type !== 'local') return wrapError('FORBIDDEN', 'sync status is local-only', start);
        return wrapResponse(getSyncEngine().status(), start);
      },
    },
  ];
}
