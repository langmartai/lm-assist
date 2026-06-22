import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRecords } from '../memory/record-extract';

const base = { node: 'n1', project: 'p1', source: 'live', mtimeMs: 1, size: 10 };

test('persistence defaults to "persistent" when frontmatter omits it', () => {
  const recs = extractRecords({ ...base, filename: 'foo.md',
    content: '---\nname: foo\ndescription: a project fact\ntype: project\n---\nbody' });
  assert.equal(recs[0].persistence, 'persistent');
});

test('persistence reads "temporary" from frontmatter', () => {
  const recs = extractRecords({ ...base, filename: 'scratch.md',
    content: '---\nname: scratch\ndescription: d\ntype: project\npersistence: temporary\n---\nbody' });
  assert.equal(recs[0].persistence, 'temporary');
});

test('unknown persistence value falls back to persistent', () => {
  const recs = extractRecords({ ...base, filename: 'x.md',
    content: '---\nname: x\ndescription: d\ntype: project\npersistence: bogus\n---\nbody' });
  assert.equal(recs[0].persistence, 'persistent');
});

test('claude-section and index-entry records are always persistent', () => {
  const claude = extractRecords({ ...base, filename: 'CLAUDE.md', content: '# Title\n\nsome content here' });
  assert.ok(claude.length > 0);
  assert.equal(claude[0].persistence, 'persistent');
  const index = extractRecords({ ...base, filename: 'MEMORY.md', content: '- [Title](foo.md) — a hook' });
  assert.ok(index.length > 0);
  assert.equal(index[0].persistence, 'persistent');
});
