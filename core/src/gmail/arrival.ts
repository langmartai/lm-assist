/**
 * New-mail arrival: the browser PUSHES, and a heartbeat proves it still can.
 *
 * MEASURED 2026-07-31, both halves of this design:
 *
 *   - The driver's Gmail tab UPDATES ITSELF when mail arrives. A message sent to
 *     the account became the top row, and the nav count moved, within 15s, on a
 *     page nothing had navigated. Google had already pushed it.
 *   - A CDP `Runtime.addBinding` + `MutationObserver` turns that into a real
 *     event: prototype delivered `Runtime.bindingCalled` ~1s after the send.
 *
 * So this does not poll Gmail, and it does not poll the page either. It holds one
 * CDP session, installs a binding the page can call, and waits.
 *
 * 🔴 THE HEARTBEAT IS THE POINT. A push listener that dies is silent, and silence
 * is exactly what "no new mail" looks like — the two are indistinguishable from
 * the outside, which is the worst property a notifier can have. Worse, an OPEN
 * SOCKET IS NOT EVIDENCE: a page reload destroys both the binding and the
 * observer while the WebSocket stays perfectly healthy. So the heartbeat does not
 * check the socket. It fires a SYNTHETIC event through the exact path a real
 * arrival would take — page calls the binding, client receives bindingCalled —
 * and treats a missing pong as a broken path, reinstalling on the spot.
 *
 * An earlier polling version of this file failed its own live test: it ticked on
 * schedule and never reported the arrival, because its first tick set the
 * baseline AFTER the mail had landed, so "changed" was never true. That is the
 * class of bug this design removes rather than patches — transitions are
 * reported by the page as they happen, instead of inferred from snapshots.
 */

import WebSocket from 'ws';
import { resolveCdpBase } from './config';
import { gmailSummary, syncWindow } from './cdp-client';

type Logger = (...a: unknown[]) => void;

/** The page-side function name. Namespaced so it cannot collide with Gmail's own. */
const BINDING = '__lmGmailEvent';

export interface ArrivalState {
  watching: boolean;
  connected: boolean;
  heartbeatMin: number;
  autoSync: boolean;
  /** Last real arrival pushed by the page. */
  lastPushAt: number | null;
  lastTopId: string | null;
  /** Last time the heartbeat ran, and last time its ping came back. */
  lastHeartbeatAt: number | null;
  lastPongAt: number | null;
  /** How often the path had to be repaired — a rising count is a real signal. */
  reinstalls: number;
  lastError: string | null;
}

const state: ArrivalState = {
  watching: false,
  connected: false,
  heartbeatMin: 0,
  autoSync: true,
  lastPushAt: null,
  lastTopId: null,
  lastHeartbeatAt: null,
  lastPongAt: null,
  reinstalls: 0,
  lastError: null,
};

export function arrivalState(): ArrivalState {
  return { ...state };
}

let log: Logger = (...a) => console.error('[gm-arrival]', ...a);
let started = false;
let ws: WebSocket | null = null;
let msgId = 0;
const pending = new Map<number, { res: (v: unknown) => void; rej: (e: unknown) => void }>();
let hbTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pendingPing: { nonce: string; at: number } | null = null;
/**
 * True while WE are driving the page (summary refresh, sync). Our own navigation
 * changes the top row exactly like an arrival does, so without this an arrival
 * could refresh the summary, whose navigation fires the observer, which refreshes
 * the summary... Measured over 100s it did not loop — the summary happens to end
 * back on #inbox with the same top row — but that is timing, not a guarantee, and
 * a feedback loop against a live mailbox is not a bug worth discovering in
 * production.
 */
let selfDriving = false;

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((res, rej) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return rej(new Error('cdp socket not open'));
    const id = ++msgId;
    pending.set(id, { res, rej });
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rej(new Error(`${method} timed out`));
      }
    }, 15_000);
    timer.unref?.();
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** The observer. Reports TRANSITIONS, so nothing depends on when we started watching. */
function observerScript(): string {
  return `(() => {
    try { if (window.__lmObs) window.__lmObs.disconnect(); } catch (e) {}
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && e.offsetParent !== null; };
    const top = () => {
      const rows = [...document.querySelectorAll('tr.zA')].filter(vis);
      const h = rows.length ? rows[0].querySelector('[data-legacy-thread-id]') : null;
      return h ? h.getAttribute('data-legacy-thread-id') : null;
    };
    let last = top();
    // Published so the heartbeat can RECONCILE: an observer that has silently
    // stopped keeps its old value while the DOM moves on, and that divergence is
    // the only reliable evidence of a dead listener. A truthy window.__lmObs is
    // NOT evidence - MEASURED: it stays truthy after .disconnect(), and the
    // binding keeps working, so a liveness check passes while detection is dead.
    window.__lmLastSeen = last;
    const target = document.querySelector('div[role="main"]') || document.body;
    window.__lmTarget = target;
    window.__lmObs = new MutationObserver(() => {
      const t = top();
      if (t && t !== last) {
        last = t;
        window.__lmLastSeen = t;
        try { window.${BINDING}(JSON.stringify({ type: 'mail', topId: t, at: Date.now() })); } catch (e) {}
      }
    });
    window.__lmObs.observe(target, { childList: true, subtree: true });
    return { installed: true, baseline: last };
  })()`;
}

