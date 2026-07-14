import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterMachines, machineAccessToolDef } from '../mcp-server/tools/machine-access';

const MACHINES = [
  { id: 'sg-hub', tags: ['oracle', 'hub'] },
  { id: 'node-b', tags: ['lan'] },
  { id: 'win107', tags: ['lan', 'windows'] },
];

describe('filterMachines', () => {
  it('no filters → all', () => {
    assert.equal(filterMachines(MACHINES, {}).length, 3);
  });
  it('by id', () => {
    assert.deepEqual(filterMachines(MACHINES, { id: 'node-b' }).map((m) => m.id), ['node-b']);
  });
  it('by tag', () => {
    assert.deepEqual(filterMachines(MACHINES, { tag: 'lan' }).map((m) => m.id), ['node-b', 'win107']);
  });
  it('id + tag compose', () => {
    assert.equal(filterMachines(MACHINES, { id: 'win107', tag: 'hub' }).length, 0);
  });
  it('missing tags array tolerated', () => {
    assert.equal(filterMachines([{ id: 'x' }], { tag: 'lan' }).length, 0);
  });
});

describe('machineAccessToolDef', () => {
  it('is read-only with optional id/tag args', () => {
    assert.equal(machineAccessToolDef.name, 'machine_access');
    assert.equal(machineAccessToolDef.annotations.readOnlyHint, true);
    assert.deepEqual(Object.keys(machineAccessToolDef.inputSchema.properties).sort(), ['id', 'tag']);
    assert.equal((machineAccessToolDef.inputSchema as { required?: string[] }).required, undefined);
  });
});
