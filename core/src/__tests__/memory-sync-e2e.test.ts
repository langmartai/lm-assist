import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ParsedRequest } from '../routes/index';

// getByProject -> resolveProjectIdToCwd -> getProjectsService -> getSessionCache opens an LMDB +
// chokidar watcher; close both caches at the end so the test process exits cleanly (no hang).
after(async () => {
  (await import('../memory-cache')).resetMemoryCache();
  (await import('../session-cache')).stopSessionCache();
});

/**
 * Cross-node + cross-project integration tests for direct-MCP memory sync.
 *
 * These drive the real /memory/export + /memory/ingest handlers in-process (the hub relay is the
 * only un-simulated layer) and then read the result back through the STANDARD read API
 * (memory-api.getByProject / listProjects) — proving synced memory is actually visible to the MCP
 * tools, not merely written to disk. (A file-exists check alone missed the C1 location bug.)
 *
 * Cross-node   = memory curated on one node's LIVE dir is exported, ingested into a peer's per-host
 *                mirror, and is then readable on the peer.
 * Cross-project = a node can access ANOTHER project's memory when needed (export project B → ingest
 *                into project A's view; query any project independently; projects stay isolated).
 */

// Mirror of legacyEncodeProjectPath; keep fixture cwds lowercase + dash-free so decodePath round-trips.
function slugFor(cwd: string): string { return cwd.replace(/[:\\/]/g, '-'); }

function localReq(body: unknown): ParsedRequest {
  return { method: 'POST', path: '/', params: {}, query: {}, body, headers: {}, clientIp: '127.0.0.1' } as ParsedRequest;
}

let seq = 0;

interface Fleet {
  makeProject: (name: string, liveFiles?: Record<string, string>) => { slug: string; cwd: string };
  exportMem: (project: string) => Promise<any>;
  ingestMem: (project: string, sourceHost: string, records: unknown[]) => Promise<any>;
  api: () => any; // fresh memory-api over the current on-disk state
}

