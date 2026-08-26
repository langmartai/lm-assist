/* Shim for 'next/navigation' (aliased in build.mjs).
 *
 * SessionBrowser reads deep-link params (session/parent/tab/project/machine);
 * SessionDetail router.push/replace's '/sessions?…' when switching sessions.
 * In a pane, navigation must stay IN the iframe: a shared URLSearchParams store
 * backs both hooks, and push/replace update the store (never window.location —
 * that would reload the frame). The store seeds from the pane's own query string,
 * so ?session=…&tab=… deep links keep working on both serving tiers.
 */
import { useEffect, useReducer } from 'react';

let current = new URLSearchParams(
  typeof window !== 'undefined' ? window.location.search : '',
);
// Pinned cross-pane vocabulary: assist-skills still deep-links with the legacy
// `id` alias for `session`; SessionBrowser only reads `session`.
if (current.get('id') && !current.get('session')) {
  current.set('session', current.get('id')!);
}
// The old pane guaranteed an unknown ?tab= falls back to chat rather than rendering
// nothing, and its vocabulary had a `tools` tab the web page does not. SessionDetail
// adopts initialTab verbatim with no fallback branch, so coerce at the seam.
const KNOWN_TABS = new Set(['console', 'chat', 'tasks', 'plans', 'agents', 'skills',
  'commands', 'team', 'files', 'thinking', 'git', 'db', 'dag', 'json', 'meta', 'summary']);
const inboundTab = current.get('tab');
if (inboundTab && !KNOWN_TABS.has(inboundTab)) {
  current.set('tab', 'chat'); // `tools` (old vocab) and anything unknown → chat
}
const subscribers = new Set<() => void>();

function navigate(href: string): void {
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
  return '/sessions';
}
