/**
 * Lifecycle routes — graceful exit/restart of THIS node's Core and/or Web, so a node can be
 * cycled WITHOUT a force-kill (taskkill / fuser -k / Stop-Process).
 *
 *   POST /lifecycle/exit     { target?: 'core'|'web'|'both' }  → clean shutdown
 *   POST /lifecycle/restart  { target?: 'core'|'web'|'both' }  → shutdown + self-respawn (core)
 *
 * Admin: gated by the worker api-token like every non-/health route (rest-server.ts). The core
 * exit/restart is SCHEDULED ~0.5s out so this response (and its relay hop) flushes to the caller
 * before the process goes down.
 */
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse } from '../../api/helpers';
import { normalizeTarget, applyLifecycle, type LifecycleAction } from '../../lifecycle';

export function createLifecycleRoutes(_ctx: RouteContext): RouteHandler[] {
  const make = (action: LifecycleAction) => async (req: ParsedRequest) => {
    const start = Date.now();
    const target = normalizeTarget((req.body as { target?: unknown } | undefined)?.target);
    const result = await applyLifecycle(action, target);
    return wrapResponse({ action, target, ...result }, start);
  };
  return [
    { method: 'POST', pattern: /^\/lifecycle\/exit$/, handler: make('exit') },
    { method: 'POST', pattern: /^\/lifecycle\/restart$/, handler: make('restart') },
  ];
}
