import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lmb-cfg-home-'));
process.env.HOME = HOME;
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lmb-cfg-data-'));
delete process.env.LM_MACHINE_ACCESS_FILE;
import { ScheduledJobs } from '../../scheduler/scheduled-jobs';
import {
  createScheduledJobsProvider, createMachineAccessProvider, createProjectSettingsProvider,
  createMcpAccessProvider, createMcpProfileProvider, createConfigProviders, mcpAccessPath, projectSettingsPath,
  type ScheduledJobsData,
} from '../../data/bundle/sections/config';
import { stripSecretKeys } from '../../data/bundle/sections/types';
import { machineAccessPath } from '../../machine-access/store';

const tmp = (p = 'lmb-cfg-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A fresh scheduler store in its own data dir (jobsFilePath reads the env per call). */
function freshJobs(): ScheduledJobs {
  process.env.LM_ASSIST_DATA_DIR = tmp('lmb-cfg-data-');
  return new ScheduledJobs();
}

test('default paths stay inside the sandboxed HOME / data dir', () => {
  assert.ok(mcpAccessPath().startsWith(HOME + path.sep), mcpAccessPath());
  assert.ok(mcpAccessPath().endsWith('mcp-access-dev.json'));
  assert.ok(machineAccessPath().startsWith(HOME + path.sep), machineAccessPath());
  assert.ok(projectSettingsPath().startsWith(process.env.LM_ASSIST_DATA_DIR!));
  assert.deepEqual(createConfigProviders().map((p) => p.id),
    ['scheduled-jobs', 'machine-access', 'project-settings', 'mcp-access', 'mcp-profile']);
});

test('stripSecretKeys drops secret-named keys at any depth and reports dotted paths', () => {
  const { value, redactedKeys } = stripSecretKeys({
    a: 1, apiKey: 'x', nested: { GITHUB_TOKEN: 'y', ok: true, list: [{ password: 'p', keep: 1 }] }, 'private-key': 'k',
  });
  assert.deepEqual(value, { a: 1, nested: { ok: true, list: [{ keep: 1 }] } });
  assert.deepEqual(redactedKeys.sort(), ['apiKey', 'nested.GITHUB_TOKEN', 'nested.list.0.password', 'private-key']);
});

test('scheduled-jobs: collect strips run state + secrets; custom in full, builtin overrides only', async () => {
  const jobs = freshJobs();
  jobs.upsertJob({ id: 'nightly', type: 'shell', enabled: true, intervalMinutes: 60, config: { command: 'echo hi', env: { API_TOKEN: 's' } } });
  // simulate run state on the custom job
  (jobs as any).jobs.set('nightly', { ...(jobs as any).jobs.get('nightly'), lastRunAt: 'x', lastResult: 'ok', lastStatus: 'ok', runLog: [{}], runCount: 4, lastRun: {} });
  const p = createScheduledJobsProvider({ jobs: () => jobs });
  const c = await p.collect();
  const data = c.data as ScheduledJobsData;
  assert.equal(data.custom.length, 1);
  const j = data.custom[0] as any;
  assert.equal(j.id, 'nightly');
  assert.equal(j.config.command, 'echo hi');
  assert.equal(j.config.env.API_TOKEN, undefined);
  for (const k of ['lastRunAt', 'lastResult', 'lastStatus', 'runLog', 'runCount', 'lastRun', 'nextRunAt', 'isRunning', 'disabledByEnv', 'builtin']) {
    assert.equal(k in j, false, `${k} must be stripped`);
  }
  assert.deepEqual(c.redactedKeys, ['custom.nightly.config.env.API_TOKEN']);
  assert.ok(data.builtins.length >= 1);
  for (const b of data.builtins) assert.deepEqual(Object.keys(b).sort(), ['config', 'enabled', 'id', 'intervalMinutes']);
});

test('scheduled-jobs: imported custom jobs land DISABLED; existing kept unless replace; builtins only in replace', async () => {
  const src = freshJobs();
  src.upsertJob({ id: 'a-new', type: 'shell', enabled: true, intervalMinutes: 30, config: { command: 'echo a' } });
  src.upsertJob({ id: 'b-exists', type: 'shell', enabled: true, intervalMinutes: 30, config: { command: 'echo NEW' } });
  src.upsertJob({ id: 'stall-monitor', intervalMinutes: 99 }); // builtin override
  const data = (await createScheduledJobsProvider({ jobs: () => src }).collect()).data;

  const dst = freshJobs();
  dst.upsertJob({ id: 'b-exists', type: 'shell', enabled: true, intervalMinutes: 30, config: { command: 'echo OLD', runIf: 'true' } });
  const p = createScheduledJobsProvider({ jobs: () => dst });

  const plan = await p.plan(data, 'merge');
  assert.equal(plan.counts.add, 1);
  assert.equal(plan.counts.importedDisabled, 1);
  assert.equal(plan.counts.skipExists, 1);
  assert.ok(plan.counts.skipped >= 1, 'builtin override gated');
  assert.ok(plan.warnings.some((w) => /replace/.test(w)));
  assert.equal(dst.getJob('a-new'), null, 'plan never writes');

  const res = await p.apply(data, 'merge');
  assert.equal(res.applied.add, 1);
  assert.equal(res.applied.importedDisabled, 1);
  const a = dst.getJob('a-new')!;
  assert.equal(a.enabled, false, 'imported custom job must be disabled');
  assert.equal(a.config.command, 'echo a');
  assert.equal(dst.getJob('b-exists')!.config.command, 'echo OLD');
  assert.equal(dst.getJob('stall-monitor')!.intervalMinutes, 5);

  // Persisted through the scheduler's own store.
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.LM_ASSIST_DATA_DIR!, 'scheduled-jobs-dev.json'), 'utf8'));
  assert.equal(onDisk.find((x: any) => x.id === 'a-new').enabled, false);

  const rep = await p.apply(data, 'replace');
  assert.equal(rep.applied.update, 2); // b-exists + stall-monitor
  const b = dst.getJob('b-exists')!;
  assert.equal(b.config.command, 'echo NEW');
  assert.equal(b.config.runIf, undefined, 'replace overwrites config, no stale keys');
  assert.equal(b.enabled, false);
  assert.equal(dst.getJob('stall-monitor')!.intervalMinutes, 99);
  assert.equal(dst.getJob('stall-monitor')!.builtin, true);

  // Idempotent: a second replace is all identical.
  const again = await p.plan(data, 'replace');
  assert.equal(again.counts.add + again.counts.update, 0);
});

