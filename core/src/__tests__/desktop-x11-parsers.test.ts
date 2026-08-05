import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScreenSize,
  parseMouseLocation,
  parseActiveWindow,
  parseWorkarea,
  parseWmctrlWindows,
  parseWindowGeometry,
  normalizeWindowId,
  toDecimalId,
  parseWindowState,
  splitModifiers,
  verifyWindowAction,
  parseProcessList,
} from '../desktop/x11-backend';
import type { WindowInfo, WindowState } from '../desktop/types';

/**
 * Pure parsers for the Linux/X11 desktop backend, against fixture strings
 * captured live on node 117 (GNOME 42.9 / Xorg / 3840x2160, 2026-08-05). These
 * are the correctness-critical seams — a mis-parse means clicking the wrong
 * pixel — so they are tested without a display.
 */

test('parseScreenSize reads the current resolution from xrandr', () => {
  const xrandr = `Screen 0: minimum 3840 x 2160, current 3840 x 2160, maximum 3840 x 2160
default connected primary 3840x2160+0+0 0mm x 0mm`;
  assert.deepStrictEqual(parseScreenSize(xrandr), { width: 3840, height: 2160 });
  assert.strictEqual(parseScreenSize('no size here'), null);
});

test('parseMouseLocation reads xdotool --shell output', () => {
  assert.deepStrictEqual(parseMouseLocation('X=1141\nY=64\nSCREEN=0\nWINDOW=56623108\n'), [1141, 64]);
  // Negative coords (a monitor left of primary) must survive.
  assert.deepStrictEqual(parseMouseLocation('X=-200\nY=15\n'), [-200, 15]);
  assert.strictEqual(parseMouseLocation('garbage'), null);
});

test('parseActiveWindow normalizes the EWMH active-window id', () => {
  const xprop = '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3600004';
  assert.strictEqual(parseActiveWindow(xprop), '0x03600004');
  assert.strictEqual(parseActiveWindow('nothing'), null);
});

test('parseWorkarea reads the first four cardinals', () => {
  assert.deepStrictEqual(
    parseWorkarea('_NET_WORKAREA(CARDINAL) = 148, 54, 3692, 2106, 148, 54, 3692, 2106'),
    { x: 148, y: 54, width: 3692, height: 2106 },
  );
});

test('parseWmctrlWindows parses -l -G -p -x rows incl. spaced titles', () => {
  const out = [
    '0x03600004  0 771124 296  108  3692 2106 google-chrome.Google-chrome  ubuntu-Virtual-Machine Search results - Gmail - Google Chrome',
    '0x02200010 -1 4702   0    0    3840 2160 gnome-shell.Gnome-shell       ubuntu-Virtual-Machine ubuntu-Virtual-Machine',
  ].join('\n');
  const rows = parseWmctrlWindows(out);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].id, '0x03600004');
  assert.strictEqual(rows[0].pid, 771124);
  assert.deepStrictEqual(rows[0].bounds, { x: 296, y: 108, width: 3692, height: 2106 });
  assert.strictEqual(rows[0].app, 'google-chrome.Google-chrome');
  assert.strictEqual(rows[0].title, 'Search results - Gmail - Google Chrome');
  assert.strictEqual(rows[0].workspace, 0);
  // desktop -1 (sticky) → workspace null.
  assert.strictEqual(rows[1].workspace, null);
});

test('parseWindowGeometry reads xdotool --shell geometry (the correct coord space)', () => {
  const shell = 'WINDOW=67108880\nX=500\nY=400\nWIDTH=798\nHEIGHT=418\nSCREEN=0\n';
  assert.deepStrictEqual(parseWindowGeometry(shell), { x: 500, y: 400, width: 798, height: 418 });
  // Negative origin (monitor left of primary) survives.
  assert.deepStrictEqual(parseWindowGeometry('X=-100\nY=0\nWIDTH=10\nHEIGHT=10\n'), { x: -100, y: 0, width: 10, height: 10 });
  assert.strictEqual(parseWindowGeometry('X=1\nY=2\n'), null);
});

