import { test, expect } from 'vitest';
import { filterInjectedExchanges, isInjectedMessageText } from '../injected-message';

// Minimal message shape shared by both callers (MissionSessionChat SessionMessage
// and CcrCloudView CloudMsg both expose role?/type?/text).
type M = { role?: string; type?: string; text?: string };
const text = (m: M) => m.text ?? '';

// ── isInjectedMessageText (per-message predicate, unchanged) ──────────────────

test('isInjectedMessageText — controller directive + banners are injected; [mission …] is not', () => {
  expect(isInjectedMessageText('Run a controller pass now. FIRST call mission_changes.')).toBe(true);
  expect(isInjectedMessageText('⟦HEARTBEAT⟧ idle — nothing to do')).toBe(true);
  expect(isInjectedMessageText('[lm-assist bootstrap] load tools')).toBe(true);
  expect(isInjectedMessageText('[mission abc] please check worker 2')).toBe(false);
  expect(isInjectedMessageText('Doing the work now.')).toBe(false);
});

test('isInjectedMessageText — cluster-change + cluster-roster-changed banners are injected', () => {
  // ⟦CLUSTER-CHANGE⟧ notice injected into active workers when the node moves cluster.
  expect(isInjectedMessageText('⟦CLUSTER-CHANGE⟧ This node moved from cluster "stage" to "prod". …')).toBe(true);
  // ⟦CLUSTER ROSTER CHANGED⟧ directive the supervisor drives into the controller.
  expect(isInjectedMessageText("⟦CLUSTER ROSTER CHANGED⟧ Your cluster's node membership just changed. …")).toBe(true);
  // Any ⟦…⟧ opener is treated as a banner (future-proofing).
  expect(isInjectedMessageText('⟦SOME-NEW-MARKER⟧ whatever')).toBe(true);
});

test('filterInjectedExchanges — a ⟦CLUSTER ROSTER CHANGED⟧ directive hides its response too', () => {
  const msgs: M[] = [
    { role: 'user', text: "⟦CLUSTER ROSTER CHANGED⟧ Your cluster's node membership just changed. …" },
    { role: 'assistant', text: 'Re-reading my scope and migrating workers.' },
    { role: 'assistant', text: '[1 tool call(s)]' },
  ];
  expect(filterInjectedExchanges(msgs, text)).toEqual([]);
});

// ── filterInjectedExchanges (span-aware: hides a directive AND its responses) ──

test('hides an injected directive AND every assistant response that follows it', () => {
  const msgs: M[] = [
    { role: 'user', text: 'Run a controller pass now. FIRST call mission_changes.' },
    { role: 'assistant', text: "I'll run the pass." },
    { role: 'assistant', text: '[1 tool call(s)]' },
    { role: 'assistant', text: 'No change since the last pass.' },
  ];
  expect(filterInjectedExchanges(msgs, text)).toEqual([]);
});

test('keeps a genuine [mission …] user turn and its responses', () => {
  const msgs: M[] = [
    { role: 'user', text: '[mission abc] please check worker 2' },
    { role: 'assistant', text: 'Checking worker 2 now.' },
    { role: 'assistant', text: '[1 tool call(s)]' },
  ];
  expect(filterInjectedExchanges(msgs, text)).toEqual(msgs);
});

test('a genuine user turn ENDS a prior injected span (responses after it stay visible)', () => {
  const msgs: M[] = [
    { role: 'user', text: 'Run a controller pass now.' }, // hidden (directive)
    { role: 'assistant', text: 'Running pass.' },          // hidden (its response)
    { role: 'user', text: '[mission abc] do X' },          // visible (genuine)
    { role: 'assistant', text: 'Doing X.' },               // visible (its response)
  ];
  expect(filterInjectedExchanges(msgs, text)).toEqual([
    { role: 'user', text: '[mission abc] do X' },
    { role: 'assistant', text: 'Doing X.' },
  ]);
});

test('a leading assistant turn with no preceding directive stays visible', () => {
  const msgs: M[] = [
    { role: 'assistant', text: 'Starting up.' },
    { role: 'user', text: 'Run a controller pass now.' },
    { role: 'assistant', text: 'Running.' },
  ];
  expect(filterInjectedExchanges(msgs, text)).toEqual([{ role: 'assistant', text: 'Starting up.' }]);
});

test('resolves role from the `type` field when `role` is absent (CcrCloudView shape)', () => {
  const msgs: M[] = [
    { type: 'user', text: '⟦HEARTBEAT⟧ idle' }, // injected user → hidden
    { type: 'assistant', text: 'idle reply' },    // its response → hidden
  ];
  expect(filterInjectedExchanges(msgs, text)).toEqual([]);
});

test('an injected assistant turn is hidden even outside a span (preserves old per-message behavior)', () => {
  const msgs: M[] = [
    { role: 'assistant', text: '⟦HEARTBEAT⟧ idle — nothing to do' },
  ];
  expect(filterInjectedExchanges(msgs, text)).toEqual([]);
});

test('multiple injected passes are fully hidden (matches a real controller transcript)', () => {
  const msgs: M[] = [
    { role: 'user', text: 'Run a controller pass now.' },
    { role: 'assistant', text: 'Running the controller pass.' },
    { role: 'assistant', text: '[1 tool call(s)]' },
    { role: 'assistant', text: '⟦HEARTBEAT⟧ idle — 0 active missions' },
    { role: 'user', text: 'Run a controller pass now.' },
    { role: 'assistant', text: 'Running the controller pass.' },
    { role: 'assistant', text: '[1 tool call(s)]' },
  ];
  expect(filterInjectedExchanges(msgs, text)).toEqual([]);
});
