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
  // Any ⟦…⟧ machine banner that OPENS the message — heartbeat, worker-status,
  // bootstrap, the cluster-change notice (⟦CLUSTER-CHANGE⟧) and the controller's
  // ⟦CLUSTER ROSTER CHANGED⟧ directive, and any future marker. The ⟦ (U+27E6) is
  // reserved for lm-assist scaffolding; genuine prose does not start with it.
  if (t.startsWith('⟦')) return true;
  // …and a banner appearing LATER in the text (e.g. a provenance footer).
  return (
    t.includes('⟦WORKER-STATUS⟧') ||
    t.includes('⟦HEARTBEAT⟧') ||
    t.includes('⟦lm-assist') ||
    t.includes('⟦BOOTSTRAP') ||
    t.includes('⟦CLUSTER')
  );
}

/**
 * Span-aware transcript filter for the "Only user ↔ assistant" toggle.
 *
 * `isInjectedMessageText` alone hides the injected USER directives (e.g. the
 * standing "Run a controller pass now…"), but the ASSISTANT turns that RESPOND
 * to a hidden directive — the controller's "Running the pass…", its tool-call
 * turns, and its summary — carry ordinary text and would stay visible. A reply
 * to a hidden prompt is noise, so we hide the whole exchange: an injected user
 * turn opens a HIDDEN SPAN that also swallows every following non-user
 * (assistant / tool) turn, until the next user turn. A genuine user turn (incl.
 * `[mission …]`) CLOSES the span — it and its responses stay visible. A non-user
 * turn whose own text is injected (a stray ⟦HEARTBEAT⟧ reply) is hidden too,
 * preserving the old per-message behavior.
 *
 * Safe because the mission read API folds tool calls into `tools[]` and emits NO
 * tool-result user turns — so every `user`-role message is a real conversational
 * turn, not a tool result (verified against a live controller transcript
 * 2026-06-29). Role resolves from `role`, falling back to `type`, matching the
 * chat renderers.
 */
export function filterInjectedExchanges<T extends { role?: string; type?: string }>(
  messages: T[],
  getText: (m: T) => string,
): T[] {
  const out: T[] = [];
  let hidingResponses = false;
  for (const m of messages) {
    const role = m.role || m.type || '';
    const injected = isInjectedMessageText(getText(m));
    if (role === 'user') {
      // A user turn always (re)decides the span: injected → open it (and drop the
      // directive); genuine → close it (and keep the turn).
      if (injected) {
        hidingResponses = true;
        continue;
      }
      hidingResponses = false;
      out.push(m);
    } else {
      // assistant / tool / other: hidden while inside a span, or if itself injected.
      if (hidingResponses || injected) continue;
      out.push(m);
    }
  }
  return out;
}
