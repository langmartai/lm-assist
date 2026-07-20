/**
 * The aggregator: namespacing, lazy spawn, manifest-authoritative reconciliation,
 * health quarantine, audit and the kill switch (contract §2, §3.3, §5, §8).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAggregator, type AggregatorOptions, type PluginAggregator } from '../mcp-server/plugins/aggregator';
import { writeState } from '../mcp-server/plugins/state-store';
import { payloadChecksum, manifestDigest } from '../mcp-server/plugins/checksum';
import { readPluginAudit } from '../mcp-server/plugins/audit';

const SERVER_OK = `
  const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
  const MARK=process.env.LM_PLUGIN_SCRATCH_DIR+'/SPAWNED';
  require('fs').writeFileSync(MARK,'1');
  const TOOLS=[{name:'alpha',description:'a',inputSchema:{type:'object'}},
               {name:'beta',description:'b',inputSchema:{type:'object'}}];
  let buf='';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i).trim();buf=buf.slice(i+1);if(l)go(JSON.parse(l));}});
  process.stdin.on('end',()=>process.exit(0));
  function go(m){
    if(m.id===undefined)return;
    if(m.method==='initialize')return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'p',version:'1.0.0'}}});
    if(m.method==='tools/list')return send({jsonrpc:'2.0',id:m.id,result:{tools:TOOLS}});
    if(m.method==='tools/call')return send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'LOCALNAME='+m.params.name}]}});
  }`;

/** advertises an undeclared tool and omits a declared one */
const SERVER_DRIFT = `
  const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
  const TOOLS=[{name:'secret_backdoor',description:'x',inputSchema:{type:'object'}}];
  let buf='';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i).trim();buf=buf.slice(i+1);if(l)go(JSON.parse(l));}});
  function go(m){
    if(m.id===undefined)return;
    if(m.method==='initialize')return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'p',version:'1.0.0'}}});
    if(m.method==='tools/list')return send({jsonrpc:'2.0',id:m.id,result:{tools:TOOLS}});
    if(m.method==='tools/call')return send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'ran '+m.params.name}]}});
  }`;

/** never answers a tools/call, and ignores SIGTERM to force the kill escalation */
const SERVER_HANG = `
  const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
  let buf='';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i).trim();buf=buf.slice(i+1);if(l)go(JSON.parse(l));}});
  function go(m){
    if(m.id===undefined)return;
    if(m.method==='initialize')return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'p',version:'1.0.0'}}});
    if(m.method==='tools/list')return send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'alpha',description:'a',inputSchema:{type:'object'}}]}});
  }
  process.on('SIGTERM',()=>{});`;

// Safety net: a FAILING test must never leave a live child holding the runner's event
// loop open (that is exactly how a suite turns into a mystery hang).
const cleanups: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } }
});

function mkAgg(opts: AggregatorOptions): PluginAggregator {
  const agg = createAggregator(opts);
  cleanups.push(() => agg.shutdown().catch(() => undefined));
  return agg;
}

function setup(server = SERVER_OK, tools = ['alpha', 'beta']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-agg-'));
  const pluginsDir = path.join(root, 'plugins');
  const dir = path.join(pluginsDir, 'demo');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'server.js'), server);
  const manifest = {
    manifestVersion: 1, name: 'demo', version: '1.0.0', description: 'demo', author: 'test',
    entry: { command: 'node', args: ['dist/server.js'] },
    tools: tools.map((t) => ({ name: t, description: `tool ${t}`, inputSchema: { type: 'object' } })),
    capabilities: { network: [], fs: [], env: [] },
    checksum: 'sha256:' + '0'.repeat(64),
  };
  fs.writeFileSync(path.join(dir, 'mcp-plugin.json'), JSON.stringify(manifest, null, 2));
  const opts = {
    dir: pluginsDir,
    stateFile: path.join(root, 'state.json'),
    auditFile: path.join(root, 'audit.jsonl'),
    scratchRoot: path.join(root, 'scratch'),
  };
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir, opts };
}

function enable(dir: string, opts: { stateFile: string }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'mcp-plugin.json'), 'utf8'));
  writeState('demo', {
    enabled: true,
    approvedPayloadChecksum: payloadChecksum(dir),
    approvedManifestDigest: manifestDigest(manifest),
  }, opts.stateFile);
}

const spawned = (opts: { scratchRoot: string }) => fs.existsSync(path.join(opts.scratchRoot, 'demo', 'SPAWNED'));

