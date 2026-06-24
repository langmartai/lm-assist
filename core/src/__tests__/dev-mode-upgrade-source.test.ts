/**
 * Integration test: POST /dev-mode/upgrade forwards the custom source correctly.
 *
 * The handler reads body.source|from, copies upgrade.js to a tmp file, then
 * spawns it detached via the exec.ts `spawn` wrapper.  We stub that wrapper
 * before loading the route so no real install ever runs.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshModules() {
  // Isolate modules so each test starts clean (no cached spawn / route state).
  ['../utils/install-source', '../utils/exec', '../routes/core/dev-mode.routes'].forEach((m) => {
    try { delete require.cache[require.resolve(m)]; } catch {}
  });
}

function makeUpgradeScript(): string {
  // The handler checks fs.existsSync(upgradeScript) before spawning.
  // __dirname in the compiled JS is core/dist-test/src/__tests__
  // upgradeScript = path.resolve(__dirname, '../../../scripts/upgrade.js')
  // = core/dist-test/scripts/upgrade.js  (resolves relative to compiled output)
  // We create a throwaway file at that path so the existence check passes.
  const upgradeScriptPath = path.resolve(__dirname, '../../../scripts/upgrade.js');
  const upgradeScriptDir = path.dirname(upgradeScriptPath);
  fs.mkdirSync(upgradeScriptDir, { recursive: true });
  if (!fs.existsSync(upgradeScriptPath)) {
    fs.writeFileSync(upgradeScriptPath, '// stub upgrade script for tests\n');
  }
  return upgradeScriptPath;
}

function buildFakeReq(body: Record<string, unknown>): any {
  return {
    method: 'POST',
    path: '/dev-mode/upgrade',
    params: {},
    query: {},
    body,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('POST /dev-mode/upgrade with body.source forwards the custom source', async () => {
  freshModules();
  makeUpgradeScript();

  // Stub exec module's spawn BEFORE loading the route (which imports exec at
  // module-load time and captures the reference).
  const execMod = require('../utils/exec') as { spawn: typeof import('../utils/exec').spawn };
  let spawnCalled = false;
  let spawnArgs: string[] = [];
  const origSpawn = execMod.spawn;
  (execMod as any).spawn = (cmd: string, args: string[], _opts?: any) => {
    spawnCalled = true;
    spawnArgs = args;
    return { unref() {}, pid: 4242 } as any;
  };

  try {
    // Load route AFTER stubbing so the handler closure sees the stub.
    freshModules();
    // Re-require exec so the stub is in place for the new require.cache slot
    const execMod2 = require('../utils/exec') as { spawn: typeof import('../utils/exec').spawn };
    (execMod2 as any).spawn = (cmd: string, args: string[], _opts?: any) => {
      spawnCalled = true;
      spawnArgs = args;
      return { unref() {}, pid: 4242 } as any;
    };

    const { createDevModeRoutes } = require('../routes/core/dev-mode.routes') as {
      createDevModeRoutes: (ctx: any) => Array<{ method: string; pattern: RegExp; handler: (req: any, api: any) => Promise<any> }>;
    };

    const routes = createDevModeRoutes({} as any);
    const upgradeRoute = routes.find(
      (r) => r.method === 'POST' && r.pattern.test('/dev-mode/upgrade'),
    );
    assert.ok(upgradeRoute, 'POST /dev-mode/upgrade route must exist');

    const res = await upgradeRoute.handler(buildFakeReq({ source: '0.1.70' }), {} as any);

    assert.strictEqual(res.success, true, 'response must succeed');
    assert.strictEqual(res.data?.source, '0.1.70', 'data.source must equal the forwarded source');
    assert.strictEqual(spawnCalled, true, 'spawn must have been called (detached path ran)');
    // extraArgs = ['--from', '0.1.70'] so args[1] should be '0.1.70' (after node and tmpScript)
    assert.ok(spawnArgs.includes('--from'), 'spawn args must include --from flag');
    assert.ok(spawnArgs.includes('0.1.70'), 'spawn args must include the source value');
  } finally {
    execMod.spawn = origSpawn;
  }
});

test('POST /dev-mode/upgrade with empty body defaults to lm-assist@latest', async () => {
  freshModules();
  makeUpgradeScript();

  const execMod = require('../utils/exec') as { spawn: typeof import('../utils/exec').spawn };
  let spawnCalled = false;
  const origSpawn = execMod.spawn;
  (execMod as any).spawn = (_cmd: string, _args: string[], _opts?: any) => {
    spawnCalled = true;
    return { unref() {}, pid: 5050 } as any;
  };

  try {
    const { createDevModeRoutes } = require('../routes/core/dev-mode.routes') as {
      createDevModeRoutes: (ctx: any) => Array<{ method: string; pattern: RegExp; handler: (req: any, api: any) => Promise<any> }>;
    };

    const routes = createDevModeRoutes({} as any);
    const upgradeRoute = routes.find(
      (r) => r.method === 'POST' && r.pattern.test('/dev-mode/upgrade'),
    );
    assert.ok(upgradeRoute, 'POST /dev-mode/upgrade route must exist');

    const res = await upgradeRoute.handler(buildFakeReq({}), {} as any);

    assert.strictEqual(res.success, true, 'response must succeed');
    assert.strictEqual(res.data?.source, 'lm-assist@latest', 'data.source must default to lm-assist@latest');
    assert.strictEqual(spawnCalled, true, 'spawn must have been called');
    assert.ok(typeof res.data?.pid === 'number', 'data.pid must be a number');
  } finally {
    execMod.spawn = origSpawn;
  }
});

test('POST /dev-mode/upgrade with body.from (alias) forwards the source', async () => {
  freshModules();
  makeUpgradeScript();

  const execMod = require('../utils/exec') as { spawn: typeof import('../utils/exec').spawn };
  const origSpawn = execMod.spawn;
  (execMod as any).spawn = (_cmd: string, _args: string[], _opts?: any) => {
    return { unref() {}, pid: 7777 } as any;
  };

  try {
    const { createDevModeRoutes } = require('../routes/core/dev-mode.routes') as {
      createDevModeRoutes: (ctx: any) => Array<{ method: string; pattern: RegExp; handler: (req: any, api: any) => Promise<any> }>;
    };

    const routes = createDevModeRoutes({} as any);
    const upgradeRoute = routes.find(
      (r) => r.method === 'POST' && r.pattern.test('/dev-mode/upgrade'),
    );
    assert.ok(upgradeRoute, 'POST /dev-mode/upgrade route must exist');

    const res = await upgradeRoute.handler(buildFakeReq({ from: '/tmp/lm-assist-0.1.70.tgz' }), {} as any);

    assert.strictEqual(res.success, true, 'response must succeed');
    assert.strictEqual(
      res.data?.source,
      '/tmp/lm-assist-0.1.70.tgz',
      'data.source must equal body.from when source is absent',
    );
  } finally {
    execMod.spawn = origSpawn;
  }
});
