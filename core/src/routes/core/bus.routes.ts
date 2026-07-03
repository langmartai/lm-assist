/**
 * Bus routes (spec §5 S1). Local surface for publish / long-poll read / topics,
 * PLUS the `/bus/:topic/since` catch-up endpoint the fabric reaches cross-node
 * (Task 9 gates it under busEnabled via the rpc-server bus allow-list). Every
 * handler wraps its result in wrapResponse / wrapError (repo API rule).
 */
import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { getBus } from '../../bus';
import { globalId, type BusCursor, type BusRef } from '../../bus/types';

export function createBusRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'POST',
      pattern: /^\/bus\/publish$/,
      handler: async (req) => {
        const start = Date.now();
        const b = (req.body ?? {}) as { topic?: string; type?: string; payload?: unknown; scope?: string; ref?: BusRef };
        if (!b.topic || typeof b.topic !== 'string') return wrapError('BAD_REQUEST', 'topic is required', start);
        if (!b.type || typeof b.type !== 'string') return wrapError('BAD_REQUEST', 'type is required', start);
        try {
          const scope = b.scope === 'fleet' ? 'fleet' : 'cluster';
          const e = getBus().publish(b.topic, b.type, b.payload, { scope, ...(b.ref ? { ref: b.ref } : {}) });
          return wrapResponse({ id: globalId(e), topic: e.topic, origin: e.origin, seq: e.seq, at: e.at }, start);
        } catch (e) {
          return wrapError('BUS_PUBLISH_FAILED', (e as Error).message, start);
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/bus\/read$/,
      handler: async (req) => {
        const start = Date.now();
        const topic = typeof req.query?.topic === 'string' ? req.query.topic : '';
        if (!topic) return wrapError('BAD_REQUEST', 'topic query param required', start);
        const from = typeof req.query?.from === 'string' ? req.query.from : undefined;
        const waitMs = Math.max(0, Math.min(25_000, Number(req.query?.wait) || 0));
        const result = await getBus().read(topic, from, waitMs);
        return wrapResponse(result, start);
      },
    },
    {
      method: 'GET',
      pattern: /^\/bus\/topics$/,
      handler: async () => {
        const start = Date.now();
        return wrapResponse({ topics: getBus().topics() }, start);
      },
    },
    {
      // Catch-up: subscriber sends its per-origin cursors, gets missed events + the current head.
      method: 'POST',
      pattern: /^\/bus\/([^/]+)\/since$/,
      handler: async (req) => {
        const start = Date.now();
        const m = req.path.match(/^\/bus\/([^/]+)\/since$/);
        const topic = m ? decodeURIComponent(m[1]) : '';
        if (!topic) return wrapError('BAD_REQUEST', 'topic required', start);
        const cursors = ((req.body as { cursors?: BusCursor })?.cursors ?? {}) as BusCursor;
        const events = getBus().since(topic, cursors);
        return wrapResponse({ events, head: getBus().topics().find((t) => t.topic === topic)?.head ?? {} }, start);
      },
    },
  ];
}
