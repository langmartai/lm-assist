/**
 * Can THIS browser run bidirectional voice v2?
 *
 * Two independent gates decide whether the "Voice conversation" control is usable, and they
 * answer different questions:
 *   - `/voice/claude/capability` (server)  — does the NODE have a Chrome to drive claude.ai with?
 *   - this predicate (browser)             — can the LOCAL page capture and encode audio at all?
 *
 * Only the server one was ever checked, so on a browser without WebCodecs the control appeared,
 * connected, and then died the instant the engine loaded — surfacing as a bare "Voice error"
 * roughly 70ms after every click. Safari (iPad/iPhone/macOS) and Firefox ship neither
 * `AudioEncoder` nor `MediaStreamTrackProcessor`, so voice v2 cannot work there at all; the
 * honest answer is to hide the control, exactly as the dictation mic already does via
 * `voice.supported`.
 *
 * MUST mirror `supported()` in `web/public/voice/claude-voice-engine.js` — that function is
 * module-local to a public static asset (it is never bundled, so it cannot be imported), which
 * makes this a deliberate duplication. `voice-v2-browser.test.ts` reads the asset off disk and
 * fails if the two ever drift, the same guard `voice-url.test.ts` puts on the core↔web URL
 * contract. Edit both.
 */
export function voiceV2BrowserSupported(): boolean {
  if (typeof window === 'undefined') return false; // SSR — decided again on the client
  const w = window as unknown as Record<string, unknown>;
  return (
    typeof w.AudioEncoder !== 'undefined' &&
    typeof w.MediaStreamTrackProcessor !== 'undefined' &&
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
    !!(w.AudioContext || w.webkitAudioContext)
  );
}
