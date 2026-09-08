/**
 * Folder-trust auto-accept must read WHICH row is highlighted. Measured
 * 2026-09-07 on Claude Code 2.1.257: "❯ No, exit" is first, so the historical
 * bare Enter made the launched session quit at the trust screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trustPromptKeys, classifyScreen } from '../terminal/cc-classify';

const NEW_LAYOUT = [
  ' Accessing workspace:',
  ' C:\Users\admin\proj',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  ' project, or work from your team). If not, take a moment to review what\'s in this folder first.',
  " Claude Code'll be able to read, edit, and execute files here.",
  ' Security guide',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n');

test('2.1.257 layout: "No, exit" highlighted first → Down then Enter (a bare Enter would QUIT)', () => {
  assert.equal(classifyScreen(NEW_LAYOUT).state, 'folder_trust');
  assert.deepEqual(trustPromptKeys(NEW_LAYOUT), ['Down', 'Enter']);
});

test('Yes highlighted (older layout) → Enter only', () => {
  const s = NEW_LAYOUT.replace(' ❯ No, exit\n   Yes, I trust this folder', ' ❯ Yes, I trust this folder\n   No, exit');
  assert.deepEqual(trustPromptKeys(s), ['Enter']);
});

test('Yes above the highlighted No → Up then Enter', () => {
  const s = NEW_LAYOUT.replace(' ❯ No, exit\n   Yes, I trust this folder', '   Yes, I trust this folder\n ❯ No, exit');
  assert.deepEqual(trustPromptKeys(s), ['Up', 'Enter']);
});

test('numbered legacy layout ("1. Yes, I trust this folder") → 1 then Enter', () => {
  const s = 'Do you trust the files in this folder?\n 1. Yes, I trust this folder\n 2. No, exit\n';
  assert.deepEqual(trustPromptKeys(s), ['1', 'Enter']);
});

test('no highlight visible → Enter (unchanged fallback)', () => {
  assert.deepEqual(trustPromptKeys('Yes, I trust this folder'), ['Enter']);
});
