import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * memory_file read-path: project_id resolution.
 *
 * THE BUG (2026-07-26, mission_9efbbefb / bl_4140a6fc): memory_file read as
 * "intermittently fails with a bare MCP tool call failed", and the reported
 * suspicion was a payload-size threshold or a hub relay-timeout cutoff on the
 * larger full-file body. It was neither. Measured on the failing calls:
 * durationMs 0-10 and a 35-byte body — an INSTANT validation refusal:
 *
 *   Error: Project not found: lm-assist
 *
 * resolveProjectIdToCwd accepted only an encoded slug ("-home-ubuntu-lm-assist")
 * or a string decodePath could turn into an existing path. A caller — a human
 * speaking, or a model reasoning about "the lm-assist project" — naturally says
 * the project's NAME. That has no leading dash, so it is not legacy-slug shaped,
 * falls through to base64, decodes to garbage, and resolves to null.
 *
 * It looked intermittent only because the outcome is deterministic PER INPUT and
 * the caller sometimes used the slug and sometimes the name. search_memory never
 * failed because its `project` arg is an optional absolute path that defaults to
 * sweeping every project — it never asks the caller to name a slug at all.
 *
 * Same class as the backlog write-path fix: a validation refusal misread as a
 * transport fault. So, mirroring it: coerce caller-plausible ids, and refuse the
 * rest LOUDLY — echo what was sent and name the candidates, so the caller learns
 * whether a different id would help instead of retrying the same one forever.
 */

// mirror of legacyEncodeProjectPath
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

type Api = Awaited<ReturnType<typeof loadApi>>;

async function loadApi() {
  const { resetMemoryCache } = await import('../memory-cache');
  resetMemoryCache();
  const { createMemoryApiImpl } = await import('../api/memory-api');
  return createMemoryApiImpl();
}

/**
 * `projects` maps an absolute cwd -> its memory files. Every fixture project is
 * created on the real filesystem too, because decodePath disambiguates legacy
 * slugs by filesystem verification.
 */
async function withProjects(
  projects: Record<string, Record<string, string>>,
  fn: (api: Api, root: string) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memresolve-'));
  const configDir = path.join(root, 'claude');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  const prevData = process.env.LM_ASSIST_DATA_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  process.env.LM_ASSIST_DATA_DIR = dataDir;

  try {
    for (const [cwd, files] of Object.entries(projects)) {
      const realCwd = path.join(root, cwd.replace(/^\//, ''));
      fs.mkdirSync(realCwd, { recursive: true });
      writeMemory(configDir, realCwd, files);
    }
    await fn(await loadApi(), root);
  } finally {
    const { resetMemoryCache } = await import('../memory-cache');
    resetMemoryCache();
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    if (prevData === undefined) delete process.env.LM_ASSIST_DATA_DIR;
    else process.env.LM_ASSIST_DATA_DIR = prevData;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const NOTE = '---\nname: n\ndescription: d\n---\nbody';

test('memory_file resolves a project by its FRIENDLY NAME, not just the encoded slug', async () => {
  await withProjects({ '/work/lm-assist': { 'MEMORY.md': NOTE } }, async (api) => {
    // This is the exact call shape that failed in production.
    const res = await api.getFile('lm-assist', 'live', 'MEMORY.md');
    assert.equal(res.success, true, `friendly name must resolve; got ${JSON.stringify(res.error)}`);
    assert.equal(res.data?.body, NOTE);
  });
});

test('the encoded slug and the absolute path keep working (no regression)', async () => {
  await withProjects({ '/work/lm-assist': { 'MEMORY.md': NOTE } }, async (api, root) => {
    const cwd = path.join(root, 'work/lm-assist');

    const bySlug = await api.getFile(slugFor(cwd), 'live', 'MEMORY.md');
    assert.equal(bySlug.success, true, 'encoded slug must still resolve');

    const byPath = await api.getFile(cwd, 'live', 'MEMORY.md');
    assert.equal(byPath.success, true, 'absolute path must still resolve');
  });
});

test('an ambiguous friendly name is refused LOUDLY, naming the candidates', async () => {
  await withProjects(
    {
      '/work/alpha/core': { 'MEMORY.md': NOTE },
      '/work/beta/core': { 'MEMORY.md': NOTE },
    },
    async (api) => {
      const res = await api.getFile('core', 'live', 'MEMORY.md');
      assert.equal(res.success, false, 'two projects named "core" must not silently pick one');
      assert.equal(res.error?.code, 'PROJECT_AMBIGUOUS');
      // The caller must learn WHICH ids to choose between.
      assert.match(res.error?.message || '', /alpha/);
      assert.match(res.error?.message || '', /beta/);
    },
  );
});

test('an unknown project echoes what was sent and names real candidates', async () => {
  await withProjects({ '/work/lm-assist': { 'MEMORY.md': NOTE } }, async (api) => {
    const res = await api.getFile('nope-not-real', 'live', 'MEMORY.md');
    assert.equal(res.success, false);
    assert.equal(res.error?.code, 'PROJECT_NOT_FOUND');
    const msg = res.error?.message || '';
    // Echoing the input is what stops a caller retrying the same value forever.
    assert.match(msg, /nope-not-real/, 'must echo the id that was sent');
    assert.match(msg, /lm-assist/, 'must name a real candidate to try instead');
  });
});

test('a large memory file round-trips intact through the read path', async () => {
  // The reported suspicion was a size cutoff on the full-file body. Prove the
  // read path carries a body well past the real MEMORY.md (~20KB) byte-exact.
  const big = `---\nname: big\ndescription: large\n---\n${'x'.repeat(200_000)}`;
  await withProjects({ '/work/lm-assist': { 'BIG.md': big } }, async (api) => {
    const res = await api.getFile('lm-assist', 'live', 'BIG.md');
    assert.equal(res.success, true, `large read must succeed; got ${JSON.stringify(res.error)}`);
    assert.equal(res.data?.body.length, big.length, 'body must not be truncated');
    assert.equal(res.data?.body, big, 'body must be byte-identical');
  });
});
