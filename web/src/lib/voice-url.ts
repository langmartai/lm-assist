'use client';

/**
 * Voice STT WebSocket URL for the current page — THE transport contract for every
 * mic UI (cowork today; MC/CCR/Code/chart-chat in the voice epic's children).
 *
 * Usage (see ChatView's gate `{voiceWsUrl && voice.supported}` — keep both legs):
 *   const voiceWsUrl = useMemo(() => buildVoiceWsUrl({ isRemoteNode }), [isRemoteNode]);
 *
 * Returns null when the mic cannot work here (remote/hub-proxied node, hub origin,
 * or an insecure non-localhost page) — callers hide the mic UI on null.
 *
 * The decision logic between the SHARED markers is duplicated from
 * `core/src/voice/voice-url.ts` (the web bundle cannot import core sources); a core
 * test enforces the two blocks stay BYTE-IDENTICAL — edit both files together.
 */

import { detectAppMode } from './api-client';

// ===BEGIN SHARED VOICE URL LOGIC=== (keep byte-identical with core/src/voice/voice-url.ts)
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

/** Browser adapter: gather the page facts and decide. `isRemoteNode` comes from the
 *  caller's proxy context (`proxy.isProxied || !!proxy.machineId`) — the page-level
 *  node picker is caller state, not derivable from the URL here. */
export function buildVoiceWsUrl(opts: { isRemoteNode: boolean }): string | null {
  if (typeof window === 'undefined') return null;
  const { mode, baseUrl } = detectAppMode();
  const token = (window as unknown as { __LM_API_TOKEN__?: string }).__LM_API_TOKEN__ || '';
  return buildVoiceWsUrlFromParts({
    isRemoteNode: opts.isRemoteNode,
    appMode: mode,
    pageProtocol: window.location.protocol,
    pageHost: window.location.host,
    pageHostname: window.location.hostname,
    coreBaseUrl: baseUrl,
    token,
  });
}
