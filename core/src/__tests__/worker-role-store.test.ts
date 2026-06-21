import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wrkstore-'));
process.env.LM_ASSIST_DATA_DIR = TMP;

import { putRecord, getRecord, listRecords, stampOrchestrator, deleteRecord } from '../worker-role/worker-store';
import type { WorkerRecord } from '../worker-role/types';

const rec: WorkerRecord = { sessionId: 's1', role: 'worker', tasks: [{ id: 't1', title: 'x', status: 'working' }], orchestrator: {}, updatedAt: 1 };

test('store: put then get round-trips a record', () => {
  putRecord(rec);
  assert.deepEqual(getRecord('s1'), rec);
  assert.equal(getRecord('nope'), null);
});

test('store: list returns all records', () => {
  putRecord({ ...rec, sessionId: 's2' });
  const ids = listRecords().map((r) => r.sessionId).sort();
  assert.deepEqual(ids, ['s1', 's2']);
});

test('store: stampOrchestrator sets id + lastContact', () => {
  const updated = stampOrchestrator('s1', 'orch-7', 9999);
  assert.equal(updated?.orchestrator.id, 'orch-7');
  assert.equal(updated?.orchestrator.lastContact, 9999);
  assert.equal(getRecord('s1')?.orchestrator.lastContact, 9999);
});

test('store: deleteRecord removes a record', () => {
  putRecord({ ...rec, sessionId: 's3' });
  assert.deepEqual(getRecord('s3'), { ...rec, sessionId: 's3' });
  deleteRecord('s3');
  assert.equal(getRecord('s3'), null);
  assert.ok(!listRecords().some((r) => r.sessionId === 's3'));
});

test('cleanup test data dir', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  assert.ok(true);
});