test('scheduled-jobs: a custom job colliding with a builtin id, bad shapes, unknown builtins', async () => {
  const dst = freshJobs();
  const p = createScheduledJobsProvider({ jobs: () => dst });
  const plan = await p.plan({
    custom: [{ id: 'stall-monitor', type: 'shell', config: {} }, { nope: 1 }],
    builtins: [{ id: 'not-a-builtin', enabled: true, intervalMinutes: 1, config: {} }],
  }, 'replace');
  assert.equal(plan.counts.add + plan.counts.update, 0);
  assert.equal(plan.counts.skipped, 3);
  const bad = await p.apply({ nope: true }, 'merge');
  assert.equal(bad.refused?.code, 'BAD_SECTION_DATA');
});

test('machine-access: add absent, keep existing unless replace, key-missing warning, lastCheck stripped', async () => {
  const dir = tmp();
  const srcFile = path.join(dir, 'src.json');
  const dstFile = path.join(dir, 'dst.json');
  const keyPath = path.join(dir, 'id_test');
  fs.writeFileSync(keyPath, 'not really a key');
  fs.writeFileSync(srcFile, JSON.stringify({ version: 1, machines: [
    { id: 'box-a', name: 'Box A', access: [{ type: 'ssh', host: 'box-a.example', user: 'u', identityFile: keyPath }], lastCheck: { status: 'ok', at: 'x' } },
    { id: 'box-b', name: 'Box B v2', access: [{ type: 'ssh', host: 'box-b.example', user: 'u', identityFile: '~/.ssh/definitely-missing-key' }] },
  ] }));
  fs.writeFileSync(dstFile, JSON.stringify({ version: 1, machines: [
    { id: 'box-b', name: 'Box B v1', access: [{ type: 'ssh', host: 'box-b.example', user: 'u' }] },
  ] }));
  const data = (await createMachineAccessProvider({ file: srcFile }).collect()).data as any;
  assert.equal(data.machines[0].lastCheck, undefined);

  const p = createMachineAccessProvider({ file: dstFile });
  const plan = await p.plan(data, 'merge');
  assert.deepEqual([plan.counts.add, plan.counts.skipExists], [1, 1]);
  assert.equal(plan.warnings.filter((w) => w.startsWith('key-missing')).length, 0, 'box-a key exists; box-b not written');
  const res = await p.apply(data, 'add-missing');
  assert.equal(res.applied.add, 1);
  const after = JSON.parse(fs.readFileSync(dstFile, 'utf8')).machines;
  assert.deepEqual(after.map((m: any) => m.id).sort(), ['box-a', 'box-b']);
  assert.equal(after.find((m: any) => m.id === 'box-b').name, 'Box B v1');

  const rep = await p.apply(data, 'replace');
  assert.equal(rep.applied.update, 1);
  assert.ok(rep.warnings.some((w) => w.startsWith('key-missing: box-b')), rep.warnings.join('\n'));
  assert.equal(JSON.parse(fs.readFileSync(dstFile, 'utf8')).machines.find((m: any) => m.id === 'box-b').name, 'Box B v2');
  assert.equal(fs.statSync(dstFile).mode & 0o777, 0o600);

  const invalid = await p.plan({ machines: [{ id: 'BAD ID', name: 'x', access: [] }] }, 'merge');
  assert.equal(invalid.counts.skipped, 1);
});

