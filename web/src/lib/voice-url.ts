'use client';

/**
 * Voice WebSocket URL builders for the current page — THE transport contract for
 * every mic UI (cowork today; MC/CCR/Code/chart-chat in the voice epic's children).
 * Two builders: `buildVoiceWsUrl` (dictation, path `/voice/stt/ws`) and
 * `buildClaudeVoiceWsUrl` (claude.ai v2 duplex voice user bridge, path
 * `/voice/claude/ws`).
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

import { detectAppMode, peekBrowserToken } from './api-client';

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
  /** Rotating api token (fetched at runtime from Core GET /auth/browser-token) — rides the query string (browsers can't set WS headers). */
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

/** Build the claude.ai v2 voice user-bridge WebSocket URL for the current page, or null
 *  when the mic cannot work there — same rules as `buildVoiceWsUrlFromParts`, path
 *  `/voice/claude/ws` (see `claude-voice-relay.ts`'s user bridge). */
export function buildClaudeVoiceWsUrlFromParts(i: VoiceWsUrlInput): string | null {
  if (i.isRemoteNode) return null; // hub relay can't upgrade — degrade silently (v1 TODO: WSS relay)
  const q = i.token ? `?token=${encodeURIComponent(i.token)}` : '';
  if (i.pageProtocol === 'https:') {
    // Secure page: SAME-ORIGIN wss so the one accepted cert covers it (and no mixed
    // content). Only the local LM_HTTPS terminator serves this; hub https origins
    // (mode 'hub') have no terminator → null.
    if (i.appMode !== 'local') return null;
    return `wss://${i.pageHost}/voice/claude/ws${q}`;
  }
  // Insecure (http:) page: browsers only expose getUserMedia on localhost.
  const isLoopback = i.pageHostname === 'localhost' || i.pageHostname === '127.0.0.1';
  if (!isLoopback) return null;
  if (!/^http:\/\//.test(i.coreBaseUrl)) return null;
  return `${i.coreBaseUrl.replace(/^http/, 'ws')}/voice/claude/ws${q}`;
}
// ===END SHARED VOICE URL LOGIC===

/** Browser adapter: gather the page facts and decide. `isRemoteNode` comes from the
 *  caller's proxy context (`proxy.isProxied || !!proxy.machineId`) — the page-level
 *  node picker is caller state, not derivable from the URL here. */
export function buildVoiceWsUrl(opts: { isRemoteNode: boolean }): string | null {
  if (typeof window === 'undefined') return null;
  const { mode, baseUrl } = detectAppMode();
  const token = peekBrowserToken() || '';
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

/** Browser adapter for the claude.ai v2 voice user bridge — same gathering as
 *  `buildVoiceWsUrl`, routed through `buildClaudeVoiceWsUrlFromParts` (path
 *  `/voice/claude/ws`). `isRemoteNode` comes from the caller's proxy context. */
export function buildClaudeVoiceWsUrl(opts: { isRemoteNode: boolean }): string | null {
  if (typeof window === 'undefined') return null;
  const { mode, baseUrl } = detectAppMode();
  const token = peekBrowserToken() || '';
  return buildClaudeVoiceWsUrlFromParts({
    isRemoteNode: opts.isRemoteNode,
    appMode: mode,
    pageProtocol: window.location.protocol,
    pageHost: window.location.host,
    pageHostname: window.location.hostname,
    coreBaseUrl: baseUrl,
    token,
  });
}

/**
 * Re-stamp a voice WS URL with the CURRENT cached token just before it is opened.
 * Voice UIs memoise their URL at mount; if the token was rotated and re-fetched
 * since (a 401 elsewhere triggers that), the memoised `?token=` is dead. Synchronous
 * on purpose: every voice UI mounts under a layout whose LAN guard has already
 * awaited the token bootstrap, so the cache is warm. With nothing cached the URL is
 * returned unchanged (the relay then refuses it, which the UI already reports).
 */
export function withFreshVoiceToken(url: string): string {
  const token = peekBrowserToken();
  if (!token) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('token', token);
    return u.toString();
  } catch {
    return url;
  }
}
