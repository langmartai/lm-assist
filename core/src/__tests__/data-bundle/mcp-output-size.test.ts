// core/src/__tests__/data-bundle/mcp-output-size.test.ts
// MEASURED output bounds for data_export / data_import.
//
// "It should be small" is not a bound. A plan over a big node can carry dozens of sections,
// each with ten sample ids per bucket and free-text warnings, and a fleet that grows keeps
// adding datasets. These tests push WORST-CASE data through the real renderers and assert
// the bytes stay under the soft per-tool budget (well under the 64 KiB hard cap), and that
// whatever a bound drops is SAID — a shortened list must never read as the whole list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-mcp-bundle-size-home-'));
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-mcp-bundle-size-data-'));

import type * as ToolsModule from '../../mcp-server/tools/data-bundle';
const T = require('../../mcp-server/tools/data-bundle') as typeof ToolsModule;
const { TOOL_OUTPUT_SOFT_BYTES, MEASURED_BUDGETS } = require('../../mcp-server/tool-output-budget') as typeof import('../../mcp-server/tool-output-budget');
const { DEFAULT_MAX_RESULT_BYTES } = require('../../mcp-server/result-cap') as typeof import('../../mcp-server/result-cap');

const B = (s: string) => Buffer.byteLength(s, 'utf8');
const LONG = (tag: string, n = 300) => `${tag}-${'x'.repeat(n)}`;
const PROSE = 'a warning that goes on and on about ownership and replicas '.repeat(40);
const BUCKETS = ['add', 'update', 'skipOlder', 'skipIdentical', 'skipExists', 'tooLarge', 'neutralized', 'skipDiffers', 'skipped', 'importedDisabled'] as const;
const SOURCE = { nodeId: LONG('gw'), hostname: LONG('host'), platform: 'linux', lmAssistVersion: '0.2.6', mode: 'prod' as const, cluster: LONG('cl') };

function counts(n: number) {
  return Object.fromEntries(BUCKETS.map((b) => [b, n])) as unknown as ToolsModule.ImportView['totals'];
}

function worstPlan(sections: number, dryRun: boolean): ToolsModule.ImportView {
  return {
    bundleId: 'lmb-20260923-180000-abcdef', policy: 'replace', dryRun, source: SOURCE,
    createdAt: '2026-09-23T18:00:00.000Z', note: PROSE,
    sections: Array.from({ length: sections }, (_, i) => ({
      kind: 'dataset' as const, id: LONG(`ds${i}`), title: LONG('title'), action: i % 3 === 0 ? 'refuse' as const : 'import' as const,
      counts: counts(123456), ...(dryRun ? {} : { applied: counts(123456), errors: Array.from({ length: 50 }, () => PROSE) }),
      samples: Object.fromEntries(BUCKETS.map((b) => [b, Array.from({ length: 10 }, (_, k) => LONG(`id${k}`, 200))])),
      warnings: Array.from({ length: 20 }, () => PROSE),
      ...(i % 3 === 0 ? { refused: { code: 'OWNER_ONLINE', reason: PROSE } } : {}),
    })),
    totals: counts(9_999_999), ...(dryRun ? {} : { applied: counts(9_999_999) }),
    refused: Math.ceil(sections / 3), warnings: Array.from({ length: 30 }, () => PROSE),
  };
}

