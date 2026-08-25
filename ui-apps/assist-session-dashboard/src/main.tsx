/* Pane entry: mount the ORIGINAL session-dashboard page (the default export of
 * web/src/app/(dashboard)/session-dashboard/page.tsx — the live terminal grid) with the
 * pane environment installed around it.
 *
 * The backlog carried this page as BLOCKED on streaming over the relay. Measured: it does
 * not stream. There is no EventSource and no WebSocket anywhere in the page, its two hooks
 * or its three components — the "live" grid is a poll loop (getSessions + batchCheckSessions
 * + a per-session conversation tail + GET /ttyd/processes for running detection). What it
 * really holds that a read-only pane must not is the session-DRIVING half: start/stop a ttyd
 * console and kill a session's processes. Those are POSTs under /ttyd/session/*, outside this
 * pane's grant, and their buttons are hidden in pane.css.
 */
import { installDataPlane, installTerminalLinkGuard } from './data-plane';

installDataPlane();
installTerminalLinkGuard();

import { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import SessionDashboardPage from '../../../web/src/app/(dashboard)/session-dashboard/page';

// ── embedding + theme contract (SPEC 5.5; same semantics as every sibling pane) ──
const qs = new URLSearchParams(window.location.search);
const EMBEDDED = qs.get('embed') === '1';
if (EMBEDDED) document.body.classList.add('embed');
document.documentElement.dataset.theme = qs.get('theme') === 'light' ? 'light' : 'dark';

// Liveness only — the shell panel-fixes the iframe; 100vh here IS the panel height.
function reportLiveness() {
  if (!EMBEDDED || !window.parent || window.parent === window) return;
  const h = Math.ceil(document.body.scrollHeight + 8);
  try {
    window.parent.postMessage(
      { type: 'lmui:height', uiId: (window as any).__UI_ID__ || '', height: h },
      '*',
    );
  } catch {
    /* shell gone — nothing to report to */
  }
}
if (EMBEDDED) {
  window.addEventListener('load', reportLiveness);
  if (window.ResizeObserver) new ResizeObserver(reportLiveness).observe(document.body);
  setInterval(reportLiveness, 1500);
}

const root = document.getElementById('root')!;
createRoot(root).render(
  <Suspense fallback={<div className="empty-state" style={{ height: '100%' }}>Loading dashboard…</div>}>
    <SessionDashboardPage />
  </Suspense>,
);
