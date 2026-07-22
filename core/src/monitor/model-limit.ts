/**
 * Model-limit detection + switch policy — the MODEL class of stall.
 *
 * Distinct from the server/network class in `stall-classify.ts`: a per-model usage
 * limit is not retryable (the model itself is exhausted, `continue` changes nothing),
 * it is *switchable* — move the session to a model that still has headroom.
 *
 * The two classes never mix: `model_limit` is deliberately absent from
 * SERVER_STALL_STATES, so the auto-resume tick cannot see a model-limited session,
 * and this module only acts on a model-named "reached your … limit" banner, so it
 * cannot see a 529/5xx.
 *
 * Pure — no IO. Every decision is a function of text + config + prior record.
 */

import { MODEL_LIMIT_BANNER_RE } from '../terminal/cc-classify';

/** Model families we can recognise on screen and switch between. */
export const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

/** A model token as displayed ("Fable 5", "Opus 4.8", "claude-opus-4-8"). */
const MODEL_TOKEN_RE = /\b(opus|sonnet|haiku|fable)\b/i;

/** The live model sits at the end of the status line, right after the session id:
 *      `… pid:357656 pts/181 up:48m sid: <uuid> Fable 5`
 *  optionally followed by further right-aligned segments (`◈ max · /effort`), which
 *  are always separated by a run of 2+ spaces.
 *
 *  Global on purpose: an agent that is READING or WRITING screen captures (this feature's
 *  own tests, a support transcript) has other `sid: …` lines scrolled up its pane. The
 *  live status line is the BOTTOM one, so we take the LAST match, never the first. */
const STATUS_MODEL_RE = /sid:\s*[0-9a-f-]{36}\s+(\S[^\n]*?)(?:\s{2,}|$)/gim;

/** Map any display/CLI spelling onto its family, or null when unrecognised. */
export function normalizeModel(s: string | null | undefined): ModelFamily | null {
  const m = (s || '').match(MODEL_TOKEN_RE);
  return m ? (m[1].toLowerCase() as ModelFamily) : null;
}

/** What Claude Code prints after a `/model` interaction resolves — either it applied
 *  ("Set model to Opus 4.8") or the user declined the confirm ("Kept model as Fable 5").
 *  On a cloud CCR there is no status line, so this is the only current-model signal. */
const MODEL_DECISION_RE = /(Set model to|Kept model as)\s+((?:opus|sonnet|haiku|fable)[\w.\s-]{0,8}?)(?=[.,\n]|\s+and\b|$)/gi;

export interface ModelDecision {
  kind: 'set' | 'kept';
  model: ModelFamily;
  index: number;
}

/** The MOST RECENT `/model` outcome in the text, or null. */
export function parseModelDecision(text: string): ModelDecision | null {
  const re = new RegExp(MODEL_DECISION_RE.source, MODEL_DECISION_RE.flags);
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || ''))) {
    last = m;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (!last) return null;
  const model = normalizeModel(last[2]);
  if (!model) return null;
  return { kind: /kept/i.test(last[1]) ? 'kept' : 'set', model, index: last.index };
}

export interface ModelLimitDetection {
  limited: boolean;
  /** the family that is exhausted, e.g. 'fable' */
  model: ModelFamily | null;
  /** the model exactly as printed, e.g. 'Fable 5' */
  modelLabel: string | null;
  /** the matched banner line (trimmed, capped) */
  detail: string | null;
  /** offset of the banner in the text — lets callers rank it against later events */
  index: number;
}

/** Detect a per-model usage-limit banner in captured screen / message text. */
export function detectModelLimit(text: string): ModelLimitDetection {
  const t = text || '';
  const none: ModelLimitDetection = { limited: false, model: null, modelLabel: null, detail: null, index: -1 };
  const m = t.match(MODEL_LIMIT_BANNER_RE);
  if (!m) return none;
  const label = m[1].trim();
  const family = normalizeModel(label);
  if (!family) return none;
  const detail = m[0].length > 200 ? m[0].slice(0, 200) : m[0];
  return { limited: true, model: family, modelLabel: label, detail: detail.trim(), index: m.index ?? 0 };
}

/** Read the session's CURRENT model off the status line. Null when not determinable. */
export function parseCurrentModel(text: string): ModelFamily | null {
  const re = new RegExp(STATUS_MODEL_RE.source, STATUS_MODEL_RE.flags);
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || ''))) {
    last = m;
    if (m.index === re.lastIndex) re.lastIndex++; // never loop on a zero-width match
  }
  return last ? normalizeModel(last[1]) : null;
}

/**
 * `/model <x>` is NOT always one-shot: when the conversation is already cached for the
 * current model, Claude Code asks to confirm (observed live on a 233k-token executor —
 * a fresh session never shows it):
 *
 *     Switch model?
 *     This conversation is cached for the current model. Switching to Opus 4.8 means
 *     the full history gets re-read on your next message.
 *      ❯ 1. Yes, switch to Opus 4.8
 *        2. No, go back
 *
 * Returns the 1-based option to press, or null when this is NOT that dialog — the
 * option must both read as an affirmative switch AND name the model we asked for, so a
 * permission prompt or any other numbered menu can never be answered by accident.
 */
