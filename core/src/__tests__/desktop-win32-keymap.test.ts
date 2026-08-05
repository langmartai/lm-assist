import { test } from 'node:test';
import assert from 'node:assert';
import { comboToSteps, holdSteps, lookupKey, modifierSteps } from '../desktop/win32/keymap';
import { verifyWin32WindowAction } from '../desktop/win32-backend';
import { DesktopError, WindowInfo } from '../desktop/types';

const VK = { shift: 0x10, ctrl: 0x11, alt: 0x12, win: 0x5b, s: 0x53, tab: 0x09, ret: 0x0d, pgdn: 0x22 };

// ─── lookupKey ────────────────────────────────────────────────────────────────

test('lookupKey: letters, digits, F-keys', () => {
  assert.deepStrictEqual(lookupKey('a').vk, 0x41);
  assert.deepStrictEqual(lookupKey('z').vk, 0x5a);
  assert.strictEqual(lookupKey('A').shift, true);
  assert.strictEqual(lookupKey('A').vk, 0x41);
  assert.strictEqual(lookupKey('7').vk, 0x37);
  assert.strictEqual(lookupKey('F1').vk, 0x70);
  assert.strictEqual(lookupKey('F12').vk, 0x7b);
  assert.strictEqual(lookupKey('f5').vk, 0x74);
});

test('lookupKey: named keys carry extended where Windows requires it', () => {
  assert.strictEqual(lookupKey('Return').vk, VK.ret);
  assert.ok(!lookupKey('Return').extended);
  assert.strictEqual(lookupKey('Page_Down').vk, VK.pgdn);
  assert.strictEqual(lookupKey('Page_Down').extended, true);
  assert.strictEqual(lookupKey('Left').extended, true);
  assert.strictEqual(lookupKey('Delete').extended, true);
  assert.strictEqual(lookupKey('KP_Enter').extended, true);
  // case-insensitive fallback for named keys
  assert.strictEqual(lookupKey('page_down').vk, VK.pgdn);
  assert.strictEqual(lookupKey('return').vk, VK.ret);
});

test('lookupKey: shifted keysyms compile to shift+base VK', () => {
  assert.deepStrictEqual(lookupKey('plus'), { vk: 0xbb, shift: true });
  assert.deepStrictEqual(lookupKey('colon'), { vk: 0xba, shift: true });
  assert.strictEqual(lookupKey('+').shift, true);
  assert.strictEqual(lookupKey('minus').shift, undefined);
});

test('lookupKey: super/meta/win are the (extended) Windows key', () => {
  for (const n of ['super', 'meta', 'win', 'Super']) {
    assert.strictEqual(lookupKey(n).vk, VK.win, n);
    assert.strictEqual(lookupKey(n).extended, true, n);
  }
});

test('lookupKey: unknown name refuses loudly with BAD_ARGS', () => {
  assert.throws(() => lookupKey('NoSuchKey'), (e: unknown) => e instanceof DesktopError && e.code === 'BAD_ARGS');
  assert.throws(() => lookupKey(''), (e: unknown) => e instanceof DesktopError && e.code === 'BAD_ARGS');
});

// ─── comboToSteps ─────────────────────────────────────────────────────────────

test('comboToSteps: ctrl+s = ctrl down, s down/up, ctrl up', () => {
  assert.deepStrictEqual(comboToSteps('ctrl+s'), [
    { vk: VK.ctrl, down: true, extended: false },
    { vk: VK.s, down: true, extended: false },
    { vk: VK.s, down: false, extended: false },
    { vk: VK.ctrl, down: false, extended: false },
  ]);
});

