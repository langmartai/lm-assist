/**
 * The shim is copied, never imported — so identity is the only thing that keeps it ONE file.
 *
 * ui-apps/<pane>/assets/lmui.js has no build step and no shared import: every pane carries
 * its own byte copy. It has already forked once (three panes sat on a generation that
 * predated `uiKey` and nobody noticed until a pane read window.__UI_KEY__ and got undefined).
 * A second fork would now cost cross-pane navigation on whichever panes missed the update.
 *
 * ui-apps/assist-backlog/assets/lmui.js is the canonical copy in this repo; fan it out with
 *   for d in ui-apps/*\/assets/lmui.js; do cp ui-apps/assist-backlog/assets/lmui.js "$d"; done
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

function repoRoot(): string {
  let d = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'ui-apps')) && fs.existsSync(path.join(d, 'package.json'))) return d;
    d = path.dirname(d);
  }
  throw new Error(`could not locate the repo root above ${__dirname}`);
}

const UI_APPS = path.join(repoRoot(), 'ui-apps');
const CANONICAL = 'assist-backlog';

function shimCopies(): Array<{ uiId: string; file: string }> {
  return fs.readdirSync(UI_APPS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ uiId: e.name, file: path.join(UI_APPS, e.name, 'assets', 'lmui.js') }))
    .filter((c) => fs.existsSync(c.file));
}

test('every pane ships the SAME lmui.js', () => {
  const copies = shimCopies();
  assert.ok(copies.length >= 2, `expected several panes, found ${copies.length}`);
  const byHash = new Map<string, string[]>();
  for (const c of copies) {
    const h = createHash('md5').update(fs.readFileSync(c.file)).digest('hex');
    byHash.set(h, [...(byHash.get(h) || []), c.uiId]);
  }
  assert.equal(
    byHash.size, 1,
    `lmui.js has forked into ${byHash.size} generations — re-sync every copy from ui-apps/${CANONICAL}:\n`
    + [...byHash].map(([h, ids]) => `  ${h}  ${ids.join(', ')}`).join('\n'),
  );
});

test('the shipped shim exposes the cross-pane navigation contract', () => {
  for (const c of shimCopies()) {
    const src = fs.readFileSync(c.file, 'utf8');
    assert.match(src, /goto: gotoPane/, `${c.uiId} does not export lmui.goto`);
    assert.match(src, /'lmui:navigate'/, `${c.uiId} does not send lmui:navigate`);
    assert.match(src, /'lmui:navigate:ack'/, `${c.uiId} does not handle the shell's ack`);
    // ROOT-relative, or <base href="/ui/<uiId>/"> resolves it into the pane's asset space.
    assert.match(src, /'\/go\/' \+ encodeURIComponent\(id\)/, `${c.uiId} does not build a root-relative /go link`);
  }
});
