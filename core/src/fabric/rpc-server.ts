/**
 * Fabric RPC server (spec T3): an inbound `req` envelope is dispatched into the
 * EXISTING route table by a loopback HTTP call carrying a {type:'peer',node}
 * principal (x-relay-source:'peer' + x-lm-peer-node) — the same mechanism the
 * hub's api-relay-handler uses, so existing handlers work unchanged. Idempotency
 * (T7) dedupes retries via `IdempotencyCache.begin`/`settle`: a retry that lands
 * AFTER the original completed replays the cached res; one that lands WHILE the
 * original is still dispatching awaits that same in-flight result instead of
 * re-invoking the route — exactly-once, not just once-per-non-concurrent-retry.
 * A large `data` payload is handed to the bulk layer (T4) and the `res` carries
 * a handle instead of the bytes.
 */
import * as http from 'http';
import { currentApiToken } from '../auth/api-token';
import { encodeBody, decodeBody, type Envelope } from './envelope';
import type { IdempotencyCache } from './idempotency';
import type { ServerHandler } from './fabric-link';

export interface DispatchResult { status: number; data: unknown; }
export type Dispatch = (req: {
  method: string; path: string; body: unknown; query: Record<string, string>; peerNode: string;
}) => Promise<DispatchResult>;

export interface RpcServerDeps {
  dispatch: Dispatch;
  idempotency: IdempotencyCache;
  rpcEnabled: () => boolean;
  /** When true, `/bus/*` requests dispatch even if rpcEnabled() is false (spec §5 S1
   *  catch-up is gated by busEnabled, not the general RPC class — the first scoped
   *  allow-list entry; W4 generalizes it). */
  busEnabled?: () => boolean;
  /** When true, the EXACT data-sync routes (manifest/export/fetch) dispatch even if rpcEnabled()
   *  is false (spec §5 S2 — gated by dataSyncViaFabric, not the general RPC class). W4's analogue
   *  of the busEnabled allow-list; same URL-normalized routedPath guard. */
  dataSyncEnabled?: () => boolean;
  /** When true, ONLY `/rules/export` (a READ) dispatches even if rpcEnabled() is false — gated by
   *  ruleSyncEnabled, not the general RPC class. Same scoped-allow-list pattern as busEnabled/
   *  dataSyncEnabled above. `/rules/ingest` (a WRITE) is NEVER covered by this gate — it stays
   *  reachable only through the general rpcEnabled() class, same as any other write route. */
  ruleSyncEnabled?: () => boolean;
  peerNodeOf: (env: Envelope) => string;
  offload?: (bytes: Uint8Array, peerNode: string) => Promise<{ handle: unknown }>;
  offloadThreshold?: number; // bytes; default 8MB
}

const DEFAULT_OFFLOAD = 8 * 1024 * 1024;

// EXACT shape of the only /data routes a peer may reach for sync — NEVER a bare `/data/` prefix
// (the W3 CRITICAL lesson: a raw prefix let `/bus/../hub/config` normalize past a naive startsWith).
// Matched against the URL-normalized `routedPath`, so a `..`/`%2e%2e` segment has already collapsed.
const DATA_SYNC_ROUTES = /^\/data\/(?:sync\/manifest|[^/]+\/(?:export|fetch))$/;

// Rules sync — ONLY /rules/export (READ). NEVER /rules/ingest (a WRITE). Exact shape (anchored),
// matched on the URL-normalized routedPath, same traversal-safety reason as DATA_SYNC_ROUTES.
const RULES_EXPORT_ROUTE = /^\/rules\/export$/;

