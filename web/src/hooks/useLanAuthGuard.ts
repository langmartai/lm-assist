'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { bootstrapBrowserAuth, detectAppMode, detectProxyInfo, resetBrowserToken } from '@/lib/api-client';
import { decideLanGuard, shouldClearStoredKey } from '@/lib/lan-guard';

const LAN_KEY_STORAGE = 'assist_access_key';

/**
 * LAN access gate shared by the dashboard shell and full-bleed pages (e.g. /ccr).
 *
 * Children render only after Core has answered the browser-token bootstrap, so
 * everything below the guard (voice URLs included) can read the token
 * synchronously. Core makes the call: this machine's own browser is served, a LAN
 * browser is served only with a valid `assist_access_key`, and the hub web-proxy
 * never needs a token. See decideLanGuard for where each answer leads — notably a
 * network error off-localhost now fails CLOSED.
 */
export function useLanAuthGuard(): boolean {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      let hadStoredKey = false;
      try { hadStoredKey = !!localStorage.getItem(LAN_KEY_STORAGE); } catch { /* storage blocked */ }
      let { status } = await bootstrapBrowserAuth();
      // One retry: Core may still be cold-starting when a new tab opens, and failing
      // closed on that first blip would bounce a legitimate user to the block page.
      if (status === 'unreachable' && !cancelled) {
        await new Promise((r) => setTimeout(r, 500));
        ({ status } = await bootstrapBrowserAuth());
      }
      if (cancelled) return;

      const decision = decideLanGuard({
        hostname: window.location.hostname,
        isProxied: detectProxyInfo().isProxied,
        isHubHost: detectAppMode().mode === 'hub',
        status,
        hadStoredKey,
      });
      if (decision === 'pass') { setChecked(true); return; }

      if (shouldClearStoredKey(decision)) {
        try { localStorage.removeItem(LAN_KEY_STORAGE); } catch { /* storage blocked */ }
        resetBrowserToken();
      }
      router.replace(decision);
    })();

    return () => { cancelled = true; };
  }, [router]);

  return checked;
}
