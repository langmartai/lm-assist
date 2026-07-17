import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authRecoveryAction } from '../utils/claude-oauth';

test('401 recovery: file token changed since our read → use it, never rotate', () => {
  assert.equal(authRecoveryAction('tok-NEW', 'tok-old', 1000, 0), 'use-file-token');
});

test('401 recovery: our token is still on disk and cooldown passed → refresh once', () => {
  assert.equal(authRecoveryAction('tok-same', 'tok-same', 60_001, 0), 'refresh');
});

test('401 recovery: within the force-refresh cooldown → give up (no family churn)', () => {
  assert.equal(authRecoveryAction('tok-same', 'tok-same', 20_000, 1_000), 'give-up');
  // a recent attempt blocks even if the tokens match exactly at the boundary
  assert.equal(authRecoveryAction('tok-same', 'tok-same', 30_999, 1_000), 'give-up');
  assert.equal(authRecoveryAction('tok-same', 'tok-same', 31_000, 1_000), 'refresh');
});

test('401 recovery: no credentials file → give up', () => {
  assert.equal(authRecoveryAction(null, 'tok-x', 1000, 0), 'give-up');
});