test('project-settings: add absent keys, differing reported not applied unless replace; never-flip + node-bound', async () => {
  const dir = tmp();
  const srcFile = path.join(dir, 'src.json');
  const dstFile = path.join(dir, 'dst.json');
  fs.writeFileSync(srcFile, JSON.stringify({
    excludedPaths: ['/a'], dataReconcileSec: 600, devModeEnabled: true, someApiKey: 'x',
    dataServiceEnabled: true, busEnabled: true, bundleRetention: 5, fabricEnabled: false,
  }));
  fs.writeFileSync(dstFile, JSON.stringify({ excludedPaths: ['/b'], dataServiceEnabled: false, busEnabled: true, fabricEnabled: false, localOnly: 1 }));

  const c = await createProjectSettingsProvider({ file: srcFile }).collect();
  const data = c.data as Record<string, unknown>;
  assert.equal('devModeEnabled' in data, false);
  assert.equal('someApiKey' in data, false);
  assert.deepEqual(c.redactedKeys, ['someApiKey']);
  assert.ok(c.warnings.some((w) => /devModeEnabled/.test(w)));

  const p = createProjectSettingsProvider({ file: dstFile });
  // A hand-crafted bundle carrying node-bound keys is refused on import too.
  const plan = await p.plan({ ...data, devModeEnabled: true }, 'merge');
  // A key ABSENT locally is its DEFAULT, not "unset": dataReconcileSec (default 300 ≠ 600)
  // differs like a present key does — merge never overrides a fresh node's defaults.
  assert.equal(plan.counts.add, 0, JSON.stringify(plan.samples));
  assert.equal(plan.counts.skipDiffers, 2); // excludedPaths, dataReconcileSec
  assert.equal(plan.counts.skipIdentical, 2); // busEnabled, fabricEnabled
  assert.ok(plan.warnings.some((w) => /dataServiceEnabled/.test(w) && /never flipped/.test(w)));
  assert.ok(plan.warnings.some((w) => /devModeEnabled/.test(w)));
  assert.ok(plan.warnings.some((w) => /bundleRetention/.test(w) && /never lowered/.test(w)), 'retention 5 < default 20 is never imported');

  const res = await p.apply(data, 'merge');
  assert.equal(res.applied.add + res.applied.update, 0);
  let after = JSON.parse(fs.readFileSync(dstFile, 'utf8'));
  assert.deepEqual(after.excludedPaths, ['/b']);
  assert.equal('dataReconcileSec' in after, false);

  const rep = await p.apply(data, 'replace');
  assert.equal(rep.applied.update, 1); // excludedPaths
  assert.equal(rep.applied.add, 1); // dataReconcileSec
  assert.ok(rep.warnings.some((w) => w === 'setting "dataReconcileSec": 300 → 600'), rep.warnings.join('\n'));
  after = JSON.parse(fs.readFileSync(dstFile, 'utf8'));
  assert.deepEqual(after.excludedPaths, ['/a']);
  assert.equal(after.dataReconcileSec, 600);
  assert.equal('bundleRetention' in after, false, 'retention never lowered, even in replace');
  assert.equal(after.dataServiceEnabled, false, 'never flipped, even in replace');
  assert.equal(after.localOnly, 1, 'keys absent from the bundle are never touched');
  assert.equal('devModeEnabled' in after, false);

  // A never-flip key ABSENT locally compares against the default (false): importing true is refused.
  const fresh = path.join(dir, 'fresh.json');
  const pf = createProjectSettingsProvider({ file: fresh });
  const r2 = await pf.apply({ dataSyncViaFabric: true, busEnabled: true }, 'replace');
  assert.equal(r2.counts.skipped, 1);
  assert.equal(r2.counts.skipIdentical, 1);
  assert.equal(fs.existsSync(fresh), false, 'nothing to write');
});

