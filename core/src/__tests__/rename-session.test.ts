/**
 * First-class session rename (bl_562a8de4) — no TUI driving.
 *
 * The LOCAL mechanism is an external O_APPEND append of the CLI's OWN
 * custom-title record. The record shape is EMPIRICAL, read from real
 * transcripts under ~/.claude/projects/ (written by the CLI's /rename):
 *
 *   {"type":"custom-title","customTitle":"<title>","sessionId":"<uuid>"}
 *
 * Exactly three fields, one line. Every parser in this repo takes the LAST
 * such record (session-cache.ts ~913, agent-session-store.ts ~3002/~5119),
 * so the append IS the rename — provided it lands on its OWN line even when
 * the file's last write lost its trailing newline. These tests pin:
 *   - the record shape (a drifted shape would be silently IGNORED by the
 *     parsers — a rename that "succeeded" and did nothing),
 *   - the torn-tail repair (gluing onto a partial line corrupts BOTH records),
 *   - the honesty contract (title is re-read back; previousTitle reported),
 *   - the id-kind detection the MCP tool routes on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  appendCustomTitle,
  normalizeSessionTitle,
  renameLocalSession,
  SessionRenameError,
  MAX_SESSION_TITLE_LEN,
} from '../session-rename';
import type { LocalRenameResult } from '../session-rename';
import { classifySessionId, handleRenameSession } from '../mcp-server/tools/rename-session';
import { createSessionsRoutes } from '../routes/core/sessions.routes';
import type { RouteContext } from '../routes/index';

const SID = '743fc8d4-8fc7-4e79-a21c-a3d081715f2e';

function tmpJsonl(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-session-test-'));
  const fp = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(fp, content);
  return fp;
}

/** The EXACT predicate session-cache.ts uses to pick a title up (line ~913). */
function parseTitleLikeSessionCache(lines: string[]): string | undefined {
  let title: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === 'custom-title' && msg.customTitle) title = msg.customTitle as string;
  }
  return title;
}

// ── title normalization (mirrors rename_conversation's contract) ────────────

test('normalizeSessionTitle collapses whitespace and newlines to one line', () => {
  // A raw newline in the title would TERMINATE the JSONL record early —
  // normalization is what makes the single-line append safe to write.
  assert.equal(normalizeSessionTitle('  hello   world  '), 'hello world');
  assert.equal(normalizeSessionTitle('multi\nline\r\ntitle'), 'multi line title');
});

test('normalizeSessionTitle rejects blank and non-string titles', () => {
  assert.throws(() => normalizeSessionTitle(''), /must not be empty/);
  assert.throws(() => normalizeSessionTitle('  \n\t '), /must not be empty/);
  assert.throws(() => normalizeSessionTitle(undefined), /must be a string/);
  assert.throws(() => normalizeSessionTitle(42), /must be a string/);
});

test('normalizeSessionTitle bounds length', () => {
  const ok = 'x'.repeat(MAX_SESSION_TITLE_LEN);
  assert.equal(normalizeSessionTitle(ok), ok);
  assert.throws(() => normalizeSessionTitle('x'.repeat(MAX_SESSION_TITLE_LEN + 1)), /200/);
});

// ── the append: exact CLI record shape, own line, verified read-back ────────

test('appendCustomTitle writes the CLI record shape the parsers pick up', async () => {
  const fp = tmpJsonl('{"type":"user","message":{"role":"user","content":"hi"}}\n');
  const res = await appendCustomTitle(fp, SID, 'New Title');

  const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'exactly one line appended');
  assert.deepEqual(JSON.parse(lines[1]), {
    type: 'custom-title',
    customTitle: 'New Title',
    sessionId: SID,
  });
  // and the session-cache predicate sees it
  assert.equal(parseTitleLikeSessionCache(lines), 'New Title');
  assert.equal(res.verified, true);
  assert.equal(res.readBack, 'New Title');
  assert.equal(res.previousTitle, null);
});

test('appendCustomTitle repairs a torn tail (file not ending in newline)', async () => {
  const first = '{"type":"user","message":{"role":"user","content":"hi"}}';
  const fp = tmpJsonl(first); // NO trailing newline
  const res = await appendCustomTitle(fp, SID, 'After Torn Tail');

  const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  // the previous record survives intact AND our record parses on its own line
  assert.equal((JSON.parse(lines[0]) as { type: string }).type, 'user');
  assert.equal((JSON.parse(lines[1]) as { customTitle: string }).customTitle, 'After Torn Tail');
  assert.equal(res.verified, true);
});

// ── live + torn tail = the CLI may be MID-FLUSH — refuse (review fix: data safety) ──

