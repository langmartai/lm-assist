import { test } from 'node:test';
import assert from 'node:assert';
import { decideOnboardingKeys } from '../terminal/onboarding-prompts';
test('dismisses the fullscreen renderer prompt with "2"', () => {
  const s = 'Try the new fullscreen renderer?\n  1. Yes, try it\n  2. Not now\n  Enter to confirm';
  assert.deepStrictEqual(decideOnboardingKeys(s), { keys: '2', enter: true });
});
test('returns null for a normal idle screen', () => {
  assert.strictEqual(decideOnboardingKeys('some normal repl  ctx:0%  /rc active'), null);
});
