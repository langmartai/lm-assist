// Shared browser text-to-speech (SpeechSynthesis) used by the read-aloud action row and
// voice conversation. `speechText` strips markdown so narration reads cleanly.

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** Strip markdown/code so text-to-speech reads cleanly (no backticks, symbols, or link URLs). */
export function speechText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '. code block. ')   // fenced code → short placeholder
    .replace(/`([^`]+)`/g, '$1')                      // inline code
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')        // links/images → their text
    .replace(/[#>*_~|]/g, ' ')                        // markdown punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/** Speak `text` (markdown-stripped), cancelling anything already speaking. `onEnd` fires on
 *  completion, error, or when unsupported — so callers can reliably reset their speaking state. */
export function speak(text: string, onEnd?: () => void): void {
  if (!speechSupported()) { onEnd?.(); return; }
  try {
    const synth = window.speechSynthesis;
    synth.cancel(); // stop any other utterance already playing
    const u = new SpeechSynthesisUtterance(speechText(text));
    u.onend = () => onEnd?.();
    u.onerror = () => onEnd?.();
    synth.speak(u);
  } catch { onEnd?.(); }
}

export function cancelSpeech(): void {
  if (!speechSupported()) return;
  try { window.speechSynthesis.cancel(); } catch { /* noop */ }
}