export function findModelSwitchConfirm(
  dialog: { question: string; options: Array<{ label: string }> } | null,
  to: ModelFamily,
): number | null {
  if (!dialog || !dialog.options?.length) return null;
  const looksLikeSwitch =
    /switch model\?/i.test(dialog.question) ||
    /cached for the current model/i.test(dialog.question) ||
    dialog.options.some((o) => /yes,\s*switch to/i.test(o.label));
  if (!looksLikeSwitch) return null;
  for (let i = 0; i < dialog.options.length; i++) {
    const label = dialog.options[i].label;
    if (/\byes\b/i.test(label) && normalizeModel(label) === to) return i + 1;
  }
  return null;
}

export interface ModelFallbackConfig {
  enabled: boolean;
  /** the model to switch TO (family or CLI alias) */
  fallbackModel: string;
  /** families whose limit triggers a switch */
  fromModels: string[];
}

/** What we remember about a session we already switched. */
export interface ModelSwitchRecord {
  switchedAt: number;
  attempts: number;
  from: string;
  to: string;
  verified: boolean;
}

export type ModelSwitchAction = 'switch' | 'noop';

export interface ModelSwitchDecision {
  action: ModelSwitchAction;
  /** family to switch to (only when action==='switch') */
  to: ModelFamily | null;
  limitedModel: ModelFamily | null;
  currentModel: ModelFamily | null;
  reason: string;
}

/**
 * Decide whether a screen warrants a `/model <fallback>`. Ordered, pure, total.
 *
 * The idempotency guarantee is rule 5: the banner stays on screen long after the
 * switch (it is transcript history, it scrolls, it does not clear), so "am I already
 * on the fallback?" — not "is a banner visible?" — is what decides.
 */
export function decideModelSwitch(input: {
  screen: string;
  cfg: ModelFallbackConfig;
  record?: ModelSwitchRecord;
  now: number;
  cooldownMs: number;
  /** Override the current model when it can't be read off a status line (remote CCR). */
  currentModel?: ModelFamily | null;
}): ModelSwitchDecision {
  const { screen, cfg, record, now, cooldownMs } = input;
  const nil = { to: null, limitedModel: null, currentModel: null };

  if (!cfg.enabled) return { action: 'noop', ...nil, reason: 'disabled' };

  const det = detectModelLimit(screen);
  if (!det.limited || !det.model) return { action: 'noop', ...nil, reason: 'no-model-limit' };

  const limitedModel = det.model;
  const decision = parseModelDecision(screen);
  // Current model, most trustworthy first: caller override → live status line → the last
  // `/model` outcome (the only signal a cloud CCR has, since it renders no status line).
  const currentModel =
    input.currentModel !== undefined ? input.currentModel : parseCurrentModel(screen) ?? decision?.model ?? null;
  const base = { limitedModel, currentModel };

  // A human was offered the switch and said no ("Kept model as Fable 5") AFTER the limit
  // banner. That is an explicit decision to stay put — observed on a live cloud CCR — and
  // an automated actor must not overrule it. Only a keep MORE RECENT than the banner
  // counts, so a fresh limit after an old decline is still actionable.
  if (decision && decision.kind === 'kept' && decision.model === limitedModel && decision.index > det.index) {
    return { action: 'noop', to: null, ...base, reason: 'user-kept-model' };
  }

  const from = cfg.fromModels.map((f) => normalizeModel(f)).filter(Boolean) as ModelFamily[];
  if (!from.includes(limitedModel)) {
    return { action: 'noop', to: null, ...base, reason: `not-a-from-model(${limitedModel})` };
  }

  const to = normalizeModel(cfg.fallbackModel);
  if (!to) return { action: 'noop', to: null, ...base, reason: `bad-fallback(${cfg.fallbackModel})` };

  // Never switch to the model that is itself exhausted.
  if (to === limitedModel) return { action: 'noop', to: null, ...base, reason: 'fallback-is-limited' };

  // THE invariant: you can only be blocked by the model you are actually running on.
  // If the live status line says otherwise, the banner is not a live block — it is either
  // history (we already switched; the banner stays in scrollback forever) or it is merely
  // TEXT (a session reading a capture, writing these very tests, or discussing the
  // feature — observed on this feature's own dev session). Both are no-ops. This is the
  // idempotency guarantee and the anti-false-positive guard in one rule.
  if (currentModel && currentModel !== limitedModel) {
    return {
      action: 'noop',
      to: null,
      ...base,
      reason: currentModel === to ? 'already-on-fallback' : `not-on-limited-model(${currentModel})`,
    };
  }

  if (record && now - record.switchedAt < cooldownMs) {
    return { action: 'noop', to: null, ...base, reason: 'cooldown' };
  }

  return { action: 'switch', to, ...base, reason: `model-limit(${limitedModel})→${to}` };
}
