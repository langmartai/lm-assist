import type { BrowserAuthStatus } from './api-client';

export type LanGuardDecision = 'pass' | '/lan-blocked' | '/lan-blocked?expired=1' | '/lan-blocked?error=unreachable';

export interface LanGuardInput {
  /** window.location.hostname */
  hostname: string;
  /** detectProxyInfo().isProxied — the hub web-proxy already authenticated the user. */
  isProxied: boolean;
  /** detectAppMode().mode === 'hub' — hub origins never hold a node token either. */
  isHubHost: boolean;
  /** Result of bootstrapBrowserAuth(). */
  status: BrowserAuthStatus;
  /** A LAN key was in localStorage when the bootstrap ran. */
  hadStoredKey: boolean;
}

/**
 * Where the dashboard guard sends this page, given Core's answer to the token
 * bootstrap. Pure so every branch is testable.
 *
 * Core is the only judge of "is this caller this machine" (it sees the socket), so
 * the guard no longer special-cases localhost for anything but reachability: when
 * Core is down on localhost the UI renders and its API calls fail visibly, which is
 * harmless because Core is also the gate on the data. Off-localhost an unreachable
 * Core fails CLOSED — the old guard let the page through on any network error.
 */
export function decideLanGuard(i: LanGuardInput): LanGuardDecision {
  if (i.isProxied || i.isHubHost) return 'pass';
  if (i.status === 'ok' || i.status === 'not-needed') return 'pass';
  if (i.status === 'unreachable') {
    const isLocalhost = i.hostname === 'localhost' || i.hostname === '127.0.0.1';
    return isLocalhost ? 'pass' : '/lan-blocked?error=unreachable';
  }
  // A key that Core refuses is stale (regenerated, or LAN access switched off):
  // tell the user to sign in again rather than show the first-visit copy.
  if (i.status === 'lan-key-invalid' || (i.status === 'denied' && i.hadStoredKey)) {
    return '/lan-blocked?expired=1';
  }
  return '/lan-blocked';
}

/** The caller must drop the stored LAN key before following this decision. */
export function shouldClearStoredKey(d: LanGuardDecision): boolean {
  return d === '/lan-blocked?expired=1';
}
