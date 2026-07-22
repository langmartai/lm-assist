/**
 * Pure detector + switch-policy tests for the auto model-limit mitigation.
 * Screen samples are VERBATIM captures from live node-117 sessions on 2026-07-22.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { detectModelLimit, parseCurrentModel, normalizeModel, decideModelSwitch, findModelSwitchConfirm, ModelFallbackConfig } from '../monitor/model-limit';
import { parseDialogPrompt } from '../terminal/cc';
import { classifyScreen } from '../terminal/cc-classify';
import { SERVER_STALL_STATES, isServerStall } from '../monitor/stall-classify';

// ── real captures ───────────────────────────────────────────────────────────

/** Session 16946066 — a mission executor genuinely wedged on the Fable limit. */
const LIMITED_SCREEN = [
  '  binary frames, sends {type:finalize}, and asserts a {type:transcript,final} comes back.',
  "  ⎿  You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
  '',
  '✻ Sautéed for 0s',
  '',
  '❯ ',
  '    /home/ubuntu/lm-assist/.claude/worktrees/mission-mission_c5cb90cb feat/voice-dictation-lmassist-web',
  '    no worktrees ctx:23% $10.34 5h:20% 2h37m left ram:469M free:6.1G pid:357656 pts/181 up:48m sid: 16946066-1a70-4a61-8b67-d346b50cd84a Fable 5',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

/** Session 7af7075c — the Fable PROMO notice on a perfectly healthy session. */
const PROMO_SCREEN = [
  ' ▐▛███▜▌   Claude Code v2.1.197',
  '▝▜█████▛▘  Sonnet 5 with max effort · Claude Max',
  '',
  ' ▎ Extended: Fable 5 is included in your weekly limit',
  ' ▎ Through July 12, you can use up to 50% of your weekly usage limit on Fable 5. If you hit your limit, you can continue on Fable 5 with usage credits. Fable 5 draws down usage faster than Opus 4.8.',
  ' ▎ Run /model and select Fable to use it.',
  '❯ ',
  '    no worktrees ctx:0% ram:263M free:7.9G pid:3025496 pts/21 up:0m sid: 7af7075c-bc49-4a63-84ae-802ed49914bf Sonnet 5',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · gh auth login · ← for agents',
].join('\n');

/** The same executor AFTER the auto-switch — banner still in scrollback, model moved. */
const RECOVERED_SCREEN = LIMITED_SCREEN.replace(
  'sid: 16946066-1a70-4a61-8b67-d346b50cd84a Fable 5',
  'sid: 16946066-1a70-4a61-8b67-d346b50cd84a Opus 4.8                              ◈ max · /effort',
);

const cfg = (over: Partial<ModelFallbackConfig> = {}): ModelFallbackConfig => ({
  enabled: true, fallbackModel: 'opus', fromModels: ['fable'], ...over,
});

// ── detector ────────────────────────────────────────────────────────────────

describe('detectModelLimit', () => {
  test('fires on the real Fable limit banner and extracts the model', () => {
    const d = detectModelLimit(LIMITED_SCREEN);
    assert.equal(d.limited, true);
    assert.equal(d.model, 'fable');
    assert.equal(d.modelLabel, 'Fable 5');
    assert.match(d.detail!, /reached your Fable 5 limit/i);
  });

  test('does NOT fire on the Fable promo notice (the dangerous look-alike)', () => {
    assert.equal(detectModelLimit(PROMO_SCREEN).limited, false);
  });

  test('does NOT fire on the account-wide usage limit (no model named)', () => {
    assert.equal(detectModelLimit('Claude usage limit reached · resets at 3pm').limited, false);
    assert.equal(detectModelLimit("You've reached your usage limit for this week").limited, false);
  });

  test('does NOT fire on server/network errors', () => {
    for (const s of ['API Error: 529 Overloaded', 'Internal server error', 'Unable to connect to API (ECONNREFUSED)']) {
      assert.equal(detectModelLimit(s).limited, false, s);
    }
  });

  test('recognises every model family and the curly apostrophe', () => {
    assert.equal(detectModelLimit("You've reached your Opus 4.8 limit.").model, 'opus');
    assert.equal(detectModelLimit('You have reached your Sonnet 5 limit.').model, 'sonnet');
    assert.equal(detectModelLimit("You’ve reached your Haiku limit.").model, 'haiku');
  });
});

describe('parseCurrentModel', () => {
  test('reads the live model off each real status line', () => {
    assert.equal(parseCurrentModel(LIMITED_SCREEN), 'fable');
    assert.equal(parseCurrentModel(PROMO_SCREEN), 'sonnet');
    // trailing right-aligned segments after 2+ spaces must not be swallowed
    assert.equal(parseCurrentModel(RECOVERED_SCREEN), 'opus');
  });

  test('null when there is no status line', () => {
    assert.equal(parseCurrentModel('just some text'), null);
  });

  test('takes the LAST status line — scrolled-up captures must not win', () => {
    // Real failure mode, caught live: a session writing these tests had a fixture
    // status line in its scrollback and parsed as `fable` while running on opus.
    const text = [
      '  the fixture under edit reads:',
      '    no worktrees ctx:9% sid: 16946066-1a70-4a61-8b67-d346b50cd84a Fable 5',
      '  ...',
      '    no worktrees ctx:23% sid: 8ea5907c-c970-4b0a-a3f7-b5c240235c8a Opus 4.8   ◈ max',
    ].join('\n');
    assert.equal(parseCurrentModel(text), 'opus');
  });
});

test('normalizeModel maps display + CLI spellings onto families', () => {
  assert.equal(normalizeModel('Fable 5'), 'fable');
  assert.equal(normalizeModel('claude-opus-4-8'), 'opus');
  assert.equal(normalizeModel('Opus 4.8'), 'opus');
  assert.equal(normalizeModel('gibberish'), null);
  assert.equal(normalizeModel(null), null);
});

// ── the confirm dialog a cached conversation raises ─────────────────────────

/** VERBATIM from executor 16946066 after `/model opus` — only long/cached
 *  conversations raise this; a fresh session applies the switch silently. */
const CONFIRM_PANE = [
  '❯ /model opus',
  '',
  '───────────────────────────────────────────────────────────────',
  '  Switch model?',
  '  Your next response will be slower and use more tokens',
  '',
  '  This conversation is cached for the current model. Switching to Opus 4.8 means the full history gets re-read on your next message.',
  '',
  '  ❯ 1. Yes, switch to Opus 4.8',
  '    2. No, go back',
  '',
  '─────────────────────────────────────────────── voice-dictation-lmassist-web ──',
].join('\n');

describe('findModelSwitchConfirm', () => {
  test('picks the affirmative option on the real confirm dialog', () => {
    assert.equal(findModelSwitchConfirm(parseDialogPrompt(CONFIRM_PANE), 'opus'), 1);
  });

  test('refuses when the dialog offers a DIFFERENT model than we asked for', () => {
    assert.equal(findModelSwitchConfirm(parseDialogPrompt(CONFIRM_PANE), 'haiku'), null);
  });

  test('never answers an unrelated numbered prompt', () => {
    const permission = [
      '  Do you want to proceed?',
      '  ❯ 1. Yes',
      '    2. Yes, and don\'t ask again',
      '    3. No, and tell Claude what to do differently',
    ].join('\n');
    assert.equal(findModelSwitchConfirm(parseDialogPrompt(permission), 'opus'), null);
  });

  test('null when there is no dialog at all', () => {
    assert.equal(findModelSwitchConfirm(parseDialogPrompt('❯ '), 'opus'), null);
    assert.equal(findModelSwitchConfirm(null, 'opus'), null);
  });
});

// ── the safety boundary: the two classes must never cross ───────────────────

describe('class separation (model vs server/network)', () => {
  test('a model limit classifies as model_limit and is NOT auto-resumable', () => {
    assert.equal(classifyScreen(LIMITED_SCREEN).state, 'model_limit');
    assert.equal(SERVER_STALL_STATES.includes('model_limit' as never), false);
    assert.equal(isServerStall(LIMITED_SCREEN).retryable, false, 'must never be sent `continue`');
  });

  test('the banner beats the over-eager busy heuristic', () => {
    // ⏵⏵ / ✻ are present on essentially every bypass-mode session; without the banner
    // this same screen reads as `busy`, which is why detection must be a banner pattern.
    assert.equal(classifyScreen(PROMO_SCREEN).state, 'busy');
  });

  test('server errors never produce a model switch', () => {
    for (const s of ['API Error: 529 Overloaded', 'Unable to connect to API (fetch failed)']) {
      const d = decideModelSwitch({ screen: s, cfg: cfg(), now: 0, cooldownMs: 0 });
      assert.equal(d.action, 'noop');
      assert.equal(d.reason, 'no-model-limit');
    }
  });
});

// ── decideModelSwitch — one case per policy row ─────────────────────────────

describe('decideModelSwitch', () => {
  test('switches a from-model limit onto the fallback', () => {
    const d = decideModelSwitch({ screen: LIMITED_SCREEN, cfg: cfg(), now: 1000, cooldownMs: 600_000 });
    assert.equal(d.action, 'switch');
    assert.equal(d.to, 'opus');
    assert.equal(d.limitedModel, 'fable');
    assert.equal(d.currentModel, 'fable');
  });

  test('noop when disabled', () => {
    const d = decideModelSwitch({ screen: LIMITED_SCREEN, cfg: cfg({ enabled: false }), now: 0, cooldownMs: 0 });
    assert.equal(d.action, 'noop');
    assert.equal(d.reason, 'disabled');
  });

  test('noop when the limited model is not in the `from` list', () => {
    const d = decideModelSwitch({ screen: LIMITED_SCREEN, cfg: cfg({ fromModels: ['haiku'] }), now: 0, cooldownMs: 0 });
    assert.equal(d.action, 'noop');
    assert.match(d.reason, /not-a-from-model/);
  });

  test('noop rather than switching to the model that is itself limited', () => {
    const d = decideModelSwitch({ screen: LIMITED_SCREEN, cfg: cfg({ fallbackModel: 'fable' }), now: 0, cooldownMs: 0 });
    assert.equal(d.action, 'noop');
    assert.equal(d.reason, 'fallback-is-limited');
  });

  test('noop on an unrecognised fallback model', () => {
    const d = decideModelSwitch({ screen: LIMITED_SCREEN, cfg: cfg({ fallbackModel: 'nonesuch' }), now: 0, cooldownMs: 0 });
    assert.equal(d.action, 'noop');
    assert.match(d.reason, /bad-fallback/);
  });

  test('IDEMPOTENT: already on the fallback with the banner still in scrollback', () => {
    const d = decideModelSwitch({ screen: RECOVERED_SCREEN, cfg: cfg(), now: 0, cooldownMs: 0 });
    assert.equal(d.action, 'noop');
    assert.equal(d.reason, 'already-on-fallback');
  });

  test('never switches a session that is not ON the limited model', () => {
    // Caught live: this feature's own dev session had the banner text on screen (in the
    // fixtures it was editing) while running on Opus. Text about a limit is not a limit.
    const onSonnet = LIMITED_SCREEN.replace(
      'sid: 16946066-1a70-4a61-8b67-d346b50cd84a Fable 5',
      'sid: 16946066-1a70-4a61-8b67-d346b50cd84a Sonnet 5',
    );
    const d = decideModelSwitch({ screen: onSonnet, cfg: cfg(), now: 0, cooldownMs: 0 });
    assert.equal(d.action, 'noop');
    assert.match(d.reason, /not-on-limited-model\(sonnet\)/);
  });

  test('noop inside the cooldown, switches again once it lapses', () => {
    const record = { switchedAt: 1_000, attempts: 1, from: 'fable', to: 'opus', verified: false };
    const inside = decideModelSwitch({ screen: LIMITED_SCREEN, cfg: cfg(), record, now: 2_000, cooldownMs: 600_000 });
    assert.equal(inside.action, 'noop');
    assert.equal(inside.reason, 'cooldown');

    const after = decideModelSwitch({ screen: LIMITED_SCREEN, cfg: cfg(), record, now: 1_000 + 600_001, cooldownMs: 600_000 });
    assert.equal(after.action, 'switch');
  });

  test('healthy sessions are never touched', () => {
    const d = decideModelSwitch({ screen: PROMO_SCREEN, cfg: cfg(), now: 0, cooldownMs: 0 });
    assert.equal(d.action, 'noop');
    assert.equal(d.reason, 'no-model-limit');
  });

  test('respects an explicit human decline ("Kept model as …") after the banner', () => {
    // VERBATIM from live cloud CCR cse_01SwWF69Q2S7P47DU8ApFLAH: a human was offered the
    // switch and chose "No, go back". An automated actor must not overrule that.
    const declined = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.\nKept model as Fable 5";
    const d = decideModelSwitch({ screen: declined, cfg: cfg(), now: 0, cooldownMs: 0 });
    assert.equal(d.action, 'noop');
    assert.equal(d.reason, 'user-kept-model');
  });

  test('a FRESH limit after an older decline is still actionable', () => {
    const reLimited = "Kept model as Fable 5\n...later...\nYou've reached your Fable 5 limit. Run /usage-credits to continue.";
    assert.equal(decideModelSwitch({ screen: reLimited, cfg: cfg(), now: 0, cooldownMs: 0 }).action, 'switch');
  });

  test('a remote session with no status line derives its model from the last /model outcome', () => {
    const applied = "You've reached your Fable 5 limit.\nSet model to Opus 4.8";
    const d = decideModelSwitch({ screen: applied, cfg: cfg(), now: 0, cooldownMs: 0 });
    assert.equal(d.currentModel, 'opus');
    assert.equal(d.reason, 'already-on-fallback');
  });

  test('currentModel can be injected when no status line exists (remote CCR)', () => {
    const text = "You've reached your Fable 5 limit. Run /usage-credits to continue.";
    assert.equal(decideModelSwitch({ screen: text, cfg: cfg(), now: 0, cooldownMs: 0, currentModel: null }).action, 'switch');
    assert.equal(decideModelSwitch({ screen: text, cfg: cfg(), now: 0, cooldownMs: 0, currentModel: 'opus' }).reason, 'already-on-fallback');
  });
});
