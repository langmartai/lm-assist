/**
 * Desktop automation — Windows keymap (PURE; unit-tested).
 *
 * Translates the xdotool-style key vocabulary the cross-platform contract uses
 * (types.ts: "ctrl+s", "Return", "Page_Down", "alt+Tab", "super") into Windows
 * virtual-key press sequences for the helper's SendInput. Two platform facts
 * live here so the backend stays mechanical:
 *   - EXTENDED keys (arrows, Ins/Del/Home/End/PgUp/PgDn, Win, numpad-Enter)
 *     need KEYEVENTF_EXTENDEDKEY or apps receive the numpad twin.
 *   - Shifted keysyms (xdotool "plus", "colon", a capital letter) have no VK of
 *     their own — they compile to shift + the base VK.
 */

import { DesktopError } from '../types';

/** One SendInput keyboard step for the helper's `keyseq` command. */
export interface KeyStep {
  vk: number;
  down: boolean;
  extended: boolean;
}

interface VkDef {
  vk: number;
  extended?: boolean;
  /** The keysym requires shift held around the base VK (e.g. "plus"). */
  shift?: boolean;
}

const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12; // alt
const VK_LWIN = 0x5b;

/** Modifier names accepted both in combos and as click/scroll modifiers. */
const MODIFIERS: Record<string, VkDef> = {
  ctrl: { vk: VK_CONTROL },
  control: { vk: VK_CONTROL },
  shift: { vk: VK_SHIFT },
  alt: { vk: VK_MENU },
  meta: { vk: VK_LWIN, extended: true },
  super: { vk: VK_LWIN, extended: true },
  win: { vk: VK_LWIN, extended: true },
};

/** xdotool keysym → VK. Names are matched case-sensitively first (keysyms are
 *  case-significant: "a" vs "A"), then case-insensitively for the named keys. */
const NAMED: Record<string, VkDef> = {
  Return: { vk: 0x0d },
  Enter: { vk: 0x0d },
  KP_Enter: { vk: 0x0d, extended: true },
  Tab: { vk: 0x09 },
  space: { vk: 0x20 },
  BackSpace: { vk: 0x08 },
  Delete: { vk: 0x2e, extended: true },
  Insert: { vk: 0x2d, extended: true },
  Escape: { vk: 0x1b },
  Home: { vk: 0x24, extended: true },
  End: { vk: 0x23, extended: true },
  Page_Up: { vk: 0x21, extended: true },
  Prior: { vk: 0x21, extended: true },
  Page_Down: { vk: 0x22, extended: true },
  Next: { vk: 0x22, extended: true },
  Left: { vk: 0x25, extended: true },
  Up: { vk: 0x26, extended: true },
  Right: { vk: 0x27, extended: true },
  Down: { vk: 0x28, extended: true },
  Print: { vk: 0x2c, extended: true },
  Menu: { vk: 0x5d, extended: true },
  Caps_Lock: { vk: 0x14 },
  Num_Lock: { vk: 0x90, extended: true },
  Scroll_Lock: { vk: 0x91 },
  Pause: { vk: 0x13 },
};

/** Shifted/unshifted punctuation keysyms → US-layout OEM VKs. */
const PUNCT: Record<string, VkDef> = {
  minus: { vk: 0xbd },
  underscore: { vk: 0xbd, shift: true },
  equal: { vk: 0xbb },
  plus: { vk: 0xbb, shift: true },
  comma: { vk: 0xbc },
  less: { vk: 0xbc, shift: true },
  period: { vk: 0xbe },
  greater: { vk: 0xbe, shift: true },
  slash: { vk: 0xbf },
  question: { vk: 0xbf, shift: true },
  semicolon: { vk: 0xba },
  colon: { vk: 0xba, shift: true },
  apostrophe: { vk: 0xde },
  quotedbl: { vk: 0xde, shift: true },
  bracketleft: { vk: 0xdb },
  braceleft: { vk: 0xdb, shift: true },
  bracketright: { vk: 0xdd },
  braceright: { vk: 0xdd, shift: true },
  backslash: { vk: 0xdc },
  bar: { vk: 0xdc, shift: true },
  grave: { vk: 0xc0 },
  asciitilde: { vk: 0xc0, shift: true },
  exclam: { vk: 0x31, shift: true },
  at: { vk: 0x32, shift: true },
  numbersign: { vk: 0x33, shift: true },
  dollar: { vk: 0x34, shift: true },
  percent: { vk: 0x35, shift: true },
  asciicircum: { vk: 0x36, shift: true },
  ampersand: { vk: 0x37, shift: true },
  asterisk: { vk: 0x38, shift: true },
  parenleft: { vk: 0x39, shift: true },
  parenright: { vk: 0x30, shift: true },
};