export function createRpcServer(deps: RpcServerDeps): ServerHandler {
  const threshold = deps.offloadThreshold ?? DEFAULT_OFFLOAD;
  return (env, reply) => {
    void (async () => {
      const id = env.id;
      const errRes = (status: number, code: string, message: string): Envelope =>
        ({ kind: 'res', id, headers: { status, code, message }, payload: new Uint8Array() });

      if (env.kind !== 'req') return;
      const reqPath = env.headers.path ?? '/';
      // Normalize BEFORE any routing decision — the SAME algorithm
      // rest-server.ts's parseRequest uses (`new URL(req.url, base).pathname`),
      // so a `..` / `%2e%2e` segment collapses HERE exactly as it will once
      // loopbackDispatch's raw HTTP request line reaches the real router.
      // Deciding the allow-list on the RAW reqPath (the pre-fix behavior) let a
      // peer send e.g. `/bus/../hub/config`: the raw string passes a naive
      // `startsWith('/bus/')` test, but the router normalizes it to
      // `/hub/config` — a non-bus route — defeating the kill switch entirely
      // at the fleet default (fabricRpcEnabled=false, busEnabled=true).
      // `routedPath` is used for BOTH the allow-list decision AND the
      // dispatched path below (see the dispatch call), so the two can never
      // diverge regardless of what `deps.dispatch` does internally.
      const routedPath = (() => {
        try { return new URL(reqPath, 'http://localhost').pathname; } catch { return reqPath; }
      })();
      // Kill-switch is checked BEFORE begin() — a disabled class never touches
      // idempotency. Bus catch-up (/bus/*) rides busEnabled, not the general RPC
      // class, so the bus works without opening arbitrary peer RPC. Scoped to
      // the EXACT shape bus catch-up ever sends — `POST /bus/<topic>/since` —
      // rather than a bare `/bus/` prefix: tighter allow-list surface for the
      // same functionality, and safe even for a topic containing a literal
      // '/': the only production caller (fabricBusCatchup, fabric/index.ts)
      // always `encodeURIComponent()`s the topic before building this path,
      // and a `%2F` never decodes back into a path-separating '/' during URL
      // normalization (verified against Node's WHATWG URL implementation), so
      // an encoded topic can never split into extra path segments here.
      // Data sync (/data/sync/manifest, /data/:ds/export, /data/:ds/fetch) rides
      // dataSyncEnabled (W4's dataSyncViaFabric), the same pattern as the bus
      // branch above — scoped to DATA_SYNC_ROUTES's EXACT shape over the SAME
      // normalized routedPath, never a bare `/data/` prefix, for the identical
      // reason the bus entry isn't a bare `/bus/` prefix.
      // Rules export (/rules/export only) rides ruleSyncEnabled, the identical
      // scoped-allow-list pattern — RULES_EXPORT_ROUTE's EXACT shape over the
      // SAME normalized routedPath. /rules/ingest (a WRITE) deliberately has no
      // entry here at all, so it only ever dispatches through the general
      // rpcEnabled() class above, same as before this change.
      const allowed =
        deps.rpcEnabled()
        || (/^\/bus\/[^/]+\/since$/.test(routedPath) && (deps.busEnabled?.() ?? false))
        || (DATA_SYNC_ROUTES.test(routedPath) && (deps.dataSyncEnabled?.() ?? false))
        || (RULES_EXPORT_ROUTE.test(routedPath) && (deps.ruleSyncEnabled?.() ?? false));
      if (!allowed) { reply(errRes(503, 'rpc_disabled', 'fabric rpc class disabled')); return; }

      const reqId = env.headers.reqId ?? id;
      const begun = deps.idempotency.begin(reqId);
      if (begun.kind === 'cached') { reply({ ...begun.res, id }); return; } // replay under the CURRENT correlation id
      if (begun.kind === 'inflight') {
        // A concurrent retry of the SAME reqId while the original dispatch is
        // still running: await it instead of re-dispatching (exactly-once).
        const res = await begun.wait;
        reply({ ...res, id }); // replay under the CURRENT correlation id
        return;
      }
      // begun.kind === 'new': this call owns the dispatch and MUST settle()
      // on every terminal path below (success, dispatch-throw) or a
      // concurrent waiter parked on `begun.wait` above hangs forever.

      let parsed: { body?: unknown; query?: Record<string, string> } = {};
      try { parsed = (decodeBody(env.payload) as typeof parsed) ?? {}; } catch { /* empty body */ }
      const method = env.headers.method ?? 'GET';
      const peerNode = deps.peerNodeOf(env);

      let result: DispatchResult;
      try {
        // routedPath (not the raw reqPath/env.headers.path) — the exact value
        // the allow-list above just validated, so the dispatched target can
        // never diverge from the security decision that permitted it.
        result = await deps.dispatch({ method, path: routedPath, body: parsed.body ?? null, query: parsed.query ?? {}, peerNode });
      } catch (e) {
        const failRes = errRes(502, 'dispatch_failed', (e as Error).message);
        deps.idempotency.settle(reqId, failRes); // release any concurrent waiter
        reply(failRes);
        return;
      }

      const dataBytes = encodeBody(result.data);
      let res: Envelope;
      if (deps.offload && dataBytes.length > threshold) {
        // Unlike dispatch() above, offload() used to be unguarded: a throw
        // here (e.g. offloadResponse now failing loudly on a non-'done' job)
        // would propagate out of this async IIFE unhandled — no reply ever
        // sent, and the idempotency entry claimed by begin() above left
        // in-flight forever, hanging any concurrent same-reqId retry.
        try {
          const { handle } = await deps.offload(dataBytes, peerNode);
          res = { kind: 'res', id, headers: { status: result.status, bulk: true }, payload: encodeBody(handle) };
        } catch (e) {
          const failRes = errRes(502, 'bulk_offload_failed', (e as Error).message);
          deps.idempotency.settle(reqId, failRes); // release any concurrent waiter
          reply(failRes);
          return;
        }
      } else {
        res = { kind: 'res', id, headers: { status: result.status, 'content-type': 'application/json' }, payload: dataBytes };
      }
      deps.idempotency.settle(reqId, res);
      reply(res);
    })();
  };
}

export function loopbackApiPort(): number {
  if (process.env.API_PORT) return Number(process.env.API_PORT);
  return __dirname.includes('node_modules') ? 3100 : 3200;
}

/** Production dispatcher: loopback HTTP into this node's own route table. */
export function loopbackDispatch(selfApiPort: number = loopbackApiPort()): Dispatch {
  return (r) => new Promise<DispatchResult>((resolve, reject) => {
    let url = r.path;
    const qs = new URLSearchParams(r.query).toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    const options: http.RequestOptions = {
      hostname: '127.0.0.1', port: selfApiPort, path: url, method: r.method.toUpperCase(),
      headers: {
        'x-api-key': currentApiToken(),
        'x-relay-source': 'peer',
        'x-lm-peer-node': r.peerNode,
        ...(r.body != null && ['POST', 'PUT', 'PATCH'].includes(r.method.toUpperCase()) ? { 'content-type': 'application/json' } : {}),
      },
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data: unknown = text;
        try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
        resolve({ status: res.statusCode ?? 500, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(25_000, () => { req.destroy(new Error('loopback dispatch timeout')); });
    if (r.body != null && ['POST', 'PUT', 'PATCH'].includes(r.method.toUpperCase())) req.write(JSON.stringify(r.body));
    req.end();
  });
}