test('normalizeWindowId zero-pads to a stable 0x form', () => {
  assert.strictEqual(normalizeWindowId('0x3600004'), '0x03600004');
  assert.strictEqual(normalizeWindowId('0X03600004'), '0x03600004');
});

test('toDecimalId accepts 0x-hex, bare decimal, and hex-with-letters', () => {
  // wmctrl emits 0x-hex; xdotool emits decimal — both round-trip to the decimal
  // id the -i flag wants.
  assert.strictEqual(toDecimalId('0x03600004'), String(0x03600004));
  assert.strictEqual(toDecimalId('56623108'), '56623108'); // bare digits = decimal, verbatim
  // A bare hex id is only unambiguous when it contains a-f (else it's decimal).
  assert.strictEqual(toDecimalId('3a00abc'), String(0x3a00abc));
  assert.throws(() => toDecimalId('zzz'), /not a window id/);
});

test('parseWindowState classifies hidden/maximized/active/normal', () => {
  assert.strictEqual(parseWindowState('_NET_WM_STATE_HIDDEN', false), 'minimized');
  assert.strictEqual(parseWindowState('_NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_MAXIMIZED_HORZ', false), 'maximized');
  assert.strictEqual(parseWindowState('_NET_WM_STATE_FOCUSED', true), 'active');
  assert.strictEqual(parseWindowState('', false), 'normal');
});

test('parseProcessList parses ps -eo pid,rss,pcpu,user,comm rows', () => {
  const out = [
    '    771  1048576   3.4  ubuntu               google-chrome',
    '      1     8192   0.0  root                 systemd',
    'garbage line',
  ].join('\n');
  const rows = parseProcessList(out);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].pid, 771);
  assert.strictEqual(rows[0].memMiB, 1024); // 1048576 KiB -> 1024 MiB
  assert.strictEqual(rows[0].cpu, 3.4);
  assert.strictEqual(rows[0].user, 'ubuntu');
  assert.strictEqual(rows[0].name, 'google-chrome');
  assert.strictEqual(rows[1].name, 'systemd');
});

test('splitModifiers splits a combo into xdotool key names', () => {
  assert.deepStrictEqual(splitModifiers('ctrl+shift'), ['ctrl', 'shift']);
  assert.deepStrictEqual(splitModifiers('super'), ['super']);
  assert.deepStrictEqual(splitModifiers(''), []);
});

test('verifyWindowAction confirms outcomes from a re-queried window', () => {
  const w = (over: Partial<Pick<WindowInfo, 'state' | 'bounds'>>): WindowInfo => ({
    id: '0x01',
    title: 't',
    app: 'a',
    pid: 1,
    display: 0,
    workspace: 0,
    bounds: { x: 100, y: 100, width: 800, height: 600 },
    state: 'normal',
    ...over,
  });
  assert.strictEqual(verifyWindowAction({ window: '0x01', action: 'minimize' }, w({ state: 'minimized' as WindowState }), null), true);
  assert.strictEqual(verifyWindowAction({ window: '0x01', action: 'maximize' }, w({ state: 'maximized' as WindowState }), null), true);
  assert.strictEqual(verifyWindowAction({ window: '0x01', action: 'activate' }, w({}), '0x01'), true);
  assert.strictEqual(verifyWindowAction({ window: '0x01', action: 'move', x: 130, y: 130 }, w({ bounds: { x: 132, y: 128, width: 800, height: 600 } }), null), true);
  assert.strictEqual(verifyWindowAction({ window: '0x01', action: 'move', x: 500, y: 500 }, w({}), null), false);
  assert.strictEqual(verifyWindowAction({ window: '0x01', action: 'resize', width: 1000, height: 700 }, w({ bounds: { x: 100, y: 100, width: 1000, height: 700 } }), null), true);
});
