/**
 * End-to-end over a REAL temporary store: capture → index → search → read →
 * remove (including repacking a real .tar.gz built by GNU tar).
 *
 * These exercise the paths that destroy or hide data, which are the ones a unit
 * test of pure functions cannot vouch for: that an excluded secret is actually
 * pruned from an existing mirror, that a removed member is gone from BOTH the
 * archive and the index, and that a removal from the mirror records an exclusion
 * so the next capture does not quietly bring it back.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as zlib from 'zlib';

import type { BackupConfig } from '../backup/config';
import { captureLocal, indexSnapshot } from '../backup/capture';
import { BackupIndex } from '../backup/search-index';
import { removeItem } from '../backup/remove';
import { readExcludes, readRemovals } from '../backup/store';
import { safeMemberPath, containedPath } from '../backup/tar-reader';

let driverAvailable = true;
try { require('better-sqlite3'); } catch { driverAvailable = false; }
const needsDriver = { skip: driverAvailable ? false : 'better-sqlite3 has no compiled binding here' };

function makeStore(): { cfg: BackupConfig; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-backup-store-'));
  const live = path.join(dir, 'live-claude');

  // A live .claude with content worth keeping and secrets that must not be captured.
  fs.mkdirSync(path.join(live, 'projects', 'P', 'memory'), { recursive: true });
  fs.mkdirSync(path.join(live, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(live, 'claudeai-browser-profile', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(live, 'projects', 'P', 'memory', 'MEMORY.md'), '# index\nthe kestrel protocol\n');
  fs.writeFileSync(path.join(live, 'rules', 'panic.md'), 'name the blocker in one line\n');
  fs.writeFileSync(path.join(live, 'projects', 'P', 'sess.jsonl'),
    JSON.stringify({ message: { role: 'user', content: 'investigate the kestrel regression' } }) + '\n');
  fs.writeFileSync(path.join(live, 'settings.json'), '{"a":1}');
  fs.writeFileSync(path.join(live, '.credentials.json'), '{"accessToken":"LIVE-TOKEN"}');
  fs.writeFileSync(path.join(live, 'claudeai-session.json'), '{"cookie":"LIVE-COOKIE"}');
  fs.writeFileSync(path.join(live, 'claudeai-browser-profile', 'Default', 'Cookies'), 'BINARYCOOKIES');

  return {
    dir,
    cfg: { root: path.join(dir, 'store'), localSource: live, keepSnapshots: 5, claudeAiBaseUrl: 'http://127.0.0.1:1' },
  };
}

test('capture keeps sessions/memory/rules and refuses credentials', needsDriver, () => {
  const { cfg, dir } = makeStore();
  try {
    const index = new BackupIndex(cfg);
    const res = captureLocal(cfg, index);
    const mirror = path.join(cfg.root, 'windows-desk', '.claude');

    for (const kept of ['projects/P/memory/MEMORY.md', 'rules/panic.md', 'projects/P/sess.jsonl', 'settings.json']) {
      assert.ok(fs.existsSync(path.join(mirror, kept)), `${kept} should have been captured`);
    }
    for (const refused of ['.credentials.json', 'claudeai-session.json', 'claudeai-browser-profile/Default/Cookies']) {
      assert.ok(!fs.existsSync(path.join(mirror, refused)), `${refused} MUST NOT be captured`);
    }
    assert.ok(res.secretsExcluded >= 3, `expected exclusions to be counted, got ${res.secretsExcluded}`);
    index.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a secret already in the mirror is PRUNED, not merely skipped', needsDriver, () => {
  // The trap the PowerShell version fell into: `robocopy /XF` skips an excluded
  // file, and `/MIR` never considers it, so a token captured before the policy
  // existed stays in the store forever while the run reports "excluded".
  const { cfg, dir } = makeStore();
  try {
    const mirror = path.join(cfg.root, 'windows-desk', '.claude');
    fs.mkdirSync(mirror, { recursive: true });
    fs.writeFileSync(path.join(mirror, '.credentials.json'), '{"accessToken":"STALE-LIVE-TOKEN"}');

    const index = new BackupIndex(cfg);
    captureLocal(cfg, index);
    index.close();

    assert.ok(!fs.existsSync(path.join(mirror, '.credentials.json')),
      'a pre-existing credential file survived the capture — the exclusion is not cleaning the store');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('indexed content is searchable and readable back', needsDriver, () => {
  const { cfg, dir } = makeStore();
  try {
    const index = new BackupIndex(cfg);
    captureLocal(cfg, index);

    const { hits } = index.search({ q: 'kestrel', limit: 10, offset: 0 });
    assert.ok(hits.length >= 2, `expected the session and the memory file, got ${hits.length}`);
    const kinds = new Set(hits.map((h) => h.kind));
    assert.ok(kinds.has('session') && kinds.has('memory'));

    const session = hits.find((h) => h.kind === 'session')!;
    assert.strictEqual(session.source, 'windows-desk');
    assert.strictEqual(session.store, 'mirror');
    assert.ok(index.get(session.id), 'a search hit id must resolve back to an item');

    // The secret is not merely absent from disk — it never entered the index.
    assert.strictEqual(index.search({ q: 'LIVE-TOKEN', limit: 5, offset: 0 }).hits.length, 0);
    index.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removing a mirrored file records an exclusion so it does not come back', needsDriver, async () => {
  const { cfg, dir } = makeStore();
  try {
    const index = new BackupIndex(cfg);
    captureLocal(cfg, index);
    const hit = index.search({ q: 'kestrel', kind: 'memory', limit: 1, offset: 0 }).hits[0];
    assert.ok(hit, 'need a memory hit to remove');

    const outcome = await removeItem(cfg, index, {
      id: hit.id, reason: 'test removal', exclude: true, scope: 'item',
    });
    assert.ok(outcome.removed);
    assert.ok(outcome.excluded, 'a mirror removal must record an exclusion or the next run undoes it');
    assert.ok(!fs.existsSync(path.join(cfg.root, 'windows-desk', '.claude', hit.path)));
    assert.strictEqual(index.get(hit.id), null, 'the index row must go with the file');
    assert.ok(readExcludes(cfg).includes(hit.path));
    assert.strictEqual(readRemovals(cfg, 5)[0].reason, 'test removal');

    // Prove the exclusion holds: re-capturing must NOT bring the file back.
    captureLocal(cfg, index);
    assert.ok(!fs.existsSync(path.join(cfg.root, 'windows-desk', '.claude', hit.path)),
      'the removed file was re-captured — the exclusion is not being honoured');
    index.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removing a member inside a snapshot repacks the archive and clears the index', needsDriver, async () => {
  const { cfg, dir } = makeStore();
  try {
    // Build a real snapshot the way captureRemote does.
    const snapDir = path.join(cfg.root, 'linux-117');
    fs.mkdirSync(snapDir, { recursive: true });
    const snap = path.join(snapDir, 'claude-2026-07-29_120000.tar.gz');
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(path.join(staging, '.claude', 'projects', 'Q', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(staging, '.claude', 'projects', 'Q', 'memory', 'keep.md'), 'keep this memory\n');
    fs.writeFileSync(path.join(staging, '.claude', 'projects', 'Q', 'memory', 'doomed.md'), 'the doomed kestrel note\n');
    execFileSync('tar', ['czf', snap, '-C', staging, '.claude']);

    const index = new BackupIndex(cfg);
    const stats = await indexSnapshot(cfg, 'linux-117', snap, index);
    assert.ok(stats.indexed >= 2, `expected snapshot members indexed, got ${stats.indexed}`);

    const hit = index.search({ q: 'doomed', limit: 5, offset: 0 }).hits[0];
    assert.ok(hit, 'the snapshot member must be searchable without unpacking');
    assert.strictEqual(hit.store, 'snapshot');
    assert.ok(hit.container.endsWith('.tar.gz'));

    const outcome = await removeItem(cfg, index, {
      id: hit.id, reason: 'test snapshot removal', exclude: true, scope: 'item',
    });
    assert.ok(outcome.repack, 'a snapshot member removal must repack');
    assert.strictEqual(outcome.repack!.entriesAfter, outcome.repack!.entriesBefore - 1);
    assert.strictEqual(index.get(hit.id), null);
    assert.strictEqual(index.search({ q: 'doomed', limit: 5, offset: 0 }).hits.length, 0);

    // The archive is still valid and still holds everything else.
    const back = path.join(dir, 'back');
    fs.mkdirSync(back);
    execFileSync('tar', ['xzf', snap, '-C', back]);
    assert.ok(fs.existsSync(path.join(back, '.claude', 'projects', 'Q', 'memory', 'keep.md')));
    assert.ok(!fs.existsSync(path.join(back, '.claude', 'projects', 'Q', 'memory', 'doomed.md')));
    index.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removing an unknown id fails loudly rather than reporting success', needsDriver, async () => {
  const { cfg, dir } = makeStore();
  try {
    const index = new BackupIndex(cfg);
    captureLocal(cfg, index);
    await assert.rejects(
      () => removeItem(cfg, index, { id: 'deadbeef', reason: 'x', exclude: true, scope: 'item' }),
      /no backed-up item with id/,
    );
    index.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ tar slip

/**
 * Build a tar containing an arbitrary member name.
 *
 * GNU tar REFUSES to create these — it strips leading `/` and `../` — which is
 * exactly why a hostile archive has to be hand-assembled to test against. A
 * real attacker writes the header bytes directly, so the test does too.
 */