test('appendCustomTitle REFUSES a live session with a torn tail (MID_WRITE) and touches nothing', async () => {
  // Review finding: a torn tail on a LIVE session is indistinguishable from the
  // CLI mid-flush of a chunked multi-part write. Healing + appending in that
  // window splits the CLI's in-flight record into two corrupt lines — while
  // reporting verified:true. The only safe move is a retryable refusal.
  const torn = '{"type":"assistant","message":{"role":"assistant","content":"partial chunk that is still being writ';
  const fp = tmpJsonl(torn); // NO trailing newline — an in-flight write's visible state
  await assert.rejects(appendCustomTitle(fp, SID, 'Must Not Land', { live: true }), (e: unknown) => {
    assert.ok(e instanceof SessionRenameError);
    assert.equal(e.code, 'MID_WRITE');
    assert.match(e.message, /retry/i, 'the refusal must tell the caller to retry shortly');
    return true;
  });
  assert.equal(fs.readFileSync(fp, 'utf8'), torn, 'no heal, no append — the file must be untouched');
});

test('appendCustomTitle still heals a torn tail when the session is NOT live (crashed writer)', async () => {
  const first = '{"type":"user","message":{"role":"user","content":"hi"}}';
  const fp = tmpJsonl(first); // NO trailing newline — dead writer left it torn
  const res = await appendCustomTitle(fp, SID, 'Healed After Crash', { live: false });
  assert.equal(res.repairedNewline, true);
  assert.equal(res.verified, true);
  const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
  assert.equal((JSON.parse(lines[0]) as { type: string }).type, 'user');
  assert.equal((JSON.parse(lines[1]) as { customTitle: string }).customTitle, 'Healed After Crash');
});

test('appendCustomTitle appends normally on a LIVE session with a clean tail', async () => {
  // A clean tail is the absence of any observable in-flight write — the append
  // itself is one atomic O_APPEND record, safe to interleave.
  const fp = tmpJsonl('{"type":"user","message":{"role":"user","content":"hi"}}\n');
  const res = await appendCustomTitle(fp, SID, 'Live Clean Tail', { live: true });
  assert.equal(res.verified, true);
  assert.equal(res.repairedNewline, false);
});

test('appendCustomTitle reports the previous title (last record wins)', async () => {
  const fp = tmpJsonl(
    `{"type":"custom-title","customTitle":"First","sessionId":"${SID}"}\n` +
    `{"type":"user","message":{"role":"user","content":"hi"}}\n` +
    `{"type":"custom-title","customTitle":"Second","sessionId":"${SID}"}\n`,
  );
  const res = await appendCustomTitle(fp, SID, 'Third');
  assert.equal(res.previousTitle, 'Second');
  assert.equal(res.verified, true);
  const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
  assert.equal(parseTitleLikeSessionCache(lines), 'Third');
});

test('appendCustomTitle works on an empty transcript', async () => {
  const fp = tmpJsonl('');
  const res = await appendCustomTitle(fp, SID, 'Only Record');
  assert.equal(res.previousTitle, null);
  assert.equal(res.verified, true);
});

test('appendCustomTitle refuses a missing file rather than creating one', async () => {
  // Creating a transcript that does not exist would fabricate a session.
  const fp = path.join(os.tmpdir(), 'rename-session-test-none', `${SID}.jsonl`);
  await assert.rejects(appendCustomTitle(fp, SID, 'X'));
});

// ── renameLocalSession refusals (safe: no transcript is ever written) ───────

test('renameLocalSession refuses a non-uuid id with a structured error', async () => {
  await assert.rejects(renameLocalSession('session_notlocal', 'T'), (e: unknown) => {
    assert.ok(e instanceof SessionRenameError);
    assert.equal(e.code, 'INVALID_SESSION_ID');
    assert.equal(e.httpStatus, 400);
    return true;
  });
});

test('renameLocalSession refuses a uuid with no transcript on this host', async () => {
  // Valid uuid shape, vanishingly unlikely to exist — resolves through the real
  // registry and must come back SESSION_NOT_FOUND, not a silent no-op.
  await assert.rejects(renameLocalSession('00000000-0000-4000-8000-000000000000', 'T'), (e: unknown) => {
    assert.ok(e instanceof SessionRenameError);
    assert.equal(e.code, 'SESSION_NOT_FOUND');
    assert.equal(e.httpStatus, 404);
    return true;
  });
});

// ── id-kind detection (what the MCP tool routes on) ─────────────────────────

test('classifySessionId detects cloud, cowork and local ids', () => {
  assert.equal(classifySessionId('session_011CRtSTBSHV6pyLYVdCX8nM'), 'cloud');
  assert.equal(classifySessionId('cse_011CRtSTBSHV6pyLYVdCX8nM'), 'cowork');
  assert.equal(classifySessionId(SID), 'local');
  assert.equal(classifySessionId(SID.toUpperCase()), 'local');
  assert.equal(classifySessionId('not-a-session'), null);
  assert.equal(classifySessionId(''), null);
});