/** (Re)install binding + observer. Both die with the document, so this is not one-time setup. */
async function install(): Promise<void> {
  await send('Runtime.enable');
  await send('Page.enable').catch(() => undefined);
  await send('Runtime.addBinding', { name: BINDING });
  await send('Runtime.evaluate', { expression: observerScript(), returnByValue: true });
}

async function handleMail(topId: string): Promise<void> {
  if (selfDriving) return; // our own navigation, not an arrival
  selfDriving = true;
  state.lastPushAt = Date.now();
  state.lastTopId = topId;
  log(`new mail pushed by the page (top=${topId})`);
  // MEASURED 2026-07-31: refreshing ~1s after the push produced todayArrived=0 on
  // a mailbox that had just received mail — the search views the counts come from
  // had not settled. The push is the signal; it does not have to be acted on in
  // the same second.
  await new Promise((r) => setTimeout(r, 4000));
  try {
    await gmailSummary();
  } catch {
    /* a summary refresh must never break the listener */
  }
  if (state.autoSync) {
    try {
      // Safe on every arrival: startSync is single-flight, so a second call joins
      // the running walk rather than starting a rival over the same mailbox.
      await syncWindow({ days: 1, label: 'inbox' });
    } catch {
      /* a sync failure is visible in sync-status; never kill the listener for it */
    }
  }
  selfDriving = false;
}

/**
 * Prove the whole path, not the socket.
 *
 * Calls the binding FROM THE PAGE and waits for the event to come back. That
 * exercises exactly what a real arrival uses, so a reloaded page (binding and
 * observer gone, socket still open) fails it — which is the case a socket check
 * would happily pass.
 */
