import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * memory-api listProjects robustness: a single unreadable / dangling entry under
 * ~/.claude/projects/ must NOT sink the whole `memory_projects` listing. Before
 * the per-entry try/catch, an unguarded fs.statSync on a dangling symlink threw
 * and the entire call returned MEMORY_LIST_PROJECTS_ERROR — so one stray entry
 * made the tool return nothing instead of skipping the bad entry.
 */

// mirror of legacyEncodeProjectPath — keep fixture cwds dash-free so decodePath
// round-trips back to the same cwd.
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
  fn: (run: () => Promise<{ success: boolean; data?: unknown; ids: string[] }>, projectsDir: string) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memlist-'));
  const configDir = path.join(root, 'claude');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  const prevData = process.env.LM_ASSIST_DATA_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  process.env.LM_ASSIST_DATA_DIR = dataDir;

  writeMemory(configDir, '/home/ubuntu/projgood', {
    'note.md': '---\nname: good-note\ndescription: a healthy project\n---\nbody here',
  });
  const projectsDir = path.join(configDir, 'projects');

  const { resetMemoryCache } = await import('../memory-cache');
  resetMemoryCache();
  const { createMemoryApiImpl } = await import('../api/memory-api');

  try {
    await fn(async () => {
      resetMemoryCache();
      const api = createMemoryApiImpl();
      const res = await api.listProjects();
      const ids = (res.success && Array.isArray(res.data))
        ? (res.data as Array<{ projectId: string }>).map((p) => p.projectId)
        : [];
      return { success: res.success, data: res.data, ids };
    }, projectsDir);
  } finally {
    resetMemoryCache();
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    if (prevData === undefined) delete process.env.LM_ASSIST_DATA_DIR;
    else process.env.LM_ASSIST_DATA_DIR = prevData;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('listProjects returns the valid project even with a dangling-symlink entry alongside it', async (t) => {
  await withFixture(async (run, projectsDir) => {
    // A dangling symlink makes fs.statSync throw (ENOENT) — the unguarded path
    // used to abort the whole listing.
    try {
      fs.symlinkSync(path.join(projectsDir, '__does_not_exist__'), path.join(projectsDir, 'dangling-slug'));
    } catch {
      t.skip('symlinks not supported on this platform');
      return;
    }
    const res = await run();
    assert.equal(res.success, true, 'listing must still succeed despite the bad entry');
    assert.ok(res.ids.includes(slugFor('/home/ubuntu/projgood')), 'the valid project must be present');
  });
});

test('listProjects skips a non-memory plain-file entry without erroring', async () => {
  await withFixture(async (run, projectsDir) => {
    fs.writeFileSync(path.join(projectsDir, 'stray-file'), 'not a directory');
    const res = await run();
    assert.equal(res.success, true);
    assert.ok(res.ids.includes(slugFor('/home/ubuntu/projgood')), 'valid project still listed');
  });
});