// ── verification is a FULL-FILE scan (review fix: honesty) ──────────────────

test('verification survives a giant CLI append landing right after ours', async (t) => {
  // Review finding: read-back used a 64 KiB tail window, so a large CLI append
  // between our append and the read pushed our record out of the window →
  // FALSE FAILURE for a rename that actually landed. Verification must be the
  // full-file scan (same cost class as the previousTitle scan we already do).
  const fp = tmpJsonl('{"type":"user","message":{"role":"user","content":"hi"}}\n');
  const realAppend = fs.promises.appendFile.bind(fs.promises);
  const giant = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: 'x'.repeat(80 * 1024) },
  });
  t.mock.method(fs.promises, 'appendFile', async (p: any, data: any, enc: any) => {
    await realAppend(p, data, enc);
    // a live CLI lands a HUGE record immediately after ours — larger than any tail window
    await realAppend(p, `${giant}\n`, 'utf8');
  });

  const res = await appendCustomTitle(fp, SID, 'Landed Title');
  assert.equal(res.readBack, 'Landed Title', 'full scan must find the record the append landed');
  assert.equal(res.verified, true, 'a rename that landed must never read as a failure');
});

// ── REST route: error envelope on refusal/unverified (review fix: honesty) ──

function findRenameRoute() {
  // The rename handler never touches ctx/api — a bare ctx object is enough.
  const routes = createSessionsRoutes({} as unknown as RouteContext);
  const route = routes.find((r) => r.method === 'POST' && r.pattern.source.includes('rename'));
  assert.ok(route, 'POST /sessions/:sessionId/rename route exists');
  return route!;
}

function fakeReq(sessionId: string, title: string) {
  return {
    method: 'POST',
    path: `/sessions/${sessionId}/rename`,
    params: { sessionId },
    query: {},
    body: { title },
  } as any;
}

test('rename route returns an ERROR envelope (non-2xx) when verification fails', async (t) => {
  // Review finding: the route returned HTTP 200 success:true even when
  // verified:false — only the MCP layer converted that to an error. A REST
  // caller was told the rename succeeded when the read-back disproved it.
  const sessionRenameMod: any = require('../session-rename');
  const unverified: LocalRenameResult = {
    renamed: false,
    sessionId: SID,
    title: 'New',
    previousTitle: 'Old',
    readBack: null,
    verified: false,
    live: true,
    jsonl: `/tmp/${SID}.jsonl`,
    mechanism: 'jsonl-append',
  };
  t.mock.method(sessionRenameMod, 'renameLocalSession', async () => unverified);

  const res = await findRenameRoute().handler(fakeReq(SID, 'New'), {} as any);
  assert.equal(res.success, false, 'unverified rename must not be success:true');
  assert.ok(typeof res.httpStatus === 'number' && res.httpStatus >= 400, `non-2xx expected, got ${res.httpStatus}`);
  assert.ok(res.error?.code, 'structured error code expected');
  // the payload fields still ride along so the caller sees what was observed
  assert.equal(res.data?.verified, false);
  assert.equal(res.data?.renamed, false);
  assert.equal(res.data?.previousTitle, 'Old');
});

test('rename route maps a MID_WRITE refusal to a retryable error envelope', async (t) => {
  const sessionRenameMod: any = require('../session-rename');
  t.mock.method(sessionRenameMod, 'renameLocalSession', async () => {
    throw new SessionRenameError('MID_WRITE', 'transcript tail is torn while the session is LIVE — retry shortly', 503);
  });

  const res = await findRenameRoute().handler(fakeReq(SID, 'New'), {} as any);
  assert.equal(res.success, false);
  assert.equal(res.httpStatus, 503);
  assert.equal(res.error?.code, 'MID_WRITE');
  assert.match(res.error?.message || '', /retry/i);
});

// ── MCP handler refusals (no network involved) ──────────────────────────────

// ── cowork-path rename syncs the CCR local registry (review fix: consistency) ──