/** Literal single characters → the same OEM VKs (lenient input). */
const CHARS: Record<string, VkDef> = {
  '-': PUNCT.minus, _: PUNCT.underscore, '=': PUNCT.equal, '+': PUNCT.plus,
  ',': PUNCT.comma, '<': PUNCT.less, '.': PUNCT.period, '>': PUNCT.greater,
  '/': PUNCT.slash, '?': PUNCT.question, ';': PUNCT.semicolon, ':': PUNCT.colon,
  "'": PUNCT.apostrophe, '"': PUNCT.quotedbl, '[': PUNCT.bracketleft,
  '{': PUNCT.braceleft, ']': PUNCT.bracketright, '}': PUNCT.braceright,
  '\\': PUNCT.backslash, '|': PUNCT.bar, '`': PUNCT.grave, '~': PUNCT.asciitilde,
  '!': PUNCT.exclam, '@': PUNCT.at, '#': PUNCT.numbersign, $: PUNCT.dollar,
  '%': PUNCT.percent, '^': PUNCT.asciicircum, '&': PUNCT.ampersand,
  '*': PUNCT.asterisk, '(': PUNCT.parenleft, ')': PUNCT.parenright,
};

/** Resolve one key name (NOT a combo) to its VK definition. */
export function lookupKey(name: string): VkDef {
  const n = name.trim();
  if (!n) throw new DesktopError('BAD_ARGS', 'empty key name');

  const mod = MODIFIERS[n.toLowerCase()];
  if (mod) return mod;

  // F1..F24
  const f = /^[Ff](\d{1,2})$/.exec(n);
  if (f) {
    const num = parseInt(f[1], 10);
    if (num >= 1 && num <= 24) return { vk: 0x70 + num - 1 };
  }

  if (/^[a-z]$/.test(n)) return { vk: 0x41 + (n.charCodeAt(0) - 97) };
  if (/^[A-Z]$/.test(n)) return { vk: 0x41 + (n.charCodeAt(0) - 65), shift: true };
  if (/^[0-9]$/.test(n)) return { vk: 0x30 + (n.charCodeAt(0) - 48) };

  if (NAMED[n]) return NAMED[n];
  if (PUNCT[n]) return PUNCT[n];
  if (CHARS[n]) return CHARS[n];

  // Named keys, case-insensitive fallback ("return", "page_down", "backspace").
  const ci = Object.keys(NAMED).find((k) => k.toLowerCase() === n.toLowerCase());
  if (ci) return NAMED[ci];
  const cp = Object.keys(PUNCT).find((k) => k.toLowerCase() === n.toLowerCase());
  if (cp) return PUNCT[cp];

  throw new DesktopError('BAD_ARGS', `unknown key "${name}" (xdotool-style names: ctrl+s, Return, Page_Down, alt+Tab, super, F5, …)`);
}

/**
 * Compile an xdotool-style combo ("ctrl+shift+s", "alt+Tab", "super") into the
 * SendInput sequence: modifiers down in order → key down+up (with implied shift
 * when the keysym needs it) → modifiers up in reverse.
 */
export function comboToSteps(combo: string): KeyStep[] {
  const parts = combo
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new DesktopError('BAD_ARGS', `empty key combo "${combo}"`);

  const defs = parts.map(lookupKey);
  const key = defs[defs.length - 1];
  const mods = defs.slice(0, -1);

  const steps: KeyStep[] = [];
  for (const m of mods) steps.push({ vk: m.vk, down: true, extended: !!m.extended });
  const shiftAlready = mods.some((m) => m.vk === VK_SHIFT);
  const impliedShift = !!key.shift && !shiftAlready;
  if (impliedShift) steps.push({ vk: VK_SHIFT, down: true, extended: false });
  steps.push({ vk: key.vk, down: true, extended: !!key.extended });
  steps.push({ vk: key.vk, down: false, extended: !!key.extended });
  if (impliedShift) steps.push({ vk: VK_SHIFT, down: false, extended: false });
  for (const m of mods.slice().reverse()) steps.push({ vk: m.vk, down: false, extended: !!m.extended });
  return steps;
}

/** Down-steps (or up-steps) for holding keys: every part of the combo held. */
export function holdSteps(combo: string, down: boolean): KeyStep[] {
  const parts = combo
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new DesktopError('BAD_ARGS', `empty key combo "${combo}"`);
  const defs = parts.map(lookupKey);
  const ordered = down ? defs : defs.slice().reverse();
  return ordered.map((d) => ({ vk: d.vk, down, extended: !!d.extended }));
}

/** Parse a click/scroll modifier string ("ctrl", "ctrl+shift") to held VKs.
 *  Unknown names are refused loudly (BAD_ARGS) — a silently-dropped modifier
 *  turns a shift-click into a plain click. */
export function modifierSteps(text: string, down: boolean): KeyStep[] {
  const parts = text
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  const defs = parts.map((p) => {
    const d = MODIFIERS[p.toLowerCase()];
    if (!d) throw new DesktopError('BAD_ARGS', `unknown modifier "${p}" (ctrl, shift, alt, super)`);
    return d;
  });
  const ordered = down ? defs : defs.slice().reverse();
  return ordered.map((d) => ({ vk: d.vk, down, extended: !!d.extended }));
}