function worstInventory(n: number): ToolsModule.InventoryView {
  return {
    node: { nodeId: LONG('gw'), hostname: LONG('host'), cluster: LONG('cl'), mode: 'prod' },
    roster: { queried: true, available: false, reason: PROSE },
    datasets: Array.from({ length: n }, (_, i) => ({
      id: LONG(`ds${i}`), title: LONG('t'), backend: 'cache', owned: i % 2 === 0, ownerNode: LONG('owner'),
      ...(i % 2 ? { origin: { machineId: LONG('m'), hostname: LONG('h') }, originOnline: null } : {}),
      supersedes: { machineId: LONG('m'), hostname: LONG('h'), at: '2026-09-23T18:00:00.000Z' },
      scope: 'fleet', syncMode: 'full', export: 'default' as const, reason: PROSE,
      records: 9_999_999, tombstones: 9_999_999, approxBytes: 9_999_999_999, error: PROSE,
    })),
    orphans: Array.from({ length: 500 }, (_, i) => ({ id: LONG(`orphan${i}`), backend: 'cache' as const, bytes: 1 << 30 })),
    sections: {
      config: Array.from({ length: 30 }, (_, i) => ({ id: LONG(`cfg${i}`), title: LONG('t'), default: true as const })),
      files: Array.from({ length: 30 }, (_, i) => ({ id: LONG(`f${i}`), title: LONG('t'), default: false as const, option: 'includeKnowledge' as const })),
    },
    neverExported: Array.from({ length: 30 }, () => PROSE),
    sync: { lastRun: '2026-09-23T17:55:00.000Z', peersChecked: 99, datasetsReplicated: 99, errors: Array.from({ length: 20 }, () => PROSE) },
    bundles: { count: 999, newest: 'lmb-20260923-180000-abcdef' },
  };
}

function worstSections(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'dataset' as const, id: LONG(`ds${i}`), title: LONG('t'), count: 9_999_999, bytes: 9_999_999_999,
    tombstones: 9_999_999, owned: false, origin: { machineId: LONG('m'), hostname: LONG('h'), os: 'linux' },
    scope: 'fleet', syncMode: 'full', backend: 'cache', warnings: Array.from({ length: 20 }, () => PROSE),
    redactedKeys: Array.from({ length: 50 }, (_, k) => LONG(`key${k}`)),
  }));
}

function assertBounded(name: string, out: string, budget = TOOL_OUTPUT_SOFT_BYTES) {
  const n = B(out);
  assert.ok(n <= budget, `${name}: ${n}B exceeds ${budget}B`);
  assert.ok(n < DEFAULT_MAX_RESULT_BYTES);
}

