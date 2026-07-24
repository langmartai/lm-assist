// claude-ws-relay.js — injected into the claude.ai voice page. Bridges the SAME-ORIGIN
// claude.ai voice WS <-> Core via Puppeteer CDP bindings (NOT a loopback WebSocket): the
// page's CSP (connect-src 'self') forbids connecting to Core, but a CDP binding is a native
// binding, not a network connection, so it is CSP-immune. globalThis.__lmToCore is an
// exposeFunction binding Core installed; globalThis.__lmFromCore is defined here and called
// by Core via page.evaluate. Binary frames ride as base64 (exposeFunction args are JSON).
(function () {
  const VOICE_URL = globalThis.__VOICE_URL__;
  let ws = null;
  let sawInit = false; // did claude.ai complete its `session_server_initialized` handshake?
  let retried = false; // reconnect ONCE if the socket dies before that handshake
  const toCore = (env) => { try { globalThis.__lmToCore(env); } catch (e) {} };
  const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
  // Core -> page -> claude.ai
  globalThis.__lmFromCore = (env) => {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(env.t === 'bin' ? Uint8Array.from(atob(env.d), (c) => c.charCodeAt(0)) : env.d); } catch (e) {}
  };
  function connect() {
    let sock;
    try { sock = new WebSocket(VOICE_URL); } catch (e) { toCore({ t: 'status', state: 'up_error', reason: String((e && e.message) || e) }); return; }
    ws = sock;
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => toCore({ t: 'status', state: 'up_open' });
    sock.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try { if (JSON.parse(ev.data).type === 'session_server_initialized') sawInit = true; } catch (e) {}
        toCore({ t: 'text', d: ev.data });
      } else toCore({ t: 'bin', d: b64(ev.data) });
    };
    sock.onerror = () => {}; // opaque by spec; the close below carries the code + drives retry/report
    sock.onclose = (e) => {
      if (ws !== sock) return; // a retry socket superseded this one — ignore the stale close
      // claude.ai closed BEFORE its handshake -> a transient upstream/Cloudflare reject, not a
      // real session end. Reconnect ONCE (self-heals the intermittent up_error) before failing.
      if (!sawInit && !retried) { retried = true; toCore({ t: 'status', state: 'up_retry', code: e.code }); setTimeout(connect, 800); return; }
      toCore({ t: 'status', state: 'up_close', code: e.code, reason: String(e.reason || ''), clean: !!e.wasClean, timeout: e.code === 4008 });
    };
  }
  connect();
})();
