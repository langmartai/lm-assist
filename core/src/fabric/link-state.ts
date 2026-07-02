/** Pure link lifecycle. `degraded` is DERIVED at snapshot time (connected + relay mode). */
export type LinkState = 'discovered' | 'connecting' | 'connected' | 'legacy' | 'failed' | 'idle';

export interface LinkCore {
  state: LinkState;
  since: number;
  attempts: number;      // consecutive failed opens (reset on hello-ok)
  lastError: string | null;
}

export type LinkEvent =
  | { type: 'open-requested' }
  | { type: 'hello-ok' }
  | { type: 'hello-timeout' }
  | { type: 'open-failed'; error: string }
  | { type: 'channel-closed'; error?: string }
  | { type: 'peer-offline' }
  | { type: 'retry-due' };

export function reduceLink(c: LinkCore, ev: LinkEvent, now: number): LinkCore {
  const to = (state: LinkState, patch: Partial<LinkCore> = {}): LinkCore =>
    ({ ...c, state, since: now, ...patch });
  switch (ev.type) {
    case 'open-requested': return to('connecting');
    case 'hello-ok':       return to('connected', { attempts: 0, lastError: null });
    case 'hello-timeout':  return to('legacy', { lastError: 'no fabric hello (legacy peer)' });
    case 'open-failed':    return to('failed', { attempts: c.attempts + 1, lastError: ev.error });
    case 'channel-closed': return c.state === 'idle' ? c : to('failed', { attempts: c.attempts + 1, lastError: ev.error ?? 'channel closed' });
    case 'peer-offline':   return to('idle');
    case 'retry-due':      return c.state === 'failed' ? to('connecting') : c;
    default:               return c;
  }
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 600_000;

export function backoffMs(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
}
