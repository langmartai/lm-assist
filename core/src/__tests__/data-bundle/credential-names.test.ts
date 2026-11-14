import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  isCredentialMemoryName, isCredentialRuleName,
} from '../../utils/credential-names';

// The shared list must NOT change which real files each sync path already moved: memory
// matched `key` as a \b word (underscore is a word char), rules as a letters-only token.
test('memory keeps its \\bkey\\b form — underscore-joined names still sync', () => {
  assert.equal(isCredentialMemoryName('feedback_no_prod_key_in_session.md'), false);
  assert.equal(isCredentialMemoryName('api_key.md'), false);
  assert.equal(isCredentialMemoryName('api-key.md'), true);
  assert.equal(isCredentialMemoryName('key.md'), true);
  assert.equal(isCredentialMemoryName('github-token-notes.md'), true);
});

test('rules keep their letters-only boundary', () => {
  assert.equal(isCredentialRuleName('api_key.md'), true);
  assert.equal(isCredentialRuleName('api-key.md'), true);
  assert.equal(isCredentialRuleName('session_cookie.md'), true);
});

test('neither family matches key inside a word', () => {
  for (const n of ['monkey.md', 'keyboard.md', 'turkey-notes.md']) {
    assert.equal(isCredentialMemoryName(n), false, n);
    assert.equal(isCredentialRuleName(n), false, n);
  }
});
