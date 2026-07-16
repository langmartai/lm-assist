'use client';

import { useEffect } from 'react';

/**
 * Auto-recover from a stale-deploy ChunkLoadError.
 *
 * When the web bundle is redeployed while a tab is open, a client-side navigation
 * can lazy-import a route chunk by a hash that no longer exists in the new build →
 * `ChunkLoadError: Failed to load chunk …`. The failing view (e.g. the CCR session
 * detail with its composer) never renders and the user appears stuck / unable to
 * input. The fix is a one-shot full reload, which re-fetches the current build's
 * entry HTML + chunk graph.
 *
 * Guarded against reload loops: we only auto-reload once per 20s window (a genuinely
 * broken deploy would otherwise thrash). The guard key is timestamp-based, so a real
 * later stale-deploy still recovers.
 */
const GUARD_KEY = 'lm-chunk-reload-at';
const WINDOW_MS = 20_000;

function isChunkLoadError(reason: unknown): boolean {
  const msg =
    (reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason ?? '')) || '';
  return /ChunkLoadError/i.test(msg) || /Loading chunk [\w-]+ failed/i.test(msg) || /Failed to load chunk/i.test(msg);
}

function reloadOnce(): void {
  try {
    const last = Number(sessionStorage.getItem(GUARD_KEY) || '0');
    const now = Date.now();
    if (now - last < WINDOW_MS) return; // already reloaded very recently — avoid a loop
    sessionStorage.setItem(GUARD_KEY, String(now));
  } catch {
    /* sessionStorage blocked (private mode) — fall through and reload anyway */
  }
  location.reload();
}

export function ChunkErrorReloader() {
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isChunkLoadError(e.reason)) reloadOnce();
    };
    const onError = (e: ErrorEvent) => {
      if (isChunkLoadError(e.error ?? e.message)) reloadOnce();
    };
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, []);
  return null;
}
