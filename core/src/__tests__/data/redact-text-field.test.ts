import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactRecord, REDACTED } from '../../data/redaction';
import type { DataRecord } from '../../data/types';

test('redactRecord scrubs inline secrets in the top-level text body (C1)', () => {
  const rec: DataRecord = {
    id: 'r', version: 1,
    fields: { title: 'ok', apiKey: 'sk-zzz' },
    text: 'deploy log: authorization=Bearer sk-abcdEFGH1234567890 then ok',
    createdAt: 't', updatedAt: 't',
  };
  const out = redactRecord(rec);
  assert.equal(out.fields.apiKey, REDACTED);                  // existing field-name redaction unchanged
  assert.ok(!String(out.text).includes('sk-abcdEFGH1234567890')); // the inline token in text is GONE
  assert.ok(String(out.text).includes(REDACTED));
});

test('redactRecord leaves ordinary text untouched', () => {
  const rec: DataRecord = { id: 'r', version: 1, fields: {}, text: 'the quick brown fox', createdAt: 't', updatedAt: 't' };
  assert.equal(redactRecord(rec).text, 'the quick brown fox');
});
