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
  peerNodeOf: (env: Envelope) => string;
  offload?: (bytes: Uint8Array, peerNode: string) => Promise<{ handle: unknown }>;
  offloadThreshold?: number; // bytes; default 8MB
}

const DEFAULT_OFFLOAD = 8 * 1024 * 1024;

export function createRpcServer(deps: RpcServerDeps): ServerHandler {
  const threshold = deps.offloadThreshold ?? DEFAULT_OFFLOAD;
  return (env, reply) => {
    void (async () => {
      const id = env.id;
      const errRes = (status: number, code: string, message: string): Envelope =>
        ({ kind: 'res', id, headers: { status, code, message }, payload: new Uint8Array() });

      if (env.kind !== 'req') return;
      // Kill-switch is checked BEFORE begin() — a disabled rpc class never
      // touches idempotency (nothing was claimed, so nothing needs settling).
      if (!deps.rpcEnabled()) { reply(errRes(503, 'rpc_disabled', 'fabric rpc class disabled')); return; }

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
      const path = env.headers.path ?? '/';
      const peerNode = deps.peerNodeOf(env);

      let result: DispatchResult;
      try {
        result = await deps.dispatch({ method, path, body: parsed.body ?? null, query: parsed.query ?? {}, peerNode });
      } catch (e) {
        const failRes = errRes(502, 'dispatch_failed', (e as Error).message);
        deps.idempotency.settle(reqId, failRes); // release any concurrent waiter
        reply(failRes);
        return;
      }

      const dataBytes = encodeBody(result.data);
      let res: Envelope;
      if (deps.offload && dataBytes.length > threshold) {
        const { handle } = await deps.offload(dataBytes, peerNode);
        res = { kind: 'res', id, headers: { status: result.status, bulk: true }, payload: encodeBody(handle) };
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
