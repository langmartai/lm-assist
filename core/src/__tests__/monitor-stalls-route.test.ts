import { test } from 'node:test';
import assert from 'node:assert';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

test('buildStallStatus reports store + monitor verdict', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arstatus-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  ['../monitor/stall-store', '../routes/core/monitor-stalls.routes', '../project-settings'].forEach((m) => { try { delete require.cache[require.resolve(m)]; } catch {} });
  const store = require('../monitor/stall-store');
  store.saveStallStore({ 'local:L1': { attempts: 3, lastNudgeAt: 5, category: 'overloaded', backoffStep: 1, gaveUp: false }, 'ccr:R1': { attempts: 6, lastNudgeAt: 9, category: 'server_error', backoffStep: 5, gaveUp: true } });
  const { buildStallStatus } = require('../routes/core/monitor-stalls.routes');
  const s = await buildStallStatus(async () => ({ isMonitor: true, monitorNodeId: 'self' })); // inject election
  assert.strictEqual(s.attempts, 9);
  assert.strictEqual(s.gaveUp, 1);
  assert.strictEqual(s.amMonitor, true);
  assert.strictEqual(s.sessions.length, 2);
});
