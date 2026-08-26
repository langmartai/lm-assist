// core/src/__tests__/data/sql-generated-columns.test.ts
// Regression: a sql dataset declaring indexedFields must survive a REOPEN.
//
// The schema migration guarded its ALTERs with `PRAGMA table_info`, which omits
// generated columns entirely — so a reopened dataset looked like it had none and the
// ALTERs were re-issued, throwing "duplicate column name". The dataset worked when
// created and was permanently unopenable from the next process onward (i.e. after the
// first Core restart). Found while adding the prompt index, which reopens by design.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sqlgen-'));

import { SqlBackend } from '../../data/backends/sql-backend';
import type { DataRecord } from '../../data/types';

const DESC = (id: string) => ({
  id, backend: 'sql' as const, ownerNode: 'test',
  config: { kind: 'sql' as const, indexedFields: [{ path: 'sessionId', type: 'text' as const }, { path: 'turnIndex', type: 'number' as const }] },
});

test('a dataset with indexedFields reopens in a new backend instance', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlgen-'));
  const rec: DataRecord = { id: 'r1', version: 1, fields: { sessionId: 's1', turnIndex: 3 }, text: 'alpha bravo', createdAt: '', updatedAt: '' };

  const first = new SqlBackend(dir);
  await first.createDataset(DESC('ds') as any);
  await first.put('ds', rec);

  // A second instance = a second worker + a fresh handle: exactly what a restart does.
  const second = new SqlBackend(dir);
  await second.createDataset(DESC('ds') as any);   // must not throw "duplicate column name"
  const got = await second.get('ds', 'r1');
  assert.equal(got?.id, 'r1');
});
