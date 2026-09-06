/**
 * Windows text send path (2026-09, DESKTOP-GDKLATG): the clipboard paste path
 * located the target TAB by a console-title marker, which Windows Terminal only
 * shows for a tab's ACTIVE pane — 1 of 6 driveable sessions was locatable, the
 * rest failed "could not locate window/tab". Text now goes by pid through the
 * console input buffer, like keys always did. Live-verified: single-line typed,
 * multi-line arrived as one paste with the newlines inside the composer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTextSend } from '../terminal/windows-terminal';

test('text with a pid → console-input (no locate); multi-line is bracketed, single-line is not', () => {
  assert.deepEqual(planTextSend({ pid: 4242, text: 'hello' }), { path: 'console-input', bracketed: false });
  assert.deepEqual(planTextSend({ pid: 4242, text: 'line one\nline two' }), { path: 'console-input', bracketed: true });
  assert.deepEqual(planTextSend({ pid: 4242, text: 'a\r\nb' }), { path: 'console-input', bracketed: true });
  // an explicit choice wins
  assert.deepEqual(planTextSend({ pid: 4242, text: 'hello', bracketed: true }), { path: 'console-input', bracketed: true });
});

test('a cached RuntimeId no longer forces the clipboard path — the pid is the key', () => {
  assert.equal(planTextSend({ pid: 4242, rid: '42.1.2.3', text: 'x' }).path, 'console-input');
});

test('no pid (rid only) or forceClipboard → legacy clipboard path', () => {
  assert.deepEqual(planTextSend({ rid: '42.1.2.3', text: 'x' }), { path: 'clipboard', bracketed: false });
  assert.deepEqual(planTextSend({ pid: 4242, text: 'x', forceClipboard: true }), { path: 'clipboard', bracketed: false });
});

test('keys take the keys path; nothing to send → none', () => {
  assert.equal(planTextSend({ pid: 4242, keys: 'ENTER', text: 'ignored' }).path, 'keys');
  assert.equal(planTextSend({ pid: 4242 }).path, 'none');
});