function malignTar(members: { name: string; body: string; type?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const m of members) {
    const body = Buffer.from(m.body, 'utf-8');
    const h = Buffer.alloc(512, 0);
    h.write(m.name.slice(0, 100), 0, 'utf-8');
    h.write('0000644\0', 100);                                  // mode
    h.write('0000000\0', 108); h.write('0000000\0', 116);       // uid / gid
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('0'.repeat(11) + '\0', 136);                        // mtime
    h.write('        ', 148);                                   // chksum: spaces while summing
    h.write(m.type ?? '0', 156);
    h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test('a poisoned tar member never reaches the index', needsDriver, async () => {
  const { cfg, dir } = makeStore();
  try {
    const snapDir = path.join(cfg.root, 'linux-117');
    fs.mkdirSync(snapDir, { recursive: true });
    const snap = path.join(snapDir, 'claude-2026-07-29_130000.tar.gz');
    fs.writeFileSync(snap, malignTar([
      { name: '.claude/rules/legit.md', body: 'the kestrel rule\n' },
      { name: '../../../../etc/cron.d/pwn', body: 'the kestrel payload\n' },
      { name: '/etc/shadow', body: 'the kestrel payload\n' },
      { name: '.claude/../../escape.md', body: 'the kestrel payload\n' },
      { name: 'C:\\Windows\\System32\\evil.dll', body: 'the kestrel payload\n' },
    ]));

    const index = new BackupIndex(cfg);
    await indexSnapshot(cfg, 'linux-117', snap, index);

    const hits = index.search({ q: 'kestrel', limit: 20, offset: 0 }).hits;
    assert.strictEqual(hits.length, 1, `only the legitimate member may be indexed, got ${hits.map((h) => h.member).join(', ')}`);
    assert.strictEqual(hits[0].member, '.claude/rules/legit.md');
    for (const h of hits) {
      assert.ok(!h.member.includes('..'), `traversal name reached the index: ${h.member}`);
      assert.ok(!h.member.startsWith('/'), `absolute name reached the index: ${h.member}`);
    }
    index.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('safeMemberPath refuses every escape shape and keeps ordinary names', () => {
  for (const bad of [
    '../etc/passwd', 'a/../../b', '/etc/shadow', '/', 'C:/Windows/evil.dll',
    'C:\\Windows\\evil.dll', '..', '.', '', 'a//b', 'a/./b', '.claude/../../escape.md',
    '..\\..\\windows\\evil', 'foo/..',
  ]) {
    assert.strictEqual(safeMemberPath(bad), null, `should have refused ${JSON.stringify(bad)}`);
  }
  // Real member names must survive untouched — a guard that eats legitimate
  // session paths silently empties the backup, which is the worse failure.
  assert.strictEqual(safeMemberPath('.claude/rules/panic.md'), '.claude/rules/panic.md');
  assert.strictEqual(safeMemberPath('./.claude/projects/P/a-b-c.jsonl'), '.claude/projects/P/a-b-c.jsonl');
  assert.strictEqual(safeMemberPath('projects/C--home-lm-assist/54aa4d40.jsonl'),
    'projects/C--home-lm-assist/54aa4d40.jsonl');
  assert.strictEqual(safeMemberPath('a..b/c.md'), 'a..b/c.md');   // `..` inside a segment is fine
});

test('containedPath rejects anything resolving outside the destination', () => {
  const root = path.join(os.tmpdir(), 'lm-contain-root');
  assert.ok(containedPath(root, 'a/b.md'));
  assert.strictEqual(containedPath(root, '../sibling/b.md'), null);
  assert.strictEqual(containedPath(root, path.resolve(os.tmpdir(), 'elsewhere.md')), null);
  // A sibling with the same PREFIX must not be mistaken for containment.
  assert.strictEqual(containedPath(root, '../lm-contain-root-evil/x.md'), null);
});

// ------------------------------------------------------------------ browsing

test('list() browses without a query and pages honestly', needsDriver, () => {
  const { cfg, dir } = makeStore();
  try {
    const index = new BackupIndex(cfg);
    captureLocal(cfg, index);

    // Everything, unfiltered by kind — the "what have you got" case that search
    // cannot answer because it has no term to offer.
    const all = index.list({ limit: 100, offset: 0 });
    assert.ok(all.total >= 4, `expected the captured tree, got ${all.total}`);
    assert.strictEqual(all.rows.length, all.total);

    // Filters narrow rather than re-query.
    const memory = index.list({ kind: 'memory', limit: 10, offset: 0 });
    assert.ok(memory.total >= 1);
    assert.ok(memory.rows.every((r) => r.kind === 'memory'));

    const prefixed = index.list({ prefix: 'rules/', limit: 10, offset: 0 });
    assert.ok(prefixed.total >= 1);
    assert.ok(prefixed.rows.every((r) => r.path.startsWith('rules/')));

    // total counts EVERYTHING matching, not just the page — that is what lets a
    // caller know there is more. A total equal to the page size would be the
    // silent-truncation bug.
    const page = index.list({ limit: 1, offset: 0 });
    assert.strictEqual(page.rows.length, 1);
    assert.strictEqual(page.total, all.total);

    // Paging covers the set without gaps or repeats.
    const seen = new Set<string>();
    for (let off = 0; off < all.total; off += 2) {
      for (const r of index.list({ limit: 2, offset: off }).rows) {
        assert.ok(!seen.has(r.id), `id ${r.id} returned twice across pages`);
        seen.add(r.id);
      }
    }
    assert.strictEqual(seen.size, all.total, 'paging did not cover every row exactly once');
    index.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a LIKE metacharacter in a prefix cannot widen the match', needsDriver, () => {
  const { cfg, dir } = makeStore();
  try {
    const index = new BackupIndex(cfg);
    captureLocal(cfg, index);
    // Unescaped, "_" is LIKE's single-character wildcard and "%" matches
    // anything — a prefix filter that silently returned the whole backup would
    // look like a working filter right up until it mattered.
    assert.strictEqual(index.list({ prefix: '%', limit: 10, offset: 0 }).total, 0);
    assert.strictEqual(index.list({ prefix: '_ules/', limit: 10, offset: 0 }).total, 0);
    assert.ok(index.list({ prefix: 'rules/', limit: 10, offset: 0 }).total >= 1);
    index.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overview aggregates the store without listing it', needsDriver, () => {
  const { cfg, dir } = makeStore();
  try {
    const index = new BackupIndex(cfg);
    captureLocal(cfg, index);
    const o = index.overview();
    assert.ok(o.totals.items >= 4);
    assert.ok(o.totals.bytes > 0);
    assert.ok(o.bySource.some((b) => b.source === 'windows-desk' && b.kind === 'memory'));
    // One row per (source, kind) — never one row per item, which is the whole
    // point of an overview that stays a fixed size as the backup grows.
    assert.ok(o.bySource.length <= 25, `overview returned ${o.bySource.length} rows — it is listing, not aggregating`);
    index.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
