'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Records the last in-app route that was NOT the CCR/Code page, so the CCR "Home"
 * button can return the user to where they came from instead of always pinning to
 * /sessions. Stored in sessionStorage under `lm-prev-route`. Mounted once at the app
 * root. Pure side-effect; renders nothing.
 */
export const PREV_ROUTE_KEY = 'lm-prev-route';

export function RouteTracker() {
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname || pathname.startsWith('/ccr')) return;
    try { sessionStorage.setItem(PREV_ROUTE_KEY, pathname); } catch { /* private mode */ }
  }, [pathname]);
  return null;
}

/** The route CCR's Home should return to: the last non-CCR page, else /sessions. */
export function prevAppRoute(): string {
  try {
    const v = sessionStorage.getItem(PREV_ROUTE_KEY);
    if (v && !v.startsWith('/ccr')) return v;
  } catch { /* ignore */ }
  return '/sessions';
}
