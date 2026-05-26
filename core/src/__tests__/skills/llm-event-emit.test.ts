import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

test('llm-event-emit SKILL.md exists and has valid frontmatter', () => {
  const skillPath = path.resolve(__dirname, '..', '..', '..', '..', 'skills', 'llm-event-emit', 'SKILL.md');
  assert.ok(fs.existsSync(skillPath), `SKILL.md not found at ${skillPath}`);

  const content = fs.readFileSync(skillPath, 'utf8');

  // Frontmatter block must open with ---
  assert.match(content, /^---\n/, 'frontmatter must start with ---');

  // name field
  assert.match(content, /\nname:\s+llm-event-emit\n/, 'name must be llm-event-emit');

  // description field (non-empty, mentions event)
  assert.match(content, /\ndescription:.*event/i, 'description must mention event');

  // allowed-tools field
  assert.match(content, /\nallowed-tools:\s+Bash\n/, 'allowed-tools must be Bash');

  // CLI invocation present in body
  assert.match(content, /ler event llm-emit/, 'body must contain ler event llm-emit CLI invocation');

  // --type flag documented
  assert.match(content, /--type/, 'body must document --type flag');

  // --source-id flag documented
  assert.match(content, /--source-id/, 'body must document --source-id flag');

  // --props flag documented
  assert.match(content, /--props/, 'body must document --props flag');

  // was_duplicate field documented (key dedup concept)
  assert.match(content, /was_duplicate/, 'body must document was_duplicate dedup behaviour');
});

test('llm-event-emit SKILL.md frontmatter is well-formed YAML block', () => {
  const skillPath = path.resolve(__dirname, '..', '..', '..', '..', 'skills', 'llm-event-emit', 'SKILL.md');
  const content = fs.readFileSync(skillPath, 'utf8');

  // Extract frontmatter block
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fmMatch, 'frontmatter block must be delimited by --- lines');

  const fm = fmMatch[1];

  // All three required keys present
  assert.ok(fm.includes('name:'), 'frontmatter must have name key');
  assert.ok(fm.includes('description:'), 'frontmatter must have description key');
  assert.ok(fm.includes('allowed-tools:'), 'frontmatter must have allowed-tools key');
});