test('plan: 300 worst-case sections stay under the soft budget and SAY what was dropped', () => {
  const out = T.renderImport(worstPlan(300, true), { mode: 'plan' });
  assertBounded('plan', out);
  assert.match(out, /more section/i, 'rows past the cap must be counted, not silently dropped');
  assert.match(out, /datasets:\[/, 'the omission names the narrowing argument');
});

test('apply (confirmed and unconfirmed) worst case stays bounded too', () => {
  assertBounded('apply', T.renderImport(worstPlan(300, false), { mode: 'apply' }));
  const unconfirmed = T.renderImport(worstPlan(300, true), { mode: 'unconfirmed' });
  assertBounded('apply-unconfirmed', unconfirmed);
  // The banner must survive the bound at BOTH ends — it is the one line that matters.
  assert.match(unconfirmed.slice(0, 300), /NOTHING WAS WRITTEN/);
  assert.match(unconfirmed.slice(-400), /NOTHING WAS WRITTEN/);
});

test('a typical plan keeps the detail of every section (the bound is not the common case)', () => {
  const p = worstPlan(0, true);
  p.note = 'weekly';
  p.warnings = ['source: exported on src-host (gw-src), not this node'];
  for (let i = 0; i < 25; i++) {
    p.sections.push({
      kind: 'dataset', id: `ds-${i}`, action: 'import', counts: { ...counts(0), add: 3, skipIdentical: 40 },
      samples: { add: ['a1', 'a2', 'a3'] }, warnings: i % 5 === 0 ? ['foreign-owner: merged by LWW'] : [],
    });
  }
  const out = T.renderImport(p, { mode: 'plan' });
  assert.doesNotMatch(out, /omitted/i);
  for (let i = 0; i < 25; i++) assert.match(out, new RegExp(`ds-${i}\\b`));
});

test('inventory: 400 datasets + 500 orphans stay under the data_export budget, with the rest counted', () => {
  const out = T.renderInventory(worstInventory(400));
  assertBounded('inventory', out, Math.min(TOOL_OUTPUT_SOFT_BYTES, MEASURED_BUDGETS.data_export.budgetBytes));
  assert.match(out, /more dataset/i);
  assert.match(out, /more orphan/i);
});

test('create / inspect / list worst cases stay under the soft budget', () => {
  const sections = worstSections(300);
  const created: ToolsModule.ExportView = {
    bundleId: 'lmb-20260923-180000-abcdef', path: `/tmp/${'p'.repeat(2000)}`, sizeBytes: 9_999_999_999, sha256: 'f'.repeat(64),
    createdAt: '2026-09-23T18:00:00.000Z', note: PROSE, sections, totals: { entries: 9_999_999, uncompressedBytes: 9_999_999_999 },
    excluded: Array.from({ length: 300 }, (_, i) => ({ id: LONG(`x${i}`), reason: PROSE })),
    warnings: Array.from({ length: 100 }, () => PROSE), pruned: Array.from({ length: 200 }, () => 'lmb-20260923-180000-abcdef'),
    next: PROSE,
  };
  assertBounded('create', T.renderCreate(created));

  const manifest = {
    t: 'manifest' as const, format: 'lm-assist-bundle' as const, formatVersion: 1, bundleId: 'lmb-20260923-180000-abcdef',
    createdAt: '2026-09-23T18:00:00.000Z', source: SOURCE, options: { sections: ['datasets'], blob: PROSE }, sections,
    totals: { entries: 9_999_999, uncompressedBytes: 9_999_999_999 }, note: PROSE,
  };
  const inspected = T.renderInspect({ bundleId: manifest.bundleId, sizeBytes: 9_999_999_999, manifest,
    imported: { importedFrom: LONG('src'), via: 'fetch', at: '2026-09-23T18:00:00.000Z', fromNode: LONG('n'), name: LONG('name') } });
  assertBounded('inspect', inspected);
  assert.match(inspected, /more section/i);

  const listed = T.renderList(Array.from({ length: 500 }, (_, i) => ({
    bundleId: `lmb-20260923-18${String(i % 60).padStart(2, '0')}00-abcdef`, sizeBytes: 9_999_999_999, mtime: '2026-09-23T18:00:00.000Z',
    createdAt: '2026-09-23T18:00:00.000Z', source: SOURCE, note: PROSE, sections, totals: manifest.totals,
    imported: { importedFrom: LONG('src'), via: 'upload' as const, at: 'now', name: LONG('n') },
    ...(i % 7 === 0 ? { error: { code: 'BUNDLE_FORMAT', message: PROSE } } : {}),
  })));
  assertBounded('list', listed);
  assert.match(listed, /more bundle/i);
});

test('fetch / takeover / delete / errors are small by construction', () => {
  const manifest = { t: 'manifest' as const, format: 'lm-assist-bundle' as const, formatVersion: 1, bundleId: 'lmb-20260923-180000-abcdef',
    createdAt: '2026-09-23T18:00:00.000Z', source: SOURCE, options: {}, sections: worstSections(300).map((s) => ({ ...s, sha256: 'e'.repeat(64) })),
    totals: { entries: 1, uncompressedBytes: 1 }, note: PROSE };
  assertBounded('fetch', T.renderFetch({ bundleId: 'lmb-20260923-180000-abcdef', sizeBytes: 1, sha256: 'a'.repeat(64), manifest,
    imported: { importedFrom: 'x', via: 'fetch', at: 'now' }, fromNode: LONG('n'), sourceBundleId: 'lmb-20260923-180000-abcdef', chunks: 99 }), 8 * 1024);
  assertBounded('takeover', T.renderTakeover({ dataset: LONG('ds'), records: 1, tombstones: 1, superseded: { machineId: LONG('m'), hostname: LONG('h') },
    ownerNode: LONG('o'), visibility: 'cross-node-readable', forced: true, note: PROSE }), 4 * 1024);
  assertBounded('error', T.renderToolError('ORIGIN_ONLINE', PROSE.repeat(20)), 4 * 1024);
});
