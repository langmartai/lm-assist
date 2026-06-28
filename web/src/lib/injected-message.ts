/**
 * Shared predicate for the "Only user ↔ assistant" transcript toggle
 * (MissionSessionChat + CcrCloudView).
 *
 * Returns true when the resolved, trimmed text is an lm-assist-INJECTED turn
 * (scaffolding the user did not type and the model did not "say"):
 *   - a ⟦WORKER-STATUS⟧ / ⟦HEARTBEAT⟧ / ⟦lm-assist…⟧ / ⟦BOOTSTRAP…⟧ banner
 *     (matched anywhere in the text — the markers may carry a suffix),
 *   - the `[lm-assist bootstrap]` instruction,
 *   - the standing `Run a controller pass now…` controller directive.
 *
 * Genuine user turns tagged `[mission …]` by the mission-chat composer are
 * NEVER injected — guarded first so they always stay visible.
 *
 * Empty text is NOT treated as injected here; callers drop truly-empty turns
 * (no text AND no tools) separately, because emptiness is tool-aware and this
 * helper is text-only.
 *
 * Note: the real controller directive ends in a period ("Run a controller pass
 * now. FIRST …"); we match the prefix WITHOUT trailing punctuation so both that
 * and the older colon variant are caught. ⟦ ⟧ are U+27E6 / U+27E7.
 */
export function isInjectedMessageText(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  // A real user message tagged by the mission-chat composer — always visible.
  if (t.startsWith('[mission ')) return false;
  // lm-assist bootstrap instruction injected into a fresh worker/cloud session.
  if (t.startsWith('[lm-assist bootstrap]')) return true;
  // The standing controller-pass directive (prefix match, punctuation-agnostic).
  if (t.startsWith('Run a controller pass now')) return true;
  // Bracketed status / bootstrap banners — anywhere in the text.
  return (
    t.includes('⟦WORKER-STATUS⟧') ||
    t.includes('⟦HEARTBEAT⟧') ||
    t.includes('⟦lm-assist') ||
    t.includes('⟦BOOTSTRAP')
  );
}
