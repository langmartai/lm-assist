import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * search_memory regression: with no `project` argument the tool must search
 * across ALL projects' memory, not the lm-assist server's process.cwd() (which
 * is the npm install dir and has no memory/ — so the old default always returned
 * "no results" even when memory_map showed hundreds of records).
 */

// mirror of legacyEncodeProjectPath — keep fixture cwds dash-free so decodePath
// round-trips back to the same cwd without filesystem ambiguity.
function slugFor(cwd: string): string {
  return cwd.replace(/[:\\/]/g, '-');
}

function writeMemory(configDir: string, cwd: string, files: Record<string, string>): void {
  const dir = path.join(configDir, 'projects', slugFor(cwd), 'memory');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
}

async function withFixture(
  fn: (run: (args: Record<string, unknown>) => Promise<string>) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'searchmem-'));
  const configDir = path.join(root, 'claude');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  const prevData = process.env.LM_ASSIST_DATA_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  process.env.LM_ASSIST_DATA_DIR = dataDir;

  writeMemory(configDir, '/home/ubuntu/projalpha', {
    'note-one.md':
      '---\nname: alpha-note\ndescription: about zebras\n---\nThe zebra crossing pattern is here.',
  });
  writeMemory(configDir, '/home/ubuntu/projbeta', {
    'note-two.md':
      '---\nname: beta-note\ndescription: nothing relevant\n---\nA zebra also appears in beta.',
  });
  writeMemory(configDir, '/home/ubuntu/projgamma', {
    'note-three.md':
      '---\nname: gamma-note\ndescription: unrelated topic\n---\nNo matching animals here at all.',
  });

  const { resetMemoryCache } = await import('../memory-cache');
  resetMemoryCache();
  const { handleSearchMemory } = await import('../mcp-server/tools/search-memory');

  try {
    await fn(async (args) => {
      const res = await handleSearchMemory(args);
      return res.content.map((c) => c.text).join('\n');
    });
  } finally {
    resetMemoryCache();
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    if (prevData === undefined) delete process.env.LM_ASSIST_DATA_DIR;
    else process.env.LM_ASSIST_DATA_DIR = prevData;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('no project arg → searches across ALL projects and tags each hit with its project', async () => {
  await withFixture(async (run) => {
    const text = await run({ query: 'zebra' });
    assert.match(text, /projalpha/, 'hit from projalpha should appear');
    assert.match(text, /projbeta/, 'hit from projbeta should appear');
    assert.doesNotMatch(text, /No memory files match/, 'must not report no results');
  });
});

test('no project arg → non-matching projects are excluded', async () => {
  await withFixture(async (run) => {
    const text = await run({ query: 'zebra' });
    assert.doesNotMatch(text, /gamma-note/, 'projgamma has no zebra match — must not appear');
  });
});

test('explicit project arg still scopes to that one project', async () => {
  await withFixture(async (run) => {
    const text = await run({ query: 'zebra', project: '/home/ubuntu/projalpha' });
    assert.match(text, /alpha-note/, 'alpha match present');
    assert.doesNotMatch(text, /beta-note/, 'beta match must be excluded when scoped to alpha');
  });
});
