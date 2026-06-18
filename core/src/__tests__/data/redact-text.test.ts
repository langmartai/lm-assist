import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, scrubRecordContent, REDACTED } from '../../data/redaction';
import type { DataRecord } from '../../data/types';

test('redactText: redacts standalone secret-shaped tokens', () => {
  assert.match(redactText('key is sk-abcdefABCDEF0123456789 ok'), /«redacted»/);
  assert.match(redactText('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), /«redacted»/);
  assert.ok(!redactText('the quick brown fox jumps').includes(REDACTED)); // ordinary prose untouched
});

test('redactText: redacts secret-named key=value / key: value', () => {
  assert.match(redactText('Authorization: Bearer xyz123abc'), /Authorization.*«redacted»/i);
  assert.match(redactText('password=hunter2'), /password.*«redacted»/i);
  assert.match(redactText('api_key="AKIA1234567890"'), /api_key.*«redacted»/i);
  // the value is gone:
  assert.ok(!redactText('password=hunter2').includes('hunter2'));
});

test('scrubRecordContent: scrubs text + string field values + secret-named fields', () => {
  const rec: DataRecord = {
    id: 'r', version: 1,
    fields: { note: 'token=abc123secret', apiKey: 'sk-zzz', count: 5, nested: { password: 'p', label: 'ok' } },
    text: 'login with password=swordfish please',
    createdAt: 't', updatedAt: 't',
  };
  const out = scrubRecordContent(rec);
  assert.ok(!out.text!.includes('swordfish'));
  assert.equal(out.fields.apiKey, REDACTED);              // secret-named field
  assert.ok(!String(out.fields.note).includes('abc123secret')); // inline secret in a non-secret field
  assert.equal(out.fields.count, 5);                       // non-string untouched
  assert.equal((out.fields.nested as any).password, REDACTED); // nested secret-named
  assert.equal((out.fields.nested as any).label, 'ok');
});
