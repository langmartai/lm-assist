import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-sweep-'));
process.env.CLAUDE_CONFIG_DIR = TMP;

import { sweepAllProjects, selectEligible, SIGNPOST_FILE } from '../memory/cross-project-signpost';

after(async () => {
  (await import('../memory-cache')).resetMemoryCache();
  (await import('../session-cache')).stopSessionCache();
});

function seed(slug: string, name: string): string {
  const mem = path.join(TMP, 'projects', slug, 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'note.md'), `---\nname: ${name}\ndescription: ${name} stuff\ntype: project\n---\nbody`);
  return mem;
}

test('selectEligible drops excluded paths + non-live projects', () => {
  const got = selectEligible([
    { projectId: '-a', projectPath: '/p/a', hasLive: true, fileCount: 2 },
    { projectId: '-b', projectPath: '/p/b', hasLive: false, fileCount: 0 },
    { projectId: '-c', projectPath: '/p/c', hasLive: true, fileCount: 1 },
  ], ['/p/c']);
  assert.deepEqual(got.map((s) => s.projectId), ['-a']);
});

test('sweep lists OTHER projects in DETERMINISTIC (sorted) order and is idempotent', async () => {
  // Seed in non-sorted creation order; sorted slug order is: -cps-a, -cps-m, -cps-z.
  const zMem = seed('-cps-z', 'zeta');
  seed('-cps-m', 'mu');
  seed('-cps-a', 'alpha');

  const r1 = await sweepAllProjects();
  assert.ok(r1.swept >= 3, `swept ${r1.swept}`);

  const zSign = fs.readFileSync(path.join(zMem, SIGNPOST_FILE), 'utf-8');
  assert.match(zSign, /memory_projects/);              // the static tool guidance
  assert.doesNotMatch(zSign, /\(`-cps-z`\)/);          // Z does not list itself
  // Others appear in sorted order regardless of creation/mtime order.
  const ai = zSign.indexOf('-cps-a');
  const mi = zSign.indexOf('-cps-m');
  assert.ok(ai > 0 && mi > ai, `others must be sorted: a@${ai} m@${mi}`);
  assert.match(fs.readFileSync(path.join(zMem, 'MEMORY.md'), 'utf-8'), new RegExp(`\\(${SIGNPOST_FILE}\\)`));

  // Idempotent: writing the signposts bumped memory-dir mtimes, but the sorted list is stable, so a
  // second sweep changes nothing. (Without the sort this rewrote every file every sweep.)
  const r2 = await sweepAllProjects();
  assert.equal(r2.filesWritten, 0, 'second sweep must write nothing');
});

test('config off → sweep no-ops (kill switch)', async () => {
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-off-'));
  fs.writeFileSync(path.join(dd, 'project-settings.json'), JSON.stringify({ crossProjectSignpostEnabled: false }));
  process.env.LM_ASSIST_DATA_DIR = dd;
  delete require.cache[require.resolve('../project-settings')];
  delete require.cache[require.resolve('../memory/cross-project-signpost')];
  const mod = require('../memory/cross-project-signpost');
  const r = await mod.sweepAllProjects();
  assert.equal(r.disabled, true);
  assert.equal(r.filesWritten, 0);
  delete process.env.LM_ASSIST_DATA_DIR;
});
