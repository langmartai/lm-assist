/**
 * Request auto-management (spec T7 layer 2). Pure classification decides whether
 * a failed attempt retries (and how), then the orchestrator escalates the path
 * rung (direct → relay → legacy → re-resolve) between attempts while keeping the
 * reqId STABLE so the receiver idempotency cache dedupes a delivered-but-timed-
 * out call. Application errors never retry at the transport layer.
 */
import type { FabricResponse, FabricAddr } from './index';

export type PathRung = 'direct' | 'relay' | 'legacy' | 'reresolve';
export type RequestOutcome =
  | { kind: 'ok'; res: FabricResponse }
  | { kind: 'app-error'; res: FabricResponse }
  | { kind: 'not-delivered'; error: Error }
  | { kind: 'delivered-no-response'; error: Error };
export type RetryAction = 'return-ok' | 'return-app-error' | 'retry-fresh' | 'retry-same-id' | 'fail-budget';

export interface RetryCounters { retries: number; escalations: number; dedupHits: number; budgetExhausted: number; }

export function classify(o: RequestOutcome, attempt: number, maxAttempts: number): RetryAction {
  if (o.kind === 'ok') return 'return-ok';
  if (o.kind === 'app-error') return 'return-app-error';
  if (attempt >= maxAttempts) return 'fail-budget';
  return o.kind === 'delivered-no-response' ? 'retry-same-id' : 'retry-fresh';
}

export function nextBackoffMs(attempt: number, base = 500, cap = 8000): number {
  return Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
}

const LADDER: PathRung[] = ['direct', 'relay', 'legacy', 'reresolve'];
export function nextRung(cur: PathRung): PathRung | null {
  const i = LADDER.indexOf(cur);
  return i >= 0 && i < LADDER.length - 1 ? LADDER[i + 1] : null;
}

export async function fabricRequestWithRetry(deps: {
  attempt: (rung: PathRung, reqId: string, attempt: number) => Promise<RequestOutcome>;
  maxAttempts?: number;
  startRung?: PathRung;
  onReresolve?: () => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  genReqId?: () => string;
  counters?: RetryCounters;
}): Promise<FabricResponse> {
  const maxAttempts = deps.maxAttempts ?? 4;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
  const reqId = (deps.genReqId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`))();
  const counters = deps.counters ?? { retries: 0, escalations: 0, dedupHits: 0, budgetExhausted: 0 };
  let rung: PathRung = deps.startRung ?? 'direct';
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const outcome = await deps.attempt(rung, reqId, attempt);
    const action = classify(outcome, attempt, maxAttempts);
    if (action === 'return-ok' || action === 'return-app-error') {
      return (outcome as { res: FabricResponse }).res;
    }
    if (action === 'fail-budget') {
      counters.budgetExhausted++;
      lastErr = (outcome as { error?: Error }).error ?? new Error('fabric: retry budget exhausted');
      break;
    }
    // retry-fresh | retry-same-id
    counters.retries++;
    if (action === 'retry-same-id') counters.dedupHits++;
    const climbed = nextRung(rung);
    if (climbed) { rung = climbed; counters.escalations++; if (rung === 'reresolve') await deps.onReresolve?.(); }
    await sleep(nextBackoffMs(attempt));
  }
  throw lastErr ?? new Error('fabric: request failed (budget)');
}

/** Production entry point: fabricRequest + auto-retry/escalation. */
export async function fabricRequestManaged(
  addr: FabricAddr,
  init: { method: string; path: string; body?: unknown; query?: Record<string, string>; timeoutMs?: number },
  opts?: { maxAttempts?: number; counters?: RetryCounters; sleep?: (ms: number) => Promise<void> },
): Promise<FabricResponse> {
  const { fabricRequest } = require('./index') as typeof import('./index');
  return fabricRequestWithRetry({
    maxAttempts: opts?.maxAttempts,
    counters: opts?.counters,
    sleep: opts?.sleep,
    onReresolve: () => {
      if ('resource' in addr) {
        const { getResolutionService } = require('../resolution') as typeof import('../resolution');
        getResolutionService().invalidate(addr.resource.kind, addr.resource.id);
      }
    },
    attempt: async (_rung, reqId) => {
      try {
        const res = await fabricRequest(addr, { ...init, reqId });
        if (res.code || res.status >= 400) return { kind: 'app-error', res };
        return { kind: 'ok', res };
      } catch (e) {
        const err = e as Error;
        return /timeout/i.test(err.message) ? { kind: 'delivered-no-response', error: err } : { kind: 'not-delivered', error: err };
      }
    },
  });
}