test('mcp-access: add-missing unions gated tools; replace overwrites', async () => {
  const dir = tmp();
  const f = path.join(dir, 'mcp-access.json');
  fs.writeFileSync(f, JSON.stringify({ version: 2, adminGatedTools: ['a', 'b'] }));
  const p = createMcpAccessProvider({ file: f });
  const data = { version: 2, adminGatedTools: ['b', 'c'] };
  const plan = await p.plan(data, 'merge');
  assert.deepEqual([plan.counts.add, plan.counts.skipIdentical, plan.counts.skipExists], [1, 1, 1]);
  await p.apply(data, 'add-missing');
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).adminGatedTools, ['a', 'b', 'c']);
  // replace NEVER removes a gate (a gate only adds a confirmation step): 'a' stays gated.
  const rep = await p.apply(data, 'replace');
  assert.equal(rep.counts.update, 0);
  assert.equal(rep.counts.skipExists, 1);
  assert.ok(rep.warnings.some((w) => /never removes a gate/.test(w) && /\ba\b/.test(w)));
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).adminGatedTools.sort(), ['a', 'b', 'c']);
  const same = await p.apply(data, 'replace');
  assert.equal(same.applied.add + same.applied.update, 0);
  const c = await p.collect();
  assert.deepEqual(c.data, { version: 2, adminGatedTools: ['a', 'b', 'c'] });
});

