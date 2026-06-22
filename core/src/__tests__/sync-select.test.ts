import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSyncable } from '../memory/sync-select';
import type { MemoryRecord } from '../memory/record-extract';

function rec(p: Partial<MemoryRecord>): MemoryRecord {
  return { recordId: 'n:pr:f#', contentHash: 'h', node: 'n', project: 'pr', source: 'live',
    file: 'f.md', kind: 'memory', anchor: '', title: 't', brief: 'b', complete: 'c',
    type: 'project', category: '', shareability: 'project-domain', persistence: 'persistent',
    recordedAtMs: 1, lastValidatedMs: 1, validity: 'current', validationTier: 'asserted',
    mtimeMs: 1, size: 1, ...p } as MemoryRecord;
}

test('keeps persistent project-domain records', () => {
  assert.equal(selectSyncable([rec({})]).length, 1);
});
test('drops temporary records', () => {
  assert.equal(selectSyncable([rec({ persistence: 'temporary' })]).length, 0);
});
test('drops host-local records', () => {
  assert.equal(selectSyncable([rec({ shareability: 'host-local' })]).length, 0);
});
test('keeps ambiguous shareability', () => {
  assert.equal(selectSyncable([rec({ shareability: 'ambiguous' })]).length, 1);
});
test('sinceMs filters by recordedAtMs', () => {
  assert.equal(selectSyncable([rec({ recordedAtMs: 5 })], 10).length, 0);
  assert.equal(selectSyncable([rec({ recordedAtMs: 20 })], 10).length, 1);
});
