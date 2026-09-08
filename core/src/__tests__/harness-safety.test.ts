import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Safety invariants that must hold BEFORE any non-Claude harness runs.
 *
 * Two of these encode defects found during the multi-harness review:
 *
 *  1. An unrecognised model used to fall through to `this.pricing[0]` — i.e. it was
 *     silently priced at Claude Opus rates ($5/$25 per M). A third-party model would
 *     therefore produce confidently wrong dollar figures with no error and no marker.
 *     Unknown pricing must now be explicit and zero-rated.
 *
 *  2. `runner` was never validated. Only `prompt` was checked, so a typo'd or
 *     not-yet-deployed runner value fell through and launched a REAL Claude agent with
 *     the caller's prompt and cwd. An unknown harness id must be refused loudly.
 */

import { CostCalculator, UNKNOWN_MODEL_PRICING, isUnknownPricing } from '../cost-calculator';
import { isKnownHarness, listHarnessIds, assertKnownHarness } from '../harness/registry';
import type { TokenUsage } from '../types';

test('an unknown model is NOT priced at Opus rates', () => {
  const calc = new CostCalculator();
  const pricing = calc.getPricing('cohere/north-mini-code:free');

  assert.ok(isUnknownPricing(pricing), 'third-party model must resolve to unknown pricing');
  assert.equal(pricing.inputPricePerMillion, 0);
  assert.equal(pricing.outputPricePerMillion, 0);
  assert.notEqual(pricing.displayName, 'Claude Opus 4.6');
});

test('a known Claude model still prices correctly', () => {
  const calc = new CostCalculator();
  const pricing = calc.getPricing('claude-opus-4-6-20260101');
  assert.ok(!isUnknownPricing(pricing), 'a real Claude id must still match');
  assert.ok(pricing.inputPricePerMillion > 0);
});

test('cost estimate flags when pricing was unknown', () => {
  const calc = new CostCalculator();
  const usage: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  const unknown = calc.calculateCost(usage, 'cohere/north-mini-code:free');
  assert.equal(unknown.pricingKnown, false);
  assert.equal(unknown.totalCost, 0, 'an unpriced model must not invent a cost');

  const known = calc.calculateCost(usage, 'claude-opus-4-6');
  assert.equal(known.pricingKnown, true);
  assert.ok(known.totalCost > 0);
});

test('UNKNOWN_MODEL_PRICING is zero across every rate', () => {
  for (const [k, v] of Object.entries(UNKNOWN_MODEL_PRICING)) {
    if (typeof v === 'number') assert.equal(v, 0, `${k} must be 0`);
  }
});

test('the built-in harnesses are known', () => {
  assert.ok(isKnownHarness('sdk'));
  assert.ok(isKnownHarness('tmux'));
  assert.ok(listHarnessIds().includes('sdk'));
});

test('an unknown harness id is refused loudly, echoing what was sent', () => {
  assert.equal(isKnownHarness('tmuxx'), false);
  assert.equal(isKnownHarness(''), false);

  const err = assertKnownHarness('tmuxx');
  assert.ok(err, 'must return an error for an unknown id');
  assert.equal(err!.code, 'UNSUPPORTED_RUNNER');
  assert.match(err!.message, /tmuxx/, 'the rejected value must be echoed back');
  assert.match(err!.message, /sdk/, 'the supported ids must be listed');
});

test('an absent runner is allowed and means the default', () => {
  assert.equal(assertKnownHarness(undefined), null);
});