async function withFleet(fn: (f: Fleet) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msync-e2e-'));
  const configDir = path.join(root, 'claude');
  fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;

  const repoCwds: string[] = [];
  function makeProject(name: string, liveFiles: Record<string, string> = {}) {
    // lowercase, dash-free repo cwd → unambiguous decodePath round-trip
    const cwd = path.join(os.tmpdir(), `msynce2e${name}${process.pid}x${seq++}`);
    fs.mkdirSync(cwd, { recursive: true });
    repoCwds.push(cwd);
    const slug = slugFor(cwd);
    const liveMem = path.join(configDir, 'projects', slug, 'memory'); // registration + this node's own live memory
    fs.mkdirSync(liveMem, { recursive: true });
    for (const [f, body] of Object.entries(liveFiles)) fs.writeFileSync(path.join(liveMem, f), body);
    return { slug, cwd };
  }

  const { resetMemoryCache } = await import('../memory-cache');
  resetMemoryCache();
  const { createMemorySyncRoutes } = await import('../routes/core/memory-sync.routes');
  const { createMemoryApiImpl } = await import('../api/memory-api');
  const routes = createMemorySyncRoutes({} as any);
  const exportR = routes.find((r) => r.method === 'POST' && /export/.test(r.pattern.source))!;
  const ingestR = routes.find((r) => r.method === 'POST' && /ingest/.test(r.pattern.source))!;

  const fleet: Fleet = {
    makeProject,
    exportMem: (project) => exportR.handler(localReq({ project }), {} as any),
    ingestMem: (project, sourceHost, records) => ingestR.handler(localReq({ project, sourceHost, records }), {} as any),
    api: () => { resetMemoryCache(); return createMemoryApiImpl(); },
  };

  try {
    await fn(fleet);
  } finally {
    resetMemoryCache();
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    fs.rmSync(root, { recursive: true, force: true });
    for (const c of repoCwds) { try { fs.rmSync(c, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

function fileNames(listing: any, source?: string): string[] {
  return (listing?.data?.files || [])
    .filter((f: any) => (source ? f.source === source : true))
    .map((f: any) => f.filename);
}

test('CROSS-NODE: exported memory is ingested into a peer mirror and READABLE via getByProject', async () => {
  await withFleet(async (f) => {
    const P = f.makeProject('p', {
      'project_fact.md': '---\nname: fact\ndescription: a portable project fact\ntype: project\n---\nthe shared knowledge',
    });

    const exp = await f.exportMem(P.slug);
    assert.equal(exp.success, true);
    assert.equal(exp.data.records.length, 1);
    assert.equal(exp.data.records[0].file, 'project_fact.md');

    const ing = await f.ingestMem(P.slug, 'nodeS', exp.data.records);
    assert.equal(ing.success, true);
    assert.equal(ing.data.ingested, 1);

    // Read back through the standard API — `repo` source isolates the synced mirror from the live copy.
    const got = await f.api().getByProject(P.slug, { sources: 'repo', detail: 'full' });
    assert.equal(got.success, true);
    assert.ok(got.data.hosts.includes('nodeS'), 'the peer host mirror must be discovered');
    assert.ok(fileNames(got, 'repo:nodeS').includes('project_fact.md'),
      'synced memory must be readable via getByProject, not just present on disk');
  });
});

test('CROSS-NODE: re-ingesting unchanged records is idempotent (hash dedup)', async () => {
  await withFleet(async (f) => {
    const P = f.makeProject('q', {
      'project_note.md': '---\nname: note\ndescription: d\ntype: project\n---\nbody',
    });
    const exp = await f.exportMem(P.slug);
    assert.equal((await f.ingestMem(P.slug, 'nodeS', exp.data.records)).data.ingested, 1);
    assert.equal((await f.ingestMem(P.slug, 'nodeS', exp.data.records)).data.ingested, 0); // unchanged → skipped
  });
});

test('CROSS-PROJECT: two synced projects are each accessible and stay isolated', async () => {
  await withFleet(async (f) => {
    const A = f.makeProject('a', { 'project_a_fact.md': '---\nname: a\ndescription: alpha knowledge\ntype: project\n---\nalpha' });
    const B = f.makeProject('b', { 'project_b_fact.md': '---\nname: b\ndescription: beta knowledge\ntype: project\n---\nbeta' });

    for (const P of [A, B]) {
      const exp = await f.exportMem(P.slug);
      await f.ingestMem(P.slug, 'nodeS', exp.data.records);
    }

    const api = f.api();
    const gotA = await api.getByProject(A.slug, { sources: 'repo', detail: 'full' });
    const gotB = await api.getByProject(B.slug, { sources: 'repo', detail: 'full' });

    assert.ok(fileNames(gotA).includes('project_a_fact.md'), 'project A memory accessible');
    assert.ok(fileNames(gotB).includes('project_b_fact.md'), 'project B memory accessible');
    assert.ok(!fileNames(gotA).includes('project_b_fact.md'), 'A must not see B');
    assert.ok(!fileNames(gotB).includes('project_a_fact.md'), 'B must not see A');

    // Cross-project discovery: both projects are listed.
    const list = await api.listProjects();
    const ids = (list.data || []).map((p: any) => p.projectId);
    assert.ok(ids.includes(A.slug) && ids.includes(B.slug), 'both projects discoverable via listProjects');
  });
});

test('CROSS-PROJECT: project A can access project B memory when needed (export B → ingest into A)', async () => {
  await withFleet(async (f) => {
    const A = f.makeProject('a', {}); // A starts with no curated memory of its own
    const B = f.makeProject('b', {
      'project_shared.md': '---\nname: shared\ndescription: knowledge B has that A needs\ntype: project\n---\nreusable insight',
    });

    // While working on A, pull in B's memory and file it under a clearly-attributed mirror.
    const expB = await f.exportMem(B.slug);
    assert.equal(expB.data.records.length, 1);
    const ingA = await f.ingestMem(A.slug, 'project-b', expB.data.records);
    assert.equal(ingA.data.ingested, 1);

    const gotA = await f.api().getByProject(A.slug, { sources: 'repo', detail: 'full' });
    assert.ok(fileNames(gotA, 'repo:project-b').includes('project_shared.md'),
      'project A must be able to access project B memory when imported');
  });
});