test('a disabled plugin advertises nothing and cannot be called', async () => {
  const { root, opts } = setup();
  const agg = mkAgg(opts);
  assert.deepEqual(await agg.listToolDefs(), []);
  const res = await agg.call('ext__demo__alpha', {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /disabled|not enabled/i);
  assert.equal(spawned(opts), false, 'a refused call must never spawn');
  await agg.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test('listing an ENABLED plugin\'s tools still does not spawn it (discovery != execution)', async () => {
  const { root, dir, opts } = setup();
  enable(dir, opts);
  const agg = mkAgg(opts);
  const defs = await agg.listToolDefs();
  assert.deepEqual(defs.map((d) => d.name).sort(), ['ext__demo__alpha', 'ext__demo__beta']);
  assert.equal(spawned(opts), false, 'tools/list must be served from the MANIFEST, never by spawning');
  await agg.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test('advertised defs carry the MANIFEST description/schema and the namespaced name', async () => {
  const { root, dir, opts } = setup();
  enable(dir, opts);
  const agg = mkAgg(opts);
  const alpha = (await agg.listToolDefs()).find((d) => d.name === 'ext__demo__alpha')!;
  assert.equal(alpha.description, 'tool alpha');
  assert.deepEqual(alpha.inputSchema, { type: 'object' });
  await agg.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test('first call spawns lazily and the plugin receives the LOCAL (unprefixed) name', async () => {
  const { root, dir, opts } = setup();
  enable(dir, opts);
  const agg = mkAgg(opts);
  assert.equal(spawned(opts), false);
  const res = await agg.call('ext__demo__alpha', { x: 1 });
  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].text, 'LOCALNAME=alpha', 'the prefix must be stripped before forwarding');
  assert.equal(spawned(opts), true, 'the call should have spawned the subprocess');
  await agg.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test('one process serves many calls (no per-call spawn storm)', async () => {
  const { root, dir, opts } = setup();
  enable(dir, opts);
  const agg = mkAgg(opts);
  await Promise.all([agg.call('ext__demo__alpha', {}), agg.call('ext__demo__beta', {}), agg.call('ext__demo__alpha', {})]);
  assert.equal(agg.status().find((s) => s.name === 'demo')!.processes, 1);
  await agg.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a runtime-only tool is NEVER exposed and NEVER callable (manifest is authoritative)', async () => {
  const { root, dir, opts } = setup(SERVER_DRIFT, ['alpha']);
  enable(dir, opts);
  const agg = mkAgg(opts);
  const names = (await agg.listToolDefs()).map((d) => d.name);
  assert.deepEqual(names, ['ext__demo__alpha'], 'only manifest tools may be advertised');
  const res = await agg.call('ext__demo__secret_backdoor', {});
  assert.equal(res.isError, true, 'an undeclared tool must be refused before it reaches the plugin');
  assert.match(res.content[0].text, /not declared|unknown|manifest/i);
  await agg.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a manifest tool missing at runtime fails clearly and trips unhealthy', async () => {
  const { root, dir, opts } = setup(SERVER_DRIFT, ['alpha']);
  enable(dir, opts);
  const agg = mkAgg(opts);
  const res = await agg.call('ext__demo__alpha', {});
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  assert.match(text, /alpha/, 'names the tool that could not be reconciled');
  assert.match(text, /demo/, 'names the plugin');
  assert.match(text, /not (made|provide)|does not provide/i, 'says the call did not happen');
  const st = agg.status().find((s) => s.name === 'demo')!;
  assert.ok(st.health.failures > 0, 'reconciliation failure must count against health');
  await agg.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test('LM_MCP_PLUGINS=0 disables the whole subsystem', async () => {
  const { root, dir, opts } = setup();
  enable(dir, opts);
  const prev = process.env.LM_MCP_PLUGINS;
  process.env.LM_MCP_PLUGINS = '0';
  try {
    const agg = mkAgg(opts);
    assert.deepEqual(await agg.listToolDefs(), [], 'kill switch must hide every plugin tool');
    const res = await agg.call('ext__demo__alpha', {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /disabled|kill switch|LM_MCP_PLUGINS/i);
    assert.equal(spawned(opts), false, 'kill switch must prevent any spawn');
    await agg.shutdown();
  } finally {
    if (prev === undefined) delete process.env.LM_MCP_PLUGINS; else process.env.LM_MCP_PLUGINS = prev;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('a non-namespaced or unknown-plugin name is refused', async () => {
  const { root, opts } = setup();
  const agg = mkAgg(opts);
  assert.equal((await agg.call('search', {})).isError, true);
  assert.equal((await agg.call('ext__nosuch__tool', {})).isError, true);
  await agg.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test('every call is audited with an ARG DIGEST — never the argument values', async () => {
  const { root, dir, opts } = setup();
  enable(dir, opts);
  const agg = mkAgg(opts);
  await agg.call('ext__demo__alpha', { apiKey: 'super-secret-value', instrument: 'EUR_USD' });
  await agg.shutdown();

  const raw = fs.readFileSync(opts.auditFile, 'utf8');
  assert.ok(!raw.includes('super-secret-value'), 'AUDIT LEAK: argument values were journaled verbatim');
  assert.ok(!raw.includes('EUR_USD'), 'AUDIT LEAK: argument values were journaled verbatim');

  const entries = readPluginAudit({ auditFile: opts.auditFile });
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.plugin, 'demo');
  assert.equal(e.tool, 'alpha');
  assert.match(e.argDigest, /^[a-f0-9]{8,}$/);
  assert.equal(typeof e.durationMs, 'number');
  assert.equal(e.outcome, 'ok');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a refused call is audited too (auditing is not limited to successes)', async () => {
  const { root, opts } = setup();
  const agg = mkAgg(opts);
  await agg.call('ext__demo__alpha', {});   // disabled
  await agg.shutdown();
  const entries = readPluginAudit({ auditFile: opts.auditFile });
  assert.equal(entries.length, 1);
  assert.notEqual(entries[0].outcome, 'ok');
  fs.rmSync(root, { recursive: true, force: true });
});

test('status() exposes what the /mcp-tools page needs', async () => {
  const { root, dir, opts } = setup();
  enable(dir, opts);
  const agg = mkAgg(opts);
  const st = agg.status().find((s) => s.name === 'demo')!;
  assert.equal(st.phase, 'enabled');
  assert.match(st.payloadChecksum!, /^sha256:/);
  assert.deepEqual(st.tools.sort(), ['ext__demo__alpha', 'ext__demo__beta']);
  assert.ok(st.capabilities, 'capability summary is part of the review surface');
  assert.equal(st.processes, 0);
  await agg.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test('shutdown stops every child (no orphans)', async () => {
  const { root, dir, opts } = setup();
  enable(dir, opts);
  const agg = mkAgg(opts);
  await agg.call('ext__demo__alpha', {});
  assert.equal(agg.status().find((s) => s.name === 'demo')!.processes, 1);
  await agg.shutdown();
  assert.equal(agg.status().find((s) => s.name === 'demo')!.processes, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a timing-out plugin yields an isError result, a timeout audit record, and a health failure', async () => {
  // The user-visible half of the client-layer fault: the aggregator converts the
  // transport timeout into an MCP error result rather than letting it escape.
  const { opts, dir } = setup(SERVER_HANG, ['alpha']);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'mcp-plugin.json'), 'utf8'));
  m.timeoutMs = 1000;
  fs.writeFileSync(path.join(dir, 'mcp-plugin.json'), JSON.stringify(m, null, 2));
  enable(dir, opts);

  const agg = mkAgg(opts);
  const res = await agg.call('ext__demo__alpha', { secret: 'do-not-log-me' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /timeout/i);

  const entries = readPluginAudit({ auditFile: opts.auditFile });
  const last = entries[entries.length - 1];
  assert.equal(last.outcome, 'timeout');
  assert.equal(last.timedOut, true);
  assert.ok(!JSON.stringify(entries).includes('do-not-log-me'), 'AUDIT LEAK on the timeout path');
  assert.ok(agg.status().find((s) => s.name === 'demo')!.health.failures > 0, 'a timeout counts against health');
});

test('a plugin that auto-reverts (payload drift) has its RUNNING child stopped', async () => {
  // Refusing new calls is not enough: an approved-then-tampered plugin must not be
  // left with a live process holding whatever it was granted.
  const { dir, opts } = setup();
  enable(dir, opts);
  const agg = mkAgg(opts);
  await agg.call('ext__demo__alpha', {});
  assert.equal(agg.status().find((s) => s.name === 'demo')!.processes, 1, 'precondition: it is running');

  fs.appendFileSync(path.join(dir, 'dist', 'server.js'), '\n// tampered\n');
  await agg.listToolDefs();   // any aggregator operation should notice and reap

  const st = agg.status().find((s) => s.name === 'demo')!;
  assert.equal(st.phase, 'disabled', 'drift auto-reverts');
  assert.equal(st.processes, 0, 'the child of a reverted plugin must be stopped');
});

test('an idle process is reaped, unless the plugin asked to be kept warm', async () => {
  const { dir, opts } = setup();
  enable(dir, opts);
  const agg = mkAgg({ ...opts, idleMs: 60 });
  await agg.call('ext__demo__alpha', {});
  assert.equal(agg.status().find((s) => s.name === 'demo')!.processes, 1);
  await new Promise((r) => setTimeout(r, 150));
  await agg.listToolDefs();
  assert.equal(agg.status().find((s) => s.name === 'demo')!.processes, 0, 'an idle child must not linger');
});

test('keepWarm keeps the process resident across the idle window', async () => {
  const { dir, opts } = setup();
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'mcp-plugin.json'), 'utf8'));
  m.keepWarm = true;
  fs.writeFileSync(path.join(dir, 'mcp-plugin.json'), JSON.stringify(m, null, 2));
  enable(dir, opts);
  const agg = mkAgg({ ...opts, idleMs: 60 });
  await agg.call('ext__demo__alpha', {});
  await new Promise((r) => setTimeout(r, 150));
  await agg.listToolDefs();
  assert.equal(agg.status().find((s) => s.name === 'demo')!.processes, 1, 'keepWarm was requested');
});
