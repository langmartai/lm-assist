/**
 * Did a Windows prompt actually SUBMIT?
 *
 * The engine used to answer this with `submitted = [bool]$Submit` — a straight
 * echo of what the caller asked for. Measured on DESKTOP-GDKLATG 2026-07-28: the
 * text pasted fine, `submitted: true` came back, and the prompt was still sitting
 * in the composer with the session `idle`. Nothing had been sent.
 *
 * The only honest answer comes from looking at the screen afterwards: if the
 * composer line still holds the text, it did not submit.
 *
 * Pure so it is testable without Windows.
 */

/** Claude Code's composer prompt marker. */
const COMPOSER = '❯';

/** Collapse whitespace so wrapping/padding cannot break a comparison. */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Is `text` still sitting in the composer on this screen?
 *
 * 🔴 Only the LAST `❯` line is the composer. Claude Code echoes the SUBMITTED
 * prompt back into the transcript with the SAME `❯` marker, so "any ❯ line holds
 * the text" reports a failed submit on a successful one — measured: the model had
 * already replied and this still said `submitted: false`. The transcript echo is
 * above; the live composer is always the last one, and it is empty after a submit.
 */
export function composerHolds(screen: string, text: string): boolean {
  // The head is the stable part: a long prompt wraps, but it always starts
  // immediately after the composer marker.
  const needle = norm(text).slice(0, 40);
  if (!needle) return false;
  let last: string | null = null;
  for (const line of (screen || '').split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith(COMPOSER)) last = norm(t.slice(COMPOSER.length));
  }
  return last !== null && last.includes(needle);
}