test('applyRegistryTitleForCse retitles entries keyed by sid OR cse that map to the cse', () => {
  // Review finding: renameCoworkTask hits the SAME upstream PUT as cloudRename
  // but skipped cloudRename's local-registry title sync (ccr-cloud.ts ~979) —
  // the /ccr page kept showing the stale title. The registry is keyed by the
  // sid the session was created under, so the match must go through toBridgeCse.
  const { applyRegistryTitleForCse } = require('../terminal/ccr-cloud') as typeof import('../terminal/ccr-cloud');
  const mk = (sid: string, title: string) => ({
    sid, title, model: 'm', repo: null, cwd: null, seedFileId: null, environmentId: null, webUrl: '', createdAt: '2026-01-01',
  });
  const reg: Record<string, any> = {
    session_abc123: mk('session_abc123', 'stale'),
    cse_def456: mk('cse_def456', 'stale-bridge'),
    session_other: mk('session_other', 'untouched'),
  };

  assert.equal(applyRegistryTitleForCse(reg, 'cse_abc123', 'Fresh'), true);
  assert.equal(reg.session_abc123.title, 'Fresh', 'session_-keyed entry for the same code session retitled');
  assert.equal(reg.session_other.title, 'untouched');

  assert.equal(applyRegistryTitleForCse(reg, 'cse_def456', 'Fresh Bridge'), true);
  assert.equal(reg.cse_def456.title, 'Fresh Bridge', 'cse_-keyed entry retitled');

  // no matching entry → no change reported (nothing to save)
  assert.equal(applyRegistryTitleForCse(reg, 'cse_nomatch', 'X'), false);
});

test('renameCoworkTask best-effort syncs the CCR registry title after the upstream accepts', async (t) => {
  const oauthMod: any = require('../utils/claude-oauth');
  const ccrCloudMod: any = require('../terminal/ccr-cloud');
  const coworkMod: any = require('../cowork/cowork-tasks');

  t.mock.method(oauthMod, 'getOrganizationUuid', async () => 'org-test');
  const put = t.mock.method(oauthMod, 'anthropicOAuthPut', async () => ({ status: 200, statusText: 'OK', body: {} }));
  const synced: Array<[string, string]> = [];
  t.mock.method(ccrCloudMod, 'syncRegistryTitleForCse', (cse: string, title: string) => {
    synced.push([cse, title]);
    return true;
  });

  const res = await coworkMod.renameCoworkTask('cse_abc123', 'New Cowork Title');
  assert.deepEqual(res, { ok: true, title: 'New Cowork Title' });
  assert.equal(put.mock.callCount(), 1, 'upstream PUT still happens exactly once');
  assert.deepEqual(synced, [['cse_abc123', 'New Cowork Title']], 'registry sync ran with the cse + new title');
});

test('renameCoworkTask survives a registry-sync failure — the rename already landed upstream', async (t) => {
  const oauthMod: any = require('../utils/claude-oauth');
  const ccrCloudMod: any = require('../terminal/ccr-cloud');
  const coworkMod: any = require('../cowork/cowork-tasks');

  t.mock.method(oauthMod, 'getOrganizationUuid', async () => 'org-test');
  t.mock.method(oauthMod, 'anthropicOAuthPut', async () => ({ status: 200, statusText: 'OK', body: {} }));
  t.mock.method(ccrCloudMod, 'syncRegistryTitleForCse', () => {
    throw new Error('registry disk hiccup');
  });

  const res = await coworkMod.renameCoworkTask('cse_abc123', 'Still Renamed');
  assert.deepEqual(res, { ok: true, title: 'Still Renamed' }, 'sync failure must not fail the rename');
});

test('renameCoworkTask does NOT sync the registry when the upstream rename fails', async (t) => {
  const oauthMod: any = require('../utils/claude-oauth');
  const ccrCloudMod: any = require('../terminal/ccr-cloud');
  const coworkMod: any = require('../cowork/cowork-tasks');

  t.mock.method(oauthMod, 'getOrganizationUuid', async () => 'org-test');
  t.mock.method(oauthMod, 'anthropicOAuthPut', async () => ({ status: 500, statusText: 'ERR', body: {} }));
  const sync = t.mock.method(ccrCloudMod, 'syncRegistryTitleForCse', () => true);

  await assert.rejects(coworkMod.renameCoworkTask('cse_abc123', 'Nope'), /rename failed/);
  assert.equal(sync.mock.callCount(), 0, 'a stale-title sync of a rename that did not land would LIE');
});

test('handleRenameSession refuses missing args and unknown id shapes loudly', async () => {
  const noId = await handleRenameSession({ title: 'T' });
  assert.equal(noId.isError, true);
  assert.match(noId.content[0].text!, /session_id/);

  const noTitle = await handleRenameSession({ session_id: SID });
  assert.equal(noTitle.isError, true);
  assert.match(noTitle.content[0].text!, /title/);

  const junk = await handleRenameSession({ session_id: 'wat', title: 'T' });
  assert.equal(junk.isError, true);
  // must NAME the accepted shapes so the caller can fix the call
  assert.match(junk.content[0].text!, /session_/);
  assert.match(junk.content[0].text!, /cse_/);
  assert.match(junk.content[0].text!, /uuid/i);
});
