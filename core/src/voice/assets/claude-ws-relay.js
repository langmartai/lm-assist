// claude-ws-relay.js — injected into the claude.ai voice page. Bridges the SAME-ORIGIN
// claude.ai voice WS <-> Core via Puppeteer CDP bindings (NOT a loopback WebSocket): the
// page's CSP (connect-src 'self') forbids connecting to Core, but a CDP binding is a native
// binding, not a network connection, so it is CSP-immune. globalThis.__lmToCore is an
// exposeFunction binding Core installed; globalThis.__lmFromCore is defined here and called
// by Core via page.evaluate. Binary frames ride as base64 (exposeFunction args are JSON).
(function () {
  const VOICE_URL = globalThis.__VOICE_URL__;
  let ws = null;
  const toCore = (env) => { try { globalThis.__lmToCore(env); } catch (e) {} };
  const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
  // Core -> page -> claude.ai
  globalThis.__lmFromCore = (env) => {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(env.t === 'bin' ? Uint8Array.from(atob(env.d), (c) => c.charCodeAt(0)) : env.d); } catch (e) {}
  };
  try {
    ws = new WebSocket(VOICE_URL);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => toCore({ t: 'status', state: 'up_open' });
    ws.onmessage = (ev) => { if (typeof ev.data === 'string') toCore({ t: 'text', d: ev.data }); else toCore({ t: 'bin', d: b64(ev.data) }); };
    ws.onclose = (e) => toCore({ t: 'status', state: 'up_close', code: e.code, timeout: e.code === 4008 });
    ws.onerror = () => toCore({ t: 'status', state: 'up_error' });
  } catch (e) { toCore({ t: 'status', state: 'up_error' }); }
})();
