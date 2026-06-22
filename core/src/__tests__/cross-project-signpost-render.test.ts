import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSignpost } from '../memory/cross-project-signpost';

test('renders the static tool list + each other project, excludes self', () => {
  const md = renderSignpost({ slug: '-a', name: 'alpha' }, [
    { slug: '-b', name: 'beta', hook: 'trading engine' },
    { slug: '-c', name: 'gamma' },
  ]);
  for (const tool of ['memory_projects', 'search_memory', 'memory_map', 'memory_cross_host']) {
    assert.match(md, new RegExp(tool), `missing tool ${tool}`);
  }
  assert.match(md, /\*\*beta\*\* \(`-b`\) — trading engine/);
  assert.match(md, /\*\*gamma\*\* \(`-c`\)/);
  assert.doesNotMatch(md, /`-a`/);            // self is not listed
  assert.match(md, /managed by lm-assist/);   // managed header
  assert.match(md, /cross-project v\d+/);     // version marker
});

test('renders an empty-others placeholder', () => {
  assert.match(renderSignpost({ slug: '-a', name: 'alpha' }, []), /no other projects/i);
});
