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
import { classifySessionId, handleRenameSession } from '../mcp-server/tools/rename-session';

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

// ── MCP handler refusals (no network involved) ──────────────────────────────

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
