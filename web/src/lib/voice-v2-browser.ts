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
 * iOS/iPadOS is called out separately and deliberately. Apple requires every browser on the
 * platform to use WebKit, and WebKit has never shipped MediaStreamTrackProcessor — so "use
 * Chrome or Edge" is not merely unhelpful there, it is WRONG: installing Chrome on an iPad gets
 * you WebKit with a different icon. What DOES work on iPad is the dictation mic beside this
 * control, which needs only getUserMedia + AudioWorklet, so that is what we point at.
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

/**
 * iOS/iPadOS, including modern iPadOS Safari — which reports itself as "MacIntel" and is
 * distinguishable from a real Mac only by having a touchscreen.
 */
export function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  const nav = navigator as unknown as { platform?: string; maxTouchPoints?: number };
  return nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1;
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
  // Capture needs SOME frame source: MediaStreamTrackProcessor (Chromium) OR AudioWorklet
  // (WebKit). Requiring the former specifically excluded iPad, which has AudioEncoder and
  // AudioWorklet and can run voice fine through the worklet path — measured on the device:
  // {audioEncoder:true, trackProcessor:false, audioContext:true}.
  const hasCapture = typeof w.MediaStreamTrackProcessor !== 'undefined' || typeof w.AudioWorklet !== 'undefined';
  if (typeof w.AudioEncoder === 'undefined' || !hasCapture) {
    return {
      ok: false,
      reason: isAppleMobile()
        // Every iOS/iPadOS browser is WebKit, so switching browser cannot help — say so, and
        // point at the dictation mic, which does work here.
        ? 'this iPhone/iPad lacks the WebCodecs audio encoder voice needs — use the mic button for dictation, or open this page on desktop Chrome or Edge'
        : 'this browser lacks WebCodecs — voice needs Chrome or Edge',
    };
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