test('comboToSteps: alt+Tab and modifier release order reverses', () => {
  const steps = comboToSteps('ctrl+shift+s');
  assert.deepStrictEqual(steps.map((s) => [s.vk, s.down]), [
    [VK.ctrl, true], [VK.shift, true], [VK.s, true], [VK.s, false], [VK.shift, false], [VK.ctrl, false],
  ]);
  const alt = comboToSteps('alt+Tab');
  assert.deepStrictEqual(alt.map((s) => [s.vk, s.down]), [
    [VK.alt, true], [VK.tab, true], [VK.tab, false], [VK.alt, false],
  ]);
});

test('comboToSteps: bare super is a press of the Win key', () => {
  assert.deepStrictEqual(comboToSteps('super'), [
    { vk: VK.win, down: true, extended: true },
    { vk: VK.win, down: false, extended: true },
  ]);
});

test('comboToSteps: implied shift wraps the key, not doubled when explicit', () => {
  // ctrl+plus needs shift injected around the key
  assert.deepStrictEqual(comboToSteps('ctrl+plus').map((s) => [s.vk, s.down]), [
    [VK.ctrl, true], [VK.shift, true], [0xbb, true], [0xbb, false], [VK.shift, false], [VK.ctrl, false],
  ]);
  // shift+plus must NOT press shift twice
  const explicit = comboToSteps('shift+plus');
  assert.strictEqual(explicit.filter((s) => s.vk === VK.shift && s.down).length, 1);
});

// ─── holdSteps / modifierSteps ────────────────────────────────────────────────

test('holdSteps: downs in order, ups reversed', () => {
  assert.deepStrictEqual(holdSteps('ctrl+alt', true).map((s) => [s.vk, s.down]), [[VK.ctrl, true], [VK.alt, true]]);
  assert.deepStrictEqual(holdSteps('ctrl+alt', false).map((s) => [s.vk, s.down]), [[VK.alt, false], [VK.ctrl, false]]);
});

test('modifierSteps: accepts modifiers only, refuses the rest', () => {
  assert.deepStrictEqual(modifierSteps('ctrl+shift', true).map((s) => s.vk), [VK.ctrl, VK.shift]);
  assert.throws(() => modifierSteps('ctrl+q', true), (e: unknown) => e instanceof DesktopError && e.code === 'BAD_ARGS');
});

// ─── verifyWin32WindowAction ─────────────────────────────────────────────────

function w(over: Partial<WindowInfo>): WindowInfo {
  return {
    id: '1234', title: 'T', app: 'notepad', pid: 1, display: 0, workspace: null,
    bounds: { x: 100, y: 100, width: 800, height: 600 }, state: 'normal', ...over,
  };
}

test('verify: activate passes on foreground match even when maximized', () => {
  assert.ok(verifyWin32WindowAction({ window: '1234', action: 'activate' }, w({ state: 'maximized' }), '1234'));
  assert.ok(!verifyWin32WindowAction({ window: '1234', action: 'activate' }, w({}), '9999'));
});

test('verify: move/resize allow 40px WM slack', () => {
  assert.ok(verifyWin32WindowAction({ window: '1234', action: 'move', x: 130, y: 90 }, w({}), null));
  assert.ok(!verifyWin32WindowAction({ window: '1234', action: 'move', x: 400, y: 100 }, w({}), null));
  assert.ok(verifyWin32WindowAction({ window: '1234', action: 'resize', width: 810, height: 630 }, w({}), null));
  assert.ok(!verifyWin32WindowAction({ window: '1234', action: 'resize', width: 500, height: 600 }, w({}), null));
});

test('verify: min/max/restore judge by state', () => {
  assert.ok(verifyWin32WindowAction({ window: '1234', action: 'minimize' }, w({ state: 'minimized' }), null));
  assert.ok(verifyWin32WindowAction({ window: '1234', action: 'maximize' }, w({ state: 'maximized' }), null));
  assert.ok(verifyWin32WindowAction({ window: '1234', action: 'restore' }, w({ state: 'active' }), null));
  assert.ok(!verifyWin32WindowAction({ window: '1234', action: 'restore' }, w({ state: 'minimized' }), null));
});
