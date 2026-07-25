/**
 * Can THIS browser run bidirectional voice v2, and if not — WHY?
 *
 * Two independent gates decide whether the "Voice conversation" control is usable, and they
 * answer different questions:
 *   - `/voice/claude/capability` (server)  — does the NODE have a Chrome to drive claude.ai with?
 *   - this predicate (browser)             — can the LOCAL page capture and encode audio at all?
 *
 * Only the server one was ever checked, so on a browser without WebCodecs the control appeared,
 * connected, and then died the instant the engine loaded — surfacing as a bare "Voice error"
 * roughly 70ms after every click.
 *
 * The `reason` matters as much as the boolean, because two very different failures land here and
 * the fixes are opposite:
 *   - no WebCodecs        -> Safari/Firefox. Nothing to do but use Chrome or Edge.
 *   - no navigator.mediaDevices -> usually NOT the browser: `mediaDevices` is undefined on any
 *     origin that is not a secure context, which includes an https origin whose certificate the
 *     browser rejected. Accepting the cert fixes it; switching browsers does not.
 * Reporting only "unsupported" would send someone to reinstall a browser when the real problem
 * is a certificate.
 *
 * MUST mirror `supported()` in `web/public/voice/claude-voice-engine.js` — that function is
 * module-local to a public static asset (never bundled, so it cannot be imported), which makes
 * this a deliberate duplication. `voice-v2-browser.test.ts` reads the asset off disk and fails if
 * the two ever drift, the same guard `voice-url.test.ts` puts on the core↔web URL contract.
 */
export interface VoiceV2BrowserSupport {
  ok: boolean;
  /** Empty when ok; otherwise a user-facing explanation naming the actual blocker. */
  reason: string;
}

export function voiceV2BrowserSupport(): VoiceV2BrowserSupport {
  if (typeof window === 'undefined') return { ok: false, reason: '' }; // SSR — re-decided on the client
  const w = window as unknown as Record<string, unknown>;

  // Checked FIRST: on a non-secure context every other capability may still be present, so
  // leading with WebCodecs would blame the browser for what is really a certificate problem.
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
    return {
      ok: false,
      reason: window.isSecureContext
        ? 'the microphone API is unavailable in this browser'
        : 'this page is not a secure context — accept the site certificate (or use localhost), then reload',
    };
  }
  if (typeof w.AudioEncoder === 'undefined' || typeof w.MediaStreamTrackProcessor === 'undefined') {
    return { ok: false, reason: 'this browser lacks WebCodecs — voice needs Chrome or Edge (Safari and Firefox cannot do it)' };
  }
  if (!(w.AudioContext || w.webkitAudioContext)) {
    return { ok: false, reason: 'this browser has no AudioContext, so playback is impossible' };
  }
  return { ok: true, reason: '' };
}

/** Boolean-only convenience for call sites that do not surface a reason. */
export function voiceV2BrowserSupported(): boolean {
  return voiceV2BrowserSupport().ok;
}
