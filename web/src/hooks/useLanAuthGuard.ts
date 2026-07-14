'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { detectAppMode, detectProxyInfo, workerFetch } from '@/lib/api-client';

/**
 * LAN access gate shared by the dashboard shell and full-bleed pages (e.g. /ccr).
 * Localhost + cloud-proxy always pass; a LAN request must hold a valid
 * `assist_access_key` (validated against the server's lanAccessToken) or it is
 * redirected to /lan-blocked. Extracted verbatim from the dashboard layout.
 */
export function useLanAuthGuard(): boolean {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      const hostname = window.location.hostname;
      const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';

      // Localhost always passes
      if (isLocalhost) { setChecked(true); return; }

      // Cloud proxy always passes — already authenticated by LangMartDesign
      const proxyInfo = detectProxyInfo();
      if (proxyInfo.isProxied) { setChecked(true); return; }

      // Non-localhost — check if this is actually a local request via LAN IP
      // by asking the Core API (which can check the TCP connection's remote address)
      // Retry once on failure (Core API may be cold-starting when a new tab opens)
      const { baseUrl } = detectAppMode();
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const localRes = await workerFetch(`${baseUrl}/auth/is-local`, {
            signal: AbortSignal.timeout(3000),
          });
          const localData = await localRes.json();
          if (localData?.data?.isLocal === true) {
            setChecked(true);
            return;
          }
          break; // Got a response but isLocal=false, don't retry
        } catch {
          if (attempt === 0) await new Promise(r => setTimeout(r, 500)); // Wait before retry
        }
      }

      // Truly remote — check if LAN auth is enabled
      try {
        const serverRes = await fetch('/api/server', { signal: controller.signal });
        const data = await serverRes.json();

        if (!data.lanAuthEnabled) { setChecked(true); return; }

        // Auth enabled — check localStorage for token
        const storedToken = localStorage.getItem('assist_access_key');
        if (!storedToken) { router.replace('/lan-blocked'); return; }

        // Validate the stored token
        const res = await fetch('/api/auth/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: storedToken }),
          signal: controller.signal,
        });
        const result = await res.json();
        if (result.valid) {
          setChecked(true);
        } else {
          // Had a token but it's stale/invalid — clear it and flag `expired` so the
          // block page shows "sign in again" instead of the generic restricted copy.
          localStorage.removeItem('assist_access_key');
          router.replace('/lan-blocked?expired=1');
        }
      } catch {
        // Can't reach server config — allow through (fail open on network error)
        setChecked(true);
      }
    })();

    return () => controller.abort();
  }, [router]);

  return checked;
}
