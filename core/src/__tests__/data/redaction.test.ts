import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import { isHardExcludedPath, redactRecord, REDACTED } from '../../data/redaction';
import type { DataRecord } from '../../data/types';

test('isHardExcludedPath: blocks credential + secret-bearing paths', () => {
  const home = os.homedir();
  assert.equal(isHardExcludedPath(path.join(home, '.claude', '.credentials.json')), true);
  assert.equal(isHardExcludedPath(path.join(home, '.lm-assist', 'hub.json')), true);
  assert.equal(isHardExcludedPath(path.join(home, '.lm-assist', 'hub-dev.json')), true);
  assert.equal(isHardExcludedPath(path.join(home, '.claude', 'claudeai-session.json')), true);
  assert.equal(isHardExcludedPath(path.join(home, 'project', '.env')), true);
  assert.equal(isHardExcludedPath(path.join(home, '.lm-assist', 'api-token')), true);
});

test('isHardExcludedPath: allows ordinary paths', () => {
  const home = os.homedir();
  assert.equal(isHardExcludedPath(path.join(home, 'notes', 'todo.md')), false);
  assert.equal(isHardExcludedPath(path.join(home, '.lm-assist', 'data', 'cache', 'x.lmdb')), false);
});

test('redactRecord: scrubs secret-named fields recursively, leaves others', () => {
  const rec: DataRecord = {
    id: 'r1',
    version: 1,
    fields: {
      name: 'ok',
      apiKey: 'sk-123',
      nested: { password: 'p', authorization: 'Bearer z', keep: 'visible' },
      list: [{ token: 't1' }, { plain: 'p1' }],
    },
    metadata: { cookie: 'c=1', note: 'fine' },
    createdAt: 't', updatedAt: 't',
  };
  const out = redactRecord(rec);
  assert.equal(out.fields.name, 'ok');
  assert.equal(out.fields.apiKey, REDACTED);
  assert.equal((out.fields.nested as any).password, REDACTED);
  assert.equal((out.fields.nested as any).authorization, REDACTED);
  assert.equal((out.fields.nested as any).keep, 'visible');
  assert.equal((out.fields.list as any)[0].token, REDACTED);
  assert.equal((out.fields.list as any)[1].plain, 'p1');
  assert.equal((out.metadata as any).cookie, REDACTED);
  assert.equal((out.metadata as any).note, 'fine');
  // input is not mutated
  assert.equal(rec.fields.apiKey, 'sk-123');
});
