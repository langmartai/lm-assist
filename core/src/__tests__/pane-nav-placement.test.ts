/**
 * Every pane must be PLACED in the shell's sidebar — and placement must stay meaningful.
 *
 * `category` and `sortOrder` travel from each `ui-apps/<uiId>/lmui.config.json` through
 * `syncManagedUis` into the gateway registry, and the shell renders one group per category,
 * ordered by (sort_order, name, ui_key), with groups appearing in the order their first
 * member does. That machinery has worked since it shipped.
 *
 * 🔴 It still produced an unusable nav, because nothing checked the DATA: every pane was
 * copy-pasted with `"category": "Node"`, so the shell drew one heading with seventeen items
 * under it — exactly the undifferentiated bucket the placement feature was added to remove.
 * A default that every author copies is not a default, it is a single group.
 *
 * These are cheap invariants that would have caught it on the second pane.
 */
import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';

/** Mirrors the gateway's own bound (ui-gateway registry scope.ts) — a category it refuses
 *  is a pane that registers without placement and silently falls into the generic heading. */
const CATEGORY_RE = /^[A-Za-z0-9][A-Za-z0-9 &/_-]{0,31}$/;

/** One heading with this many entries under it is the failure this file exists to prevent.
 *  Raise it only with a reason — the number is a judgement about scanning a sidebar, and
 *  the honest fix for a group that outgrows it is another group. */
const MAX_PER_GROUP = 8;

function repoRoot(): string {
  let d = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'ui-apps')) && fs.existsSync(path.join(d, 'package.json'))) return d;
    d = path.dirname(d);
  }
  throw new Error(`could not locate the repo root above ${__dirname}`);
}

interface Placed { uiId: string; name: string; category: string; sortOrder: number }

/** Every in-repo pane the node actually asserts: `managed: true`, and NOT `assist-web`
 *  scope — reporter.ts skips that scope on purpose (those four are gateway-hosted, and
 *  their placement is registry state on the gateway box, not a file here). */
function placedPanes(): Placed[] {
  const root = path.join(repoRoot(), 'ui-apps');
  const out: Placed[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cfgPath = path.join(root, entry.name, 'lmui.config.json');
    if (!fs.existsSync(cfgPath)) continue;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.managed !== true) continue;
    if (cfg.scope === 'assist-web') continue;
    out.push({
      uiId: String(cfg.uiId ?? entry.name),
      name: String(cfg.name ?? cfg.uiId ?? entry.name),
      category: cfg.category,
      sortOrder: cfg.sortOrder,
    });
  }
  return out;
}

test('every managed pane declares a placement the gateway will accept', () => {
  const panes = placedPanes();
  assert.ok(panes.length > 10, `sanity: expected >10 managed panes, saw ${panes.length}`);
  const bad: string[] = [];
  for (const p of panes) {
    if (typeof p.category !== 'string' || !CATEGORY_RE.test(p.category)) {
      bad.push(`${p.uiId}: category ${JSON.stringify(p.category)} — needs 1-32 chars of ` +
        `letters, digits, space, & / _ -, starting alphanumeric`);
    }
    if (!Number.isFinite(p.sortOrder)) {
      bad.push(`${p.uiId}: sortOrder ${JSON.stringify(p.sortOrder)} is not a number — the ` +
        `registry would default it to 100 and the pane would sort with every other default`);
    }
  }
  assert.deepStrictEqual(bad, [], `panes with unusable placement:\n  ${bad.join('\n  ')}`);
});

test('sortOrder is unique, so the rendered order is decided here and not by a tiebreak', () => {
  const panes = placedPanes();
  const byOrder = new Map<number, string[]>();
  for (const p of panes) {
    const bucket = byOrder.get(p.sortOrder);
    if (bucket) bucket.push(p.uiId); else byOrder.set(p.sortOrder, [p.uiId]);
  }
  const clashes = [...byOrder.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([order, ids]) => `${order}: ${ids.join(', ')}`);
  // A tie is not an error to the registry — it falls back to (name, ui_key) — but it means
  // the order those panes appear in was not chosen by anyone, and it changes when a pane is
  // renamed. Keep the intent in the file.
  assert.deepStrictEqual(clashes, [], `panes sharing a sortOrder:\n  ${clashes.join('\n  ')}`);
});

test('no category becomes the catch-all bucket again', () => {
  const panes = placedPanes();
  const groups = new Map<string, string[]>();
  for (const p of panes) {
    const bucket = groups.get(p.category);
    if (bucket) bucket.push(p.name); else groups.set(p.category, [p.name]);
  }
  assert.ok(groups.size >= 3,
    `only ${groups.size} group(s) across ${panes.length} panes — the sidebar is one list again`);
  const oversized = [...groups.entries()]
    .filter(([, names]) => names.length > MAX_PER_GROUP)
    .map(([cat, names]) => `"${cat}" has ${names.length}: ${names.join(', ')}`);
  assert.deepStrictEqual(oversized, [],
    `group(s) past ${MAX_PER_GROUP} entries — split them rather than raising the cap:\n  ${oversized.join('\n  ')}`);
});

test('groups do not interleave — a category owns a contiguous sortOrder range', () => {
  const panes = placedPanes().sort((a, b) => a.sortOrder - b.sortOrder);
  // The shell opens a group when it meets that category's FIRST member and never reopens it,
  // so a pane whose sortOrder falls inside another category's range is silently sorted into
  // the wrong group on screen. Walking the sorted list, each category must appear in exactly
  // one contiguous run.
  const runs: string[] = [];
  for (const p of panes) if (runs[runs.length - 1] !== p.category) runs.push(p.category);
  const reopened = runs.filter((c, i) => runs.indexOf(c) !== i);
  assert.deepStrictEqual([...new Set(reopened)], [],
    `category reopened after another group started — sortOrder ranges overlap: ${runs.join(' → ')}`);
});
