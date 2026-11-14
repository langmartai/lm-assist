/**
 * Render smoke test for the /data Backup tab panels (data export/import spec, "Surfaces >
 * Web"). Static server render in the node environment — no DOM, no effects — so it checks
 * what each panel SHOWS for a given inventory / bundle list / plan: the takeover gating, the
 * refusal codes with their next steps, and the confirm-free first paint of Import.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HealthPanel } from '@/components/data/backup/HealthPanel';
import { BundlesPanel } from '@/components/data/backup/BundlesPanel';
import { ExportPanel } from '@/components/data/backup/ExportPanel';
import { ImportPanel } from '@/components/data/backup/ImportPanel';
import { PlanTable } from '@/components/data/backup/PlanTable';
import { ErrorBanner } from '@/components/data/backup/shared';
import {
  BundleApiError, createBundlesApi, nextStep,
  type ImportResult, type Inventory, type PlanCounts, type StoredBundleInfo,
} from '../data-bundles';

const api = createBundlesApi(async () => { throw new Error('no IO in a render test'); });
const noop = () => {};

function counts(p: Partial<PlanCounts> = {}): PlanCounts {
  return {
    add: 0, update: 0, skipOlder: 0, skipIdentical: 0, skipExists: 0, tooLarge: 0, neutralized: 0,
    skipDiffers: 0, skipped: 0, importedDisabled: 0, ...p,
  };
}

const INVENTORY: Inventory = {
  node: { nodeId: 'gw-self', hostname: 'node-a', cluster: 'c1', mode: 'dev' },
  roster: { queried: true, available: true, onlinePeers: 2 },
  datasets: [
    { id: 'backlog', backend: 'cache', owned: true, ownerNode: 'gw-self', scope: 'fleet', syncMode: 'full', export: 'default', records: 12, tombstones: 2, approxBytes: 4096 },
    { id: 'wf-online', backend: 'cache', owned: false, ownerNode: 'gw-b', origin: { machineId: 'gw-b', hostname: 'node-b' }, originOnline: true,
      scope: 'fleet', syncMode: 'full', export: 'opt-in', reason: 'replica', records: 3, tombstones: 0, approxBytes: 100 },
    { id: 'wf-offline', backend: 'cache', owned: false, ownerNode: 'gw-c', origin: { machineId: 'gw-c', hostname: 'node-c' }, originOnline: false,
      scope: 'fleet', syncMode: 'full', export: 'opt-in', reason: 'replica', records: 5, tombstones: 1, approxBytes: 100 },
    { id: 'wf-unknown', backend: 'cache', owned: false, ownerNode: 'gw-d', origin: { machineId: 'gw-d', hostname: 'node-d' }, originOnline: null,
      scope: 'fleet', syncMode: 'full', export: 'opt-in', reason: 'replica', records: 1, tombstones: 0, approxBytes: 100 },
    { id: 'knowledge', backend: 'knowledge', owned: true, ownerNode: 'gw-self', scope: 'node', syncMode: 'none', export: 'never', reason: 'system dataset', records: null, tombstones: null, approxBytes: null },
  ],
  orphans: [{ id: 'old-store', backend: 'cache', bytes: 2048 }],
  sections: {
    config: [{ id: 'scheduled-jobs', title: 'Scheduled jobs', default: true }],
    files: [{ id: 'knowledge', title: 'Knowledge', default: false, option: 'includeKnowledge' }],
  },
  neverExported: ['secrets: api-token*', 'derived stores'],
  sync: { lastRun: '2026-09-23T10:00:00.000Z', peersChecked: 2, datasetsReplicated: 4, errors: ['takeover x by node-b: 3 local records not yet on node-b'] },
  bundles: { count: 1, newest: 'lmb-20260923-101010-abcdef' },
};

const BUNDLES: StoredBundleInfo[] = [{
  bundleId: 'lmb-20260923-101010-abcdef', sizeBytes: 5000, mtime: '2026-09-23T10:10:10.000Z', createdAt: '2026-09-23T10:10:10.000Z',
  source: { nodeId: 'gw-b', hostname: 'node-b', platform: 'linux', lmAssistVersion: '0.2.6', mode: 'prod' },
  note: 'before upgrade',
  sections: [{ kind: 'dataset', id: 'backlog', title: 'backlog', count: 12, bytes: 1, warnings: [], owned: true }],
  totals: { entries: 13, uncompressedBytes: 9000 },
  imported: { importedFrom: 'lmb-20260922-090909-123456', via: 'fetch', at: 'x', fromNode: 'gw-b' },
}];

const PLAN: ImportResult = {
  bundleId: 'lmb-20260923-101010-abcdef', policy: 'merge', dryRun: true,
  source: { nodeId: 'gw-b', hostname: 'node-b', platform: 'linux', lmAssistVersion: '0.2.6', mode: 'prod' },
  createdAt: '2026-09-23T10:10:10.000Z',
  sections: [
    { kind: 'dataset', id: 'backlog', counts: counts({ add: 2, skipIdentical: 10 }), samples: { add: ['bl_1', 'bl_2'] }, warnings: ['foreign-owner: records from another owner are merged by LWW'], action: 'import' },
    { kind: 'dataset', id: 'missions', counts: counts(), samples: {}, warnings: [], action: 'refuse', refused: { code: 'OWNER_ONLINE', reason: 'owner node-b is online' } },
    { kind: 'config', id: 'scheduled-jobs', counts: counts({ add: 1, importedDisabled: 1 }), samples: {}, warnings: [] },
  ],
  totals: counts({ add: 3, skipIdentical: 10, importedDisabled: 1 }), refused: 1, warnings: ['source: exported on node-b'],
};

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

describe('HealthPanel', () => {
  const out = html(createElement(HealthPanel, { api, inventory: INVENTORY, loading: false, error: null, onRefresh: noop }));

  it('offers Take over only on replicas whose origin is not online', () => {
    expect(out.match(/Take over/g)?.length).toBe(2);
    expect(out).toContain('node-c');
    expect(out).toContain('The roster is unavailable — takeover will need force');
  });

  it('shows ownership, counts, reconcile errors, orphans and the never-exported list', () => {
    expect(out).toContain('owned');
    expect(out).toContain('replica');
    expect(out).toContain('takeover x by node-b');
    expect(out).toContain('old-store');
    expect(out).toContain('secrets: api-token*');
    expect(out).toContain('system dataset');
  });

  it('without an inventory it shows the coded error', () => {
    const e = html(createElement(HealthPanel, { api, inventory: null, loading: false, error: new BundleApiError('ROSTER_UNAVAILABLE', 'hub down', 409), onRefresh: noop }));
    expect(e).toContain('ROSTER_UNAVAILABLE');
    expect(e).toContain('hub down');
  });
});

describe('BundlesPanel', () => {
  it('lists bundles with source, contents and actions; copy is blocked without the hub', () => {
    const out = html(createElement(BundlesPanel, {
      api, apiFor: () => api, bundles: BUNDLES, loading: false, error: null, onRefresh: noop, nodeLabel: 'node-a',
      selfNodeId: 'gw-self', peers: [], crossNode: false, onPlan: noop,
    }));
    expect(out).toContain('lmb-20260923-101010-abcdef');
    expect(out).toContain('before upgrade');
    expect(out).toContain('node-b');
    expect(out).toContain('fetch from gw-b');
    expect(out).toContain('Plan import');
    expect(out).toContain('Reaching another node needs the hub connection');
  });
});

describe('ExportPanel', () => {
  it('datasets and config are on by default; the opt-ins are off', () => {
    const out = html(createElement(ExportPanel, { api, inventory: INVENTORY, nodeLabel: 'node-a', onCreated: noop, onPlan: noop }));
    expect(out).toContain('Create a bundle on node-a');
    expect(out.match(/<input[^>]*type="checkbox"[^>]*>/g)?.filter((t) => t.includes('checked=""')).length).toBe(2);
    expect(out).toContain('3 read-only replicas');
  });
});

describe('ImportPanel', () => {
  it('first paint writes nothing and offers the three sources', () => {
    const out = html(createElement(ImportPanel, {
      api, apiFor: () => api, bundles: BUNDLES, bundleId: null, onSelectBundle: noop, onBundlesChanged: noop, onApplied: noop,
      nodeLabel: 'node-a', peers: [], crossNode: true,
    }));
    expect(out).toContain('Import into node-a');
    expect(out).toContain('Stored bundle');
    expect(out).toContain('Upload file');
    expect(out).toContain('Fetch from node');
    expect(out).not.toContain('Apply…');
  });
});

describe('PlanTable', () => {
  it('renders counts, refusals with their next step, warnings and totals', () => {
    const out = html(createElement(PlanTable, { result: PLAN }));
    expect(out).toContain('2 add');
    expect(out).toContain('10 skip (identical)');
    expect(out).toContain('OWNER_ONLINE');
    expect(out).toContain('owner node-b is online');
    expect(out).toContain(nextStep('OWNER_ONLINE')!.slice(0, 40));
    expect(out).toContain('foreign-owner');
    expect(out).toContain('1 refused');
    expect(out).toContain('source: exported on node-b');
  });

  it('an apply result shows what was written', () => {
    const out = html(createElement(PlanTable, { result: { ...PLAN, dryRun: false, applied: counts({ add: 3 }), sections: PLAN.sections.map((s) => ({ ...s, applied: counts({ add: s.counts.add }) })) } }));
    expect(out).toContain('written:');
    expect(out).toContain('3 add');
  });
});

describe('ErrorBanner', () => {
  it('shows code, message, the numbers and a next step', () => {
    const out = html(createElement(ErrorBanner, { error: new BundleApiError('DISK_LOW', 'not enough space', 507, { freeBytes: 1024, requiredBytes: 4096 }) }));
    expect(out).toContain('DISK_LOW');
    expect(out).toContain('not enough space');
    expect(out).toContain('free 1.0 KB · needs 4.0 KB');
    expect(out).toContain('Free disk space');
  });
});
