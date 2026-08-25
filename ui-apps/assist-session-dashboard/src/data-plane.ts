/* The pane data plane, as a scoped fetch patch.
 *
 * The bundled page is the ORIGINAL web session-dashboard page; its api-client issues plain
 * relative fetches against a base URL. In a pane, every data call must instead hit
 * `/data/<uiId>/node<path>` carrying the Bearer VIEW TOKEN (15-min, re-mintable) —
 * that is the surface the pane's grant leaves are enforced on. Rather than fork the
 * api-client, we pin its base URL at the data-plane prefix and teach fetch three
 * things FOR THAT PREFIX ONLY:
 *   1. attach `Authorization: Bearer <view token>` (from the lmui shim);
 *   2. on 401/403, re-mint once via lmui.remint() and retry;
 *   3. unwrap the hub pane origin's outer {status,data} relay envelope, so the SAME
 *      bundle runs on the local tier (which forwards the node envelope untouched).
 * Every other fetch on the page (e.g. /auth/me, /viewtoken/remint issued by lmui.js
 * itself) passes through untouched.
 */

type LmuiShim = {
  uiId?: string;
  token?: string;
  remint?: () => Promise<unknown>;
};

function lmui(): LmuiShim {
  return ((window as any).lmui || {}) as LmuiShim;
}

export function dataBase(): string {
  const uiId = lmui().uiId || (window as any).__UI_ID__ || '';
  return `/data/${uiId}/node`;
}

export function installDataPlane(): void {
  const orig = window.fetch.bind(window);
  const w = window as any;
  if (w.__paneDataPlaneInstalled) return;
  w.__paneDataPlaneInstalled = true;

  window.fetch = async function paneFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.toString()
      : (input as Request).url;
    const uiId = lmui().uiId || w.__UI_ID__ || '';
    const prefix = uiId ? `/data/${uiId}/` : null;
    if (!prefix || !url.startsWith(prefix)) return orig(input as any, init);

    const doFetch = () => {
      const headers = new Headers(
        init?.headers || (typeof input === 'object' && 'headers' in (input as any) ? (input as Request).headers : undefined),
      );
      const tok = lmui().token || w.__VIEW_TOKEN__ || '';
      if (tok) headers.set('authorization', 'Bearer ' + tok);
      return orig(url, { ...init, headers });
    };

    let res = await doFetch();
    if ((res.status === 401 || res.status === 403) && typeof lmui().remint === 'function') {
      try {
        await lmui().remint!();
        res = await doFetch();
      } catch {
        /* keep the original failure response */
      }
    }

    // Relay envelope unwrap. Local tier forwards the node's {success,data,meta}
    // (top-level `success` present); the hub pane origin wraps that in an outer
    // {status,data} (numeric status, NO top-level success). Unwrap exactly the
    // latter so api-client's fetchJson sees the node envelope on both tiers.
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return res;
    const txt = await res.text();
    try {
      const b = JSON.parse(txt);
      if (
        b && typeof b === 'object' && !Array.isArray(b)
        && typeof b.status === 'number' && b.data !== undefined
        && b.success === undefined
      ) {
        return new Response(JSON.stringify(b.data), {
          status: b.status,
          headers: { 'content-type': 'application/json' },
        });
      }
    } catch {
      /* non-JSON body despite the content type — pass through as-is */
    }
    return new Response(txt, {
      status: res.status,
      statusText: res.statusText,
      headers: { 'content-type': ct },
    });
  };
}

/* The dashboard's Connect/Reconnect buttons open a ttyd console in a new tab, on a URL this
 * page composes from the node's own web origin. A pane cannot follow them: the console is a
 * live terminal attached to a running PID, started by POSTs under /ttyd/session/* that this
 * read-only grant deliberately does not hold — so the START call 403s and the tab that did
 * open would be blank. The buttons are hidden in pane.css; this is the backstop for any path
 * that still reaches window.open, and it says why instead of leaving a dead tab behind.
 *
 * Scoped tightly: only console/ttyd targets are swallowed. Everything else — including a
 * future lmui.goto('/go/…') hand-off — passes through untouched.
 */
export function installTerminalLinkGuard(): void {
  const origOpen = window.open.bind(window);
  window.open = function paneOpen(url?: string | URL, target?: string, features?: string) {
    const s = url == null ? '' : String(url);
    if (/^\/?(console|ttyd)[/?]/.test(s.replace(/^https?:\/\/[^/]+/, ''))) {
      console.info('[assist-session-dashboard] the live console needs the session-driving surface this read-only pane does not hold — not opening a dead tab');
      return null;
    }
    return origOpen(url as any, target, features);
  } as typeof window.open;
}
