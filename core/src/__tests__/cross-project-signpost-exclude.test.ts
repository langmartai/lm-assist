import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRecords } from '../memory/record-extract';

test('extractRecords skips the managed _cross-project.md file (no knowledge-record pollution)', () => {
  const recs = extractRecords({
    node: 'n', project: 'p', source: 'live', filename: '_cross-project.md',
    content: '# Cross-Project Memory\n\nbody', mtimeMs: 1, size: 1,
  });
  assert.equal(recs.length, 0);
});

test('a normal memory file still extracts a record (sanity)', () => {
  const recs = extractRecords({
    node: 'n', project: 'p', source: 'live', filename: 'note.md',
    content: '---\nname: note\ndescription: d\ntype: project\n---\nbody', mtimeMs: 1, size: 1,
  });
  assert.equal(recs.length, 1);
});