test('mcp-profile: applies only in replace, unknown profile refused, via the owning module', async () => {
  process.env.LM_ASSIST_DATA_DIR = tmp('lmb-cfg-data-');
  const p = createMcpProfileProvider();
  const c = await p.collect();
  assert.equal((c.data as any).profile, 'admin'); // the default when no state file
  const merge = await p.apply({ profile: 'basic' }, 'merge');
  assert.equal(merge.counts.skipped, 1);
  assert.equal(merge.applied.update, 0);
  assert.equal(fs.existsSync(path.join(process.env.LM_ASSIST_DATA_DIR!, 'mcp-profile-dev.json')), false);
  const unknown = await p.apply({ profile: 'no-such-profile' }, 'replace');
  assert.equal(unknown.counts.skipped, 1);
  const { currentToolsRev } = await import('../../mcp-server/registry/tools-rev');
  const revBefore = currentToolsRev();
  const rep = await p.apply({ profile: 'basic' }, 'replace');
  assert.equal(rep.applied.update, 1);
  assert.notEqual(currentToolsRev(), revBefore, 'connected MCP clients are told the tool list changed');
  assert.ok(rep.warnings.some((w) => /refresh_connector_tools/.test(w)));
  const state = JSON.parse(fs.readFileSync(path.join(process.env.LM_ASSIST_DATA_DIR!, 'mcp-profile-dev.json'), 'utf8'));
  assert.equal(state.profile, 'basic');
  assert.equal(state.setBy, 'import');
  assert.equal((await p.plan({ profile: 'basic' }, 'replace')).counts.skipIdentical, 1);
});

test('project-settings: fabric toggles are never flipped, unknown keys skipped, live side effects run', async () => {
  const dir = tmp();
  const fresh = path.join(dir, 'fresh.json');   // a fresh / rebuilt node: no file at all
  const seen: Array<[Record<string, unknown>, Record<string, unknown>]> = [];
  const p = createProjectSettingsProvider({ file: fresh, onApplied: (a, b) => seen.push([a, b]) });
  const data = { fabricRpcEnabled: true, fabricEnabled: false, missionRelayedSpawnEnabled: true, bundleRetention: 1, dataReconcileSec: 300, notASetting: 1, memorySyncEnabled: false };
  const plan = await p.plan(data, 'merge');
  for (const k of ['fabricRpcEnabled', 'fabricEnabled', 'missionRelayedSpawnEnabled']) {
    assert.ok(plan.warnings.some((w) => w.startsWith(`"${k}" is never flipped`)), `${k}: ${plan.warnings.join('\n')}`);
  }
  assert.ok(plan.warnings.some((w) => /bundleRetention/.test(w) && /never lowered/.test(w)));
  assert.ok(plan.warnings.some((w) => /unknown setting "notASetting"/.test(w)));
  assert.equal(plan.counts.skipIdentical, 1, 'dataReconcileSec equals the default');
  assert.equal(plan.counts.skipDiffers, 1, 'memorySyncEnabled differs from the default');
  const rep = await p.apply(data, 'replace');
  assert.equal(rep.applied.add, 1);
  const after = JSON.parse(fs.readFileSync(fresh, 'utf8'));
  assert.deepEqual(Object.keys(after), ['memorySyncEnabled']);
  assert.equal(seen.length, 1, 'the live side effects run once per apply');
  assert.equal(seen[0][0].memorySyncEnabled, true);
  assert.equal(seen[0][1].memorySyncEnabled, false);
});

test('scheduled-jobs: a builtin override never sets runIf/ids, never arms a job, and says what it changes', async () => {
  const dst = freshJobs();
  const cur = dst.getJob('executor-reaper')!;
  assert.equal(cur.enabled, false);
  const p = createScheduledJobsProvider({ jobs: () => dst });
  const data = { custom: [], builtins: [
    { id: 'executor-reaper', enabled: true, intervalMinutes: cur.intervalMinutes + 1, config: { ...cur.config, dryRun: false, runIf: 'touch /tmp/should-never-exist' } },
  ] };
  const plan = await p.plan(data, 'replace');
  assert.ok(plan.warnings.some((w) => /config key "runIf" is never imported/.test(w)), plan.warnings.join('\n'));
  assert.ok(plan.warnings.some((w) => /not armed by import/.test(w) && /enabled/.test(w) && /dryRun/.test(w)));
  assert.ok(plan.warnings.some((w) => /override: intervalMinutes/.test(w)));
  await p.apply(data, 'replace');
  const after = dst.getJob('executor-reaper')!;
  assert.equal(after.enabled, false, 'never enabled by an import');
  assert.notEqual(after.config.dryRun, false, 'never disarmed by an import');
  assert.equal(after.config.runIf, undefined, 'a shell guard never lands');
  assert.equal(after.intervalMinutes, cur.intervalMinutes + 1, 'the harmless part still applies');
});

