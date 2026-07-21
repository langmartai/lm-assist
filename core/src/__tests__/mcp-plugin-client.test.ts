/**
 * The subprocess execution path (contract §6, §7, §8; design §Security 3/6).
 * These are the tests that guard actually running third-party code: environment
 * isolation, no-shell spawn, and every resource limit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnPlugin, buildPluginEnv, resolveEntry } from '../mcp-server/plugins/client';
import { PLUGIN_LIMITS, type PluginManifest } from '../mcp-server/plugins/model';

const SERVERS: Record<string, string> = {
  // well-behaved: handshake, one tool, echoes back what it got
  good: `
    const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
    const TOOLS=[{name:'echo',description:'echo',inputSchema:{type:'object'}},
                 {name:'env_dump',description:'dump env',inputSchema:{type:'object'}}];
    let buf='';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i).trim();buf=buf.slice(i+1);if(l)go(JSON.parse(l));}});
    process.stdin.on('end',()=>process.exit(0));
    function go(m){
      if(m.id===undefined)return;
      if(m.method==='initialize')return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fix',version:'1.0.0'}}});
      if(m.method==='ping')return send({jsonrpc:'2.0',id:m.id,result:{}});
      if(m.method==='tools/list')return send({jsonrpc:'2.0',id:m.id,result:{tools:TOOLS}});
      if(m.method==='tools/call'){
        if(m.params.name==='env_dump')return send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:JSON.stringify(process.env)}]}});
        return send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'got:'+JSON.stringify(m.params)}]}});
      }
      send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'nope'}});
    }`,
  // advertises a tool the manifest does not declare, and omits one it does
  drifted: `
    const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
    const TOOLS=[{name:'secret_backdoor',description:'not in manifest',inputSchema:{type:'object'}}];
    let buf='';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i).trim();buf=buf.slice(i+1);if(l)go(JSON.parse(l));}});
    function go(m){
      if(m.id===undefined)return;
      if(m.method==='initialize')return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fix',version:'1.0.0'}}});
      if(m.method==='tools/list')return send({jsonrpc:'2.0',id:m.id,result:{tools:TOOLS}});
      if(m.method==='tools/call')return send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'ran '+m.params.name}]}});
    }`,
  // never answers a tools/call
  hang: `
    const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
    let buf='';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i).trim();buf=buf.slice(i+1);if(l)go(JSON.parse(l));}});
    function go(m){
      if(m.id===undefined)return;
      if(m.method==='initialize')return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fix',version:'1.0.0'}}});
      if(m.method==='tools/list')return send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'stall',description:'stalls',inputSchema:{type:'object'}}]}});
      /* tools/call: deliberately no response, and ignore SIGTERM to force the SIGKILL path */
    }
    process.on('SIGTERM',()=>{});`,
  // returns a result far larger than the 1 MiB cap
  huge: `
    const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
    let buf='';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i).trim();buf=buf.slice(i+1);if(l)go(JSON.parse(l));}});
    function go(m){
      if(m.id===undefined)return;
      if(m.method==='initialize')return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fix',version:'1.0.0'}}});
      if(m.method==='tools/list')return send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'flood',description:'floods',inputSchema:{type:'object'}}]}});
      if(m.method==='tools/call')return send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'x'.repeat(3*1024*1024)}]}});
    }`,
  // dies on startup
  crash: `process.stderr.write('boom\\n'); process.exit(3);`,
  // starts but never completes the handshake
  silent: `setInterval(()=>{},1000);`,
  // tracks peak concurrent in-flight calls
  concurrent: `
    const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
    let inflight=0, peak=0, buf='';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i).trim();buf=buf.slice(i+1);if(l)go(JSON.parse(l));}});
    function go(m){
      if(m.id===undefined)return;
      if(m.method==='initialize')return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fix',version:'1.0.0'}}});
      if(m.method==='tools/list')return send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'work',description:'works',inputSchema:{type:'object'}}]}});
      if(m.method==='tools/call'){
        inflight++; if(inflight>peak)peak=inflight;
        setTimeout(()=>{inflight--;send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:String(peak)}]}});},120);
      }
    }`,
};

function fixture(mode: keyof typeof SERVERS, manifestPatch: Partial<PluginManifest> = {}): {
  root: string; dir: string; scratch: string; manifest: PluginManifest;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-plugin-cli-'));
  const dir = path.join(root, 'fix');
  const scratch = path.join(root, 'scratch');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'server.js'), SERVERS[mode]);
  const manifest = {
    manifestVersion: 1, name: 'fix', version: '1.0.0', description: 'fixture', author: 'test',
    entry: { command: 'node' as const, args: ['dist/server.js'] },
    tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
    capabilities: { network: [], fs: [], env: [] },
    checksum: 'sha256:' + '0'.repeat(64),
    ...manifestPatch,
  } as PluginManifest;
  return { root, dir, scratch, manifest };
}

// ---------------------------------------------------------------- environment ---
test('buildPluginEnv inherits NOTHING from the lm-assist process', () => {
  process.env.LM_TEST_LEAK_CANARY = 'must-not-leak';
  process.env.ANTHROPIC_API_KEY = 'sk-must-not-leak';
  const { dir, scratch, manifest } = fixture('good');
  const env = buildPluginEnv(manifest, dir, scratch, {});
  assert.equal(env.LM_TEST_LEAK_CANARY, undefined, 'parent env leaked into the plugin');
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'CREDENTIAL LEAK into third-party process');
  delete process.env.LM_TEST_LEAK_CANARY;
  delete process.env.ANTHROPIC_API_KEY;
});

test('buildPluginEnv provides exactly the contracted base environment', () => {
  const { dir, scratch, manifest } = fixture('good');
  const env = buildPluginEnv(manifest, dir, scratch, {});
  assert.equal(env.HOME, scratch, 'HOME must be the scratch dir, never the real home');
  assert.equal(env.LM_PLUGIN_NAME, 'fix');
  assert.equal(env.LM_PLUGIN_VERSION, '1.0.0');
  assert.equal(env.LM_PLUGIN_DIR, dir);
  assert.equal(env.LM_PLUGIN_SCRATCH_DIR, scratch);
  assert.equal(env.LANG, 'C.UTF-8');
  assert.ok(env.PATH && env.PATH.length > 0);
  assert.ok(env.TMPDIR && env.TMPDIR.startsWith(scratch));
  const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LM_PLUGIN_NAME', 'LM_PLUGIN_VERSION', 'LM_PLUGIN_DIR', 'LM_PLUGIN_SCRATCH_DIR']);
  for (const k of Object.keys(env)) assert.ok(allowed.has(k), `unexpected env var handed to the plugin: ${k}`);
});

test('only DECLARED env names are filled, and only from the grant store', () => {
  process.env.CHART_API_KEY = 'value-from-core-process';
  const { dir, scratch, manifest } = fixture('good', {
    capabilities: { network: [], fs: [], env: ['CHART_API_KEY'] },
  } as Partial<PluginManifest>);
  const granted = buildPluginEnv(manifest, dir, scratch, { CHART_API_KEY: 'value-from-grant-store' });
  assert.equal(granted.CHART_API_KEY, 'value-from-grant-store', 'value must come from the grant store');

  const ungranted = buildPluginEnv(manifest, dir, scratch, {});
  assert.equal(ungranted.CHART_API_KEY, undefined, 'declared-but-not-granted must be ABSENT, never inherited');

  const undeclared = buildPluginEnv(
    { ...manifest, capabilities: { network: [], fs: [], env: [] } } as PluginManifest,
    dir, scratch, { CHART_API_KEY: 'x', OTHER: 'y' },
  );
  assert.equal(undeclared.CHART_API_KEY, undefined, 'a grant without a declaration must not be passed');
  delete process.env.CHART_API_KEY;
});

test('resolveEntry pins OUR node binary and keeps args inside the plugin dir (no shell)', () => {
  const { dir, manifest } = fixture('good');
  const r = resolveEntry(manifest, dir);
  assert.equal(r.command, process.execPath, 'must use the known-good interpreter, not a PATH lookup');
  assert.ok(r.args[0].startsWith(dir + path.sep), `entry arg escaped the plugin dir: ${r.args[0]}`);
  assert.throws(
    () => resolveEntry({ ...manifest, entry: { command: 'node', args: ['../../etc/passwd'] } } as PluginManifest, dir),
    /outside|traversal|invalid/i,
  );
});

// ------------------------------------------------------------------- protocol ---
test('spawn → handshake → tools/list → tools/call round-trip', async () => {
  const { root, dir, scratch, manifest } = fixture('good');
  const p = await spawnPlugin({ name: 'fix', dir, manifest, scratchDir: scratch, grants: {} });
  const tools = await p.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['echo', 'env_dump']);
  const res = await p.call('echo', { a: 1 });
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text ?? '', /got:/);
  await p.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('the spawned process really has no parent credentials (end-to-end env proof)', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-live-must-not-leak';
  const { root, dir, scratch, manifest } = fixture('good');
  const p = await spawnPlugin({ name: 'fix', dir, manifest, scratchDir: scratch, grants: {} });
  const res = await p.call('env_dump', {});
  const childEnv = JSON.parse(res.content[0].text ?? '') as Record<string, string>;
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined, 'REAL LEAK: credential reached the child process');
  assert.equal(childEnv.HOME, scratch);
  await p.close();
  delete process.env.ANTHROPIC_API_KEY;
  fs.rmSync(root, { recursive: true, force: true });
});

// --------------------------------------------------------------------- limits ---
test('a call that never answers times out, raises a fault, and the child is killed', async () => {
  // Layering: a timeout is a TRANSPORT FAULT, so the client raises it rather than
  // dressing it up as a plugin result — the aggregator turns it into the user-facing
  // isError result and counts it against health (see the aggregator suite).
  const { root, dir, scratch, manifest } = fixture('hang', { timeoutMs: 1000 } as Partial<PluginManifest>);
  const p = await spawnPlugin({ name: 'fix', dir, manifest, scratchDir: scratch, grants: {} });
  const t0 = Date.now();
  await assert.rejects(() => p.call('stall', {}), /timeout/i);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 8000, `timeout took ${elapsed}ms — the cap did not fire`);
  await p.close();
  // the fixture ignores SIGTERM on purpose, so this also proves the SIGKILL escalation
  assert.equal(p.alive(), false, 'a hanging plugin must be killed (SIGTERM then SIGKILL)');
  fs.rmSync(root, { recursive: true, force: true });
});

test('per-call timeout is clamped to the contract hard cap', async () => {
  const { root, dir, scratch, manifest } = fixture('good', { timeoutMs: 999_999 } as Partial<PluginManifest>);
  const p = await spawnPlugin({ name: 'fix', dir, manifest, scratchDir: scratch, grants: {} });
  assert.ok(p.effectiveTimeoutMs() <= PLUGIN_LIMITS.maxTimeoutMs,
    `timeout ${p.effectiveTimeoutMs()} exceeds the ${PLUGIN_LIMITS.maxTimeoutMs} cap`);
  await p.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('an oversized result is truncated and flagged, never passed through whole', async () => {
  const { root, dir, scratch, manifest } = fixture('huge');
  const p = await spawnPlugin({ name: 'fix', dir, manifest, scratchDir: scratch, grants: {} });
  const res = await p.call('flood', {});
  const bytes = Buffer.byteLength(res.content.map((c) => c.text).join(''), 'utf8');
  assert.ok(bytes <= PLUGIN_LIMITS.maxResultBytes + 1024, `result ${bytes} bytes exceeded the 1 MiB cap`);
  assert.equal(res.isError, true, 'exceeding the cap is an error outcome');
  assert.match(res.content[0].text ?? '', /truncat|too large|cap/i);
  await p.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('concurrent calls are capped at the contracted limit', async () => {
  const { root, dir, scratch, manifest } = fixture('concurrent');
  const p = await spawnPlugin({ name: 'fix', dir, manifest, scratchDir: scratch, grants: {} });
  const results = await Promise.all(Array.from({ length: 10 }, () => p.call('work', {})));
  const peak = Math.max(...results.map((r) => Number(r.content[0].text ?? '')));
  assert.ok(peak <= PLUGIN_LIMITS.maxConcurrentCalls,
    `peak in-flight ${peak} exceeded the cap of ${PLUGIN_LIMITS.maxConcurrentCalls}`);
  await p.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a plugin that dies on startup fails the spawn with a clear error', async () => {
  const { root, dir, scratch, manifest } = fixture('crash');
  await assert.rejects(
    () => spawnPlugin({ name: 'fix', dir, manifest, scratchDir: scratch, grants: {} }),
    /handshake|exit|spawn|failed/i,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('a plugin that never handshakes is killed at the handshake deadline', async () => {
  const { root, dir, scratch, manifest } = fixture('silent');
  const t0 = Date.now();
  await assert.rejects(
    () => spawnPlugin({ name: 'fix', dir, manifest, scratchDir: scratch, grants: {}, handshakeMs: 800 }),
    /handshake/i,
  );
  assert.ok(Date.now() - t0 < 6000, 'handshake deadline did not fire');
  fs.rmSync(root, { recursive: true, force: true });
});

test('close() is idempotent and leaves no live child', async () => {
  const { root, dir, scratch, manifest } = fixture('good');
  const p = await spawnPlugin({ name: 'fix', dir, manifest, scratchDir: scratch, grants: {} });
  await p.close();
  await p.close();
  assert.equal(p.alive(), false);
  fs.rmSync(root, { recursive: true, force: true });
});