async function heartbeat(): Promise<void> {
  if (selfDriving) return; // a refresh is in flight; the path is demonstrably alive
  state.lastHeartbeatAt = Date.now();
  const nonce = Math.random().toString(36).slice(2, 10);
  pendingPing = { nonce, at: Date.now() };
  try {
    const alive = (await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && e.offsetParent !== null; };
        const top = () => {
          const rows = [...document.querySelectorAll('tr.zA')].filter(vis);
          const h = rows.length ? rows[0].querySelector('[data-legacy-thread-id]') : null;
          return h ? h.getAttribute('data-legacy-thread-id') : null;
        };
        const bindingOk = typeof window.${BINDING} === 'function';
        const obsOk = !!window.__lmObs;
        // Is the observed node still IN the document? An SPA can swap
        // div[role="main"] with no navigation, leaving the observer watching a
        // detached node — alive by every flag, blind in fact.
        const attached = !!window.__lmTarget && document.contains(window.__lmTarget);
        const actual = top();
        const lastSeen = typeof window.__lmLastSeen === 'string' ? window.__lmLastSeen : null;
        const rows = [...document.querySelectorAll('tr.zA')].filter(vis).length;
        if (bindingOk) { try { window.${BINDING}(JSON.stringify({ type: 'pong', nonce: ${JSON.stringify(nonce)} })); } catch (e) {} }
        return { bindingOk, obsOk, attached, actual, lastSeen, rows };
      })()`,
    })) as {
      result?: {
        value?: { bindingOk: boolean; obsOk: boolean; attached: boolean; actual: string | null; lastSeen: string | null; rows: number };
      };
    };
    const v = alive?.result?.value;
    if (!v || !v.bindingOk || !v.obsOk || !v.attached) {
      const why = !v ? 'no answer' : !v.bindingOk ? 'binding gone' : !v.obsOk ? 'observer gone' : 'observed node detached';
      log(`heartbeat: path broken (${why}) — reinstalling`);
      state.reinstalls++;
      state.lastError = why;
      await install();
      return;
    }
    if (v.rows === 0) {
      // No thread rows: signed out, or not on a list view. Nothing can be
      // detected from here, and saying so beats reporting a healthy listener
      // that structurally cannot see mail.
      state.lastError = 'no thread rows visible (signed out, or not on a list view)';
    } else {
      state.lastError = null;
    }
    // RECONCILE. The observer's own record versus what the page shows. They
    // diverge when an event was missed — a stopped observer, a swapped node, or
    // mail that landed while the connection was down. This is the check that
    // makes a silent failure loud, and the one a liveness flag cannot make.
    if (v.actual && v.lastSeen && v.actual !== v.lastSeen) {
      log(`heartbeat: MISSED an arrival (observer saw ${v.lastSeen}, page shows ${v.actual}) — repairing`);
      state.reinstalls++;
      await install();
      await handleMail(v.actual);
      return;
    }
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : String(e);
    log(`heartbeat: evaluate failed (${state.lastError}) — reconnecting`);
    scheduleReconnect();
    return;
  }

  // Give the pong a moment; a page that accepted the call but cannot reach us is
  // still a broken path.
  setTimeout(() => {
    if (pendingPing && pendingPing.nonce === nonce) {
      pendingPing = null;
      state.reinstalls++;
      log('heartbeat: ping accepted but no pong returned — reinstalling');
      install().catch(() => scheduleReconnect());
    }
  }, 5_000).unref?.();
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  state.connected = false;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(() => scheduleReconnect());
  }, 15_000);
  reconnectTimer.unref?.();
}

async function connect(): Promise<void> {
  const base = resolveCdpBase();
  const list = (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json())) as Array<{
    type: string;
    url?: string;
    webSocketDebuggerUrl?: string;
  }>;
  const page =
    list.find((t) => t.type === 'page' && /mail\.google\.com/.test(t.url || '')) || list.find((t) => t.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('no Gmail page to attach to');

  const sock = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  ws = sock;
  await new Promise<void>((res, rej) => {
    sock.once('open', () => res());
    sock.once('error', (e) => rej(e));
  });

  sock.on('message', (buf: WebSocket.RawData) => {
    let m: { id?: number; method?: string; params?: { name?: string; payload?: string }; error?: unknown; result?: unknown };
    try {
      m = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error)));
      else res(m.result);
      return;
    }
    if (m.method === 'Runtime.bindingCalled' && m.params?.name === BINDING) {
      let payload: { type?: string; topId?: string; nonce?: string } = {};
      try {
        payload = JSON.parse(String(m.params.payload || '{}'));
      } catch {
        return;
      }
      if (payload.type === 'pong') {
        if (pendingPing && payload.nonce === pendingPing.nonce) {
          state.lastPongAt = Date.now();
          pendingPing = null;
        }
        return;
      }
      if (payload.type === 'mail' && payload.topId) void handleMail(payload.topId);
      return;
    }
    // A navigation destroys binding and observer while the socket lives on.
    if (m.method === 'Page.frameNavigated') {
      state.reinstalls++;
      log('page navigated — reinstalling the listener');
      install().catch(() => scheduleReconnect());
    }
  });

  sock.on('close', () => {
    state.connected = false;
    log('cdp socket closed — will reconnect');
    scheduleReconnect();
  });
  sock.on('error', () => {
    /* close follows */
  });

  await install();
  state.connected = true;
  state.lastError = null;
  log('attached: the page will push arrivals');
}

export function startGmailArrivalWatch(logger: Logger = log): void {
  if (started) return;
  log = logger;
  const hb = Number(process.env.GMAIL_HEARTBEAT_MIN ?? '3');
  if (!Number.isFinite(hb) || hb <= 0) {
    log('disabled (GMAIL_HEARTBEAT_MIN <= 0)');
    return;
  }
  started = true;
  state.watching = true;
  state.heartbeatMin = hb;
  state.autoSync = process.env.GMAIL_WATCH_SYNC !== '0';

  // The browser may not be up yet at Core boot; a failure here is normal and the
  // reconnect loop owns it.
  connect().catch((e) => {
    state.lastError = e instanceof Error ? e.message : String(e);
    scheduleReconnect();
  });

  hbTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      scheduleReconnect();
      return;
    }
    void heartbeat();
  }, Math.max(1, hb) * 60_000);
  hbTimer.unref?.();
  log(`started (heartbeat every ${hb} min, autoSync=${state.autoSync})`);
}

export function stopGmailArrivalWatch(): void {
  if (hbTimer) clearInterval(hbTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  hbTimer = null;
  reconnectTimer = null;
  try {
    ws?.close();
  } catch {
    /* nothing to do */
  }
  ws = null;
  started = false;
  state.watching = false;
  state.connected = false;
}