test('scheduled-jobs + machine-access: a replace of an UNCHANGED item keeps its secrets and is identical', async () => {
  const jobs = freshJobs();
  jobs.upsertJob({ id: 'j1', type: 'shell', enabled: true, intervalMinutes: 60, config: { command: 'x', apiKey: 'S3CRET' } });
  (jobs as any).jobs.set('j1', { ...(jobs as any).jobs.get('j1'), runCount: 5 });
  const p = createScheduledJobsProvider({ jobs: () => jobs });
  const data = (await p.collect()).data as ScheduledJobsData;
  const plan = await p.plan(data, 'replace');
  assert.equal(plan.counts.update, 0, 'masked compare: the redacted bundle copy is the same job');
  assert.ok(plan.samples.skipIdentical?.includes('j1'));
  await p.apply(data, 'replace');
  const j = jobs.getJob('j1')!;
  assert.equal(j.config.apiKey, 'S3CRET');
  assert.equal(j.enabled, true, 'not disarmed');
  // A real change carries the secret over and keeps run state.
  const changed = { ...data, custom: [{ ...data.custom[0], config: { command: 'y' } }] };
  await p.apply(changed, 'replace');
  const j2 = jobs.getJob('j1')!;
  assert.equal(j2.config.command, 'y');
  assert.equal(j2.config.apiKey, 'S3CRET', 'the local secret survives a replace');
  assert.equal((j2 as any).runCount, 5, 'run state kept (updated in place)');
  assert.equal(j2.enabled, false, 'a changed job still lands disabled');

  const dir = tmp();
  const f = path.join(dir, 'ma.json');
  fs.writeFileSync(f, JSON.stringify({ version: 1, machines: [
    { id: 'box', name: 'Box', access: [{ type: 'ssh', host: 'h', user: 'u' }], passwordFile: '/secret/pw' },
  ] }));
  const ma = createMachineAccessProvider({ file: f });
  const md = (await ma.collect()).data as any;
  assert.equal(md.machines[0].passwordFile, undefined, 'stripped on export');
  assert.equal((await ma.plan(md, 'replace')).counts.skipIdentical, 1);
  await ma.apply({ machines: [{ ...md.machines[0], name: 'Box 2' }] }, 'replace');
  const saved = JSON.parse(fs.readFileSync(f, 'utf8')).machines[0];
  assert.equal(saved.name, 'Box 2');
  assert.equal(saved.passwordFile, '/secret/pw', 'the local secret-named field is carried over');
  const baks = fs.readdirSync(dir).filter((n) => n.startsWith('ma.json.bak-import-'));
  assert.equal(baks.length, 1, 'one pre-import snapshot');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, baks[0]), 'utf8')).machines[0].name, 'Box');
});

test('scheduled-jobs: inline credentials in a custom job\'s command are redacted on export', async () => {
  const jobs = freshJobs();
  jobs.upsertJob({ id: 'dump', type: 'shell', enabled: false, intervalMinutes: 60, config: { command: 'PGPASSWORD=hunter2 pg_dump db; curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" https://u:pw@example.com/x' } });
  const c = await createScheduledJobsProvider({ jobs: () => jobs }).collect();
  const cmd = (c.data as ScheduledJobsData).custom[0].config.command as string;
  assert.ok(!/hunter2|abcdefghijklmnop|u:pw@/.test(cmd), cmd);
  assert.ok(c.redactedKeys.includes('custom.dump.config.command (value)'));
});
