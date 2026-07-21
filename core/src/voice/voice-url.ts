/**
 * Canonical voice STT WebSocket URL decision logic — THE transport contract the
 * web mic UIs consume (cowork today; MC/CCR/Code/chart-chat in the voice epic's
 * children). The browser adapter lives in `web/src/lib/voice-url.ts`; the block
 * between the SHARED markers below must stay BYTE-IDENTICAL in both files (a core
 * test enforces this), because the web bundle cannot import core sources.
 *
 * Matrix (mirrors the secure-context reality of getUserMedia):
 *   remote/hub-proxied node        → null   (hub relay can't carry a WS upgrade — v1 TODO)
 *   https page + local mode        → wss://<page-host>/voice/stt/ws?token=…  (same-origin
 *                                    via the LM_HTTPS terminator — mixed-content safe)
 *   https page + hub mode          → null   (hub origin has no local terminator)
 *   http page + localhost          → ws://127.0.0.1:<corePort>/… (today's working path)
 *   http page + LAN IP             → null   (insecure context: the mic can't exist anyway;
 *                                    hide it cleanly instead of dangling a dead URL)
 */

// ===BEGIN SHARED VOICE URL LOGIC=== (keep byte-identical with web/src/lib/voice-url.ts)
export interface VoiceWsUrlInput {
  /** Viewing a hub-proxied / other-machine node — the `_coreapi` relay cannot carry a WS upgrade (v1). */
  isRemoteNode: boolean;
  /** detectAppMode().mode — 'local' | 'hub'. */
  appMode: string;
  /** window.location.protocol, e.g. 'https:'. */
  pageProtocol: string;
  /** window.location.host (hostname:port). */
  pageHost: string;
  /** window.location.hostname. */
  pageHostname: string;
  /** detectAppMode().baseUrl, e.g. 'http://127.0.0.1:3200' or '/_coreapi'. */
  coreBaseUrl: string;
  /** Rotating api token (window.__LM_API_TOKEN__) — rides the query string (browsers can't set WS headers). */
  token?: string;
}

/** Build the STT relay WebSocket URL for the current page, or null when the mic
 *  cannot work there (callers hide the mic UI on null — never show a dead button). */
export function buildVoiceWsUrlFromParts(i: VoiceWsUrlInput): string | null {
  if (i.isRemoteNode) return null; // hub relay can't upgrade — degrade silently (v1 TODO: WSS relay)
  const q = i.token ? `?token=${encodeURIComponent(i.token)}` : '';
  if (i.pageProtocol === 'https:') {
    // Secure page: SAME-ORIGIN wss so the one accepted cert covers it (and no mixed
    // content). Only the local LM_HTTPS terminator serves this; hub https origins
    // (mode 'hub') have no terminator → null.
    if (i.appMode !== 'local') return null;
    return `wss://${i.pageHost}/voice/stt/ws${q}`;
  }
  // Insecure (http:) page: browsers only expose getUserMedia on localhost.
  const isLoopback = i.pageHostname === 'localhost' || i.pageHostname === '127.0.0.1';
  if (!isLoopback) return null;
  if (!/^http:\/\//.test(i.coreBaseUrl)) return null;
  return `${i.coreBaseUrl.replace(/^http/, 'ws')}/voice/stt/ws${q}`;
}
// ===END SHARED VOICE URL LOGIC===
