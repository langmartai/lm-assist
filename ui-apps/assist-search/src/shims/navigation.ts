/* Shim for 'next/navigation' (aliased in build.mjs).
 *
 * The search page's router.push targets are CROSS-PAGE, not in-page: a result row
 * jumps to the session viewer or the knowledge navigator. In the pane family those
 * are sibling panes, so push/replace translate to `lmui.goto(<uiId>, params)` — never
 * to window.location, which on a pane origin would 404 (each pane owns its origin on
 * the hub and lives under /ui/<uiId>/ on the local tier; lmui.goto is the one API
 * that resolves both). Anything else falls back to updating an in-iframe param store,
 * so a future in-page push keeps working instead of navigating the frame away.
 *
 * Cross-pane VOCABULARY (each param below is one a target actually reads):
 *   /sessions?session=…&tab=…  → assist-sessions {session, tab}
 *   /knowledge?id=K12&part=K12.3 → assist-knowledge {unit}  (it addresses a unit at
 *     either grain and splits the part suffix itself; it does NOT read id/part).
 */
import { useEffect, useReducer } from 'react';

type Lmui = { goto?: (uiId: string, params?: Record<string, unknown>, opts?: { newTab?: boolean }) => void };
function lmui(): Lmui {
  return ((window as any).lmui || {}) as Lmui;
}

let current = new URLSearchParams(
  typeof window !== 'undefined' ? window.location.search : '',
);
const subscribers = new Set<() => void>();

/** Translate a web-app href into a sibling pane jump. Returns false if it is not one. */
export function gotoSibling(href: string, newTab = false): boolean {
  const q = href.indexOf('?');
  const pathname = q >= 0 ? href.slice(0, q) : href;
  const params = new URLSearchParams(q >= 0 ? href.slice(q + 1) : '');
  const go = lmui().goto;
  if (typeof go !== 'function') return false;

  if (pathname === '/sessions' || pathname.endsWith('/sessions')) {
    const session = params.get('session');
    if (!session) return false;
    go('assist-sessions', { session, tab: params.get('tab') || 'chat' }, { newTab });
    return true;
  }
  if (pathname === '/knowledge' || pathname.endsWith('/knowledge')) {
    // part is the finer grain and subsumes id ('K12.3' carries 'K12').
    const unit = params.get('part') || params.get('id');
    if (!unit) return false;
    go('assist-knowledge', { unit }, { newTab });
    return true;
  }
  return false;
}

function navigate(href: string): void {
  if (gotoSibling(href)) return;
  const q = href.indexOf('?');
  current = new URLSearchParams(q >= 0 ? href.slice(q + 1) : '');
  subscribers.forEach((fn) => fn());
}

export function useSearchParams(): URLSearchParams {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const fn = () => force();
    subscribers.add(fn);
    return () => { subscribers.delete(fn); };
  }, []);
  return current;
}

export function useRouter() {
  return {
    push: navigate,
    replace: navigate,
    back: () => {},
    forward: () => {},
    refresh: () => {},
    prefetch: () => {},
  };
}

export function usePathname(): string {
  return '/search';
}
