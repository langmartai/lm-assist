import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPushBack } from '../memory/autosync';
import type { MemoryRecord } from '../memory/record-extract';

function rec(p: Partial<MemoryRecord>): MemoryRecord {
  return { recordId: 'i', contentHash: 'h', node: 'n', project: 'pr', source: 'live', file: 'f.md',
    kind: 'memory', anchor: '', title: 't', brief: 'b', complete: 'c', type: 'project', category: '',
    shareability: 'project-domain', persistence: 'persistent', recordedAtMs: 9, lastValidatedMs: 9,
    validity: 'current', validationTier: 'asserted', mtimeMs: 9, size: 1, ...p } as MemoryRecord;
}

test('ephemeral node pushes persistent+shareable records to the home node', () => {
  const plan = planPushBack({ nodeMode: 'ephemeral', homeNode: 'gw4-home', project: 'pr', homeProject: 'pr' },
    [rec({}), rec({ persistence: 'temporary' }), rec({ shareability: 'host-local' })]);
  assert.equal(plan.action, 'push');
  assert.equal(plan.homeNode, 'gw4-home');
  assert.equal(plan.records.length, 1); // only the persistent project-domain one
});

test('persistent node does not push back (it IS the home / canonical store)', () => {
  const plan = planPushBack({ nodeMode: 'persistent', homeNode: null, project: 'pr', homeProject: 'pr' }, [rec({})]);
  assert.equal(plan.action, 'none');
});

test('ephemeral node with no homeNode -> none', () => {
  const plan = planPushBack({ nodeMode: 'ephemeral', homeNode: null, project: 'pr', homeProject: 'pr' }, [rec({})]);
  assert.equal(plan.action, 'none');
});

test('ephemeral node with only non-syncable changes -> none (but keeps homeNode)', () => {
  const plan = planPushBack({ nodeMode: 'ephemeral', homeNode: 'gw4-home', project: 'pr', homeProject: 'pr' },
    [rec({ persistence: 'temporary' })]);
  assert.equal(plan.action, 'none');
  assert.equal(plan.homeNode, 'gw4-home');
});
