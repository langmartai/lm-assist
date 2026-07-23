// claude-ws-relay.js — injected into the claude.ai voice page. Bridges the
// claude.ai voice WS <-> a loopback wss to Core. No audio here (audio is in
// the user's browser); this only carries frames past Cloudflare via real Chrome.
(function () {
  const VOICE_URL = window.__VOICE_URL__, BRIDGE_URL = window.__BRIDGE_URL__;
  let up = null;      // claude.ai voice WS
  let bridge = null;  // loopback wss to Core
  const openBridge = () => {
    bridge = new WebSocket(BRIDGE_URL);
    bridge.binaryType = 'arraybuffer';
    bridge.onopen = () => openUpstream();
    bridge.onmessage = (ev) => { if (up && up.readyState === 1) up.send(ev.data); }; // browser->claude.ai
    bridge.onclose = () => { try { up && up.close(); } catch (e) {} };
  };
  const openUpstream = () => {
    up = new WebSocket(VOICE_URL);
    up.binaryType = 'arraybuffer';
    up.onopen = () => post({ type: '__page_status', state: 'up_open' });
    up.onmessage = (ev) => { if (bridge && bridge.readyState === 1) bridge.send(ev.data); }; // claude.ai->browser
    up.onclose = (e) => { post({ type: '__page_status', state: 'up_close', code: e.code, timeout: e.code === 4008 }); try { bridge && bridge.close(); } catch (er) {} };
    up.onerror = () => post({ type: '__page_status', state: 'up_error' });
  };
  const post = (o) => { try { if (bridge && bridge.readyState === 1) bridge.send(JSON.stringify(o)); } catch (e) {} };
  openBridge();
})();
