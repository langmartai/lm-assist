/* Pane entry: mount the ORIGINAL search page (web/src/components/search/SessionSearch,
 * exactly what `/search` renders — `<SessionSearch mode="page" />`) with the pane
 * environment installed around it. Shims (build.mjs aliases) supply the app-mode and
 * machine contexts, next/navigation and the api-client probes; here we install the
 * data-plane fetch patch, apply the embed/theme contract, and keep the liveness ping.
 */
import { installDataPlane, installSessionLinkRewrite } from './data-plane';

installDataPlane();
installSessionLinkRewrite();

import { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionSearch } from '../../../web/src/components/search/SessionSearch';

// ── embedding + theme contract (SPEC 5.5; same semantics as every sibling pane) ──
const qs = new URLSearchParams(window.location.search);
const EMBEDDED = qs.get('embed') === '1';
if (EMBEDDED) document.body.classList.add('embed');
// globals.css themes on [data-theme] at the root — dark is the base palette.
document.documentElement.dataset.theme = qs.get('theme') === 'light' ? 'light' : 'dark';

// Inbound deep link: `?q=` seeds the query box. The web page has no such param (the
// overlay passes initialQuery as a prop), but a pane is addressed only by URL, so this
// is the equivalent channel — and it is what a sibling would emit to hand off a search.
const initialQuery = (qs.get('q') || '').slice(0, 512);

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
  <Suspense fallback={<div className="empty-state" style={{ height: '100%' }}>Loading search…</div>}>
    <SessionSearch mode="page" initialQuery={initialQuery} />
  </Suspense>,
);
