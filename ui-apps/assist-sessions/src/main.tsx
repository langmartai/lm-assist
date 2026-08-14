/* Pane entry: mount the ORIGINAL sessions page (web/src/components/sessions) with
 * the pane environment installed around it. Shims (build.mjs aliases) supply the
 * app-mode/machine contexts and next/navigation; here we install the data-plane
 * fetch patch, apply the embed/theme contract, and keep the shell's liveness ping.
 */
import { installDataPlane, installSessionLinkRewrite } from './data-plane';

installDataPlane();
installSessionLinkRewrite();

import { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionBrowser } from '../../../web/src/components/sessions/SessionBrowser';

// ── embedding + theme contract (SPEC 5.5; same semantics as every sibling pane) ──
const qs = new URLSearchParams(window.location.search);
const EMBEDDED = qs.get('embed') === '1';
if (EMBEDDED) document.body.classList.add('embed');
// globals.css themes on [data-theme] at the root — dark is the base palette.
document.documentElement.dataset.theme = qs.get('theme') === 'light' ? 'light' : 'dark';

// The web page's persisted default tab is Console — a stub here. First visit
// lands on Chat instead; a user's own later choice is persisted and honored.
try {
  if (!localStorage.getItem('session-detail-tab')) localStorage.setItem('session-detail-tab', 'chat');
} catch { /* storage unavailable — the page falls back to its own default */ }

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
  <Suspense fallback={<div className="empty-state" style={{ height: '100%' }}>Loading sessions…</div>}>
    <SessionBrowser />
  </Suspense>,
);
