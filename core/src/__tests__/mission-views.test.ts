import { test } from 'node:test';
import assert from 'node:assert';
import { newView, normalizeView, validateView, type MissionView } from '../mission/mission-views';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };

test('newView seeds defaults + provenance', () => {
  const v = newView({ name: 'Active by project', query: { filter: [{ field: 'status', op: 'eq', value: 'active' }] }, display: { groupBy: 'project', layout: 'dag' }, createdBy: actor }, 1000, () => 'view_x');
  assert.equal(v.id, 'view_x');
  assert.equal(v.name, 'Active by project');
  assert.equal(v.display.layout, 'dag');
  assert.equal(v.createdBy.kind, 'user');
  assert.equal(v.createdAt, 1000);
});

test('normalizeView trims name + drops an invalid layout', () => {
  const v = normalizeView({ id: 'view_y', name: '  v  ', query: {}, display: { layout: 'bogus' as never, groupBy: 'project' }, createdBy: actor, lastUpdatedBy: actor, createdAt: 1, updatedAt: 1 } as MissionView);
  assert.equal(v.name, 'v');
  assert.equal(v.display.layout, undefined);
  assert.equal(v.display.groupBy, 'project');
});

test('validateView rejects empty name + bad direction', () => {
  assert.equal(validateView({ name: '' } as unknown as MissionView).ok, false);
  assert.equal(validateView({ name: 'ok', query: { expand: { direction: 'sideways' as never } } } as unknown as MissionView).ok, false);
  assert.equal(validateView({ name: 'ok', query: { expand: { direction: 'all' } }, display: {} } as unknown as MissionView).ok, true);
});
