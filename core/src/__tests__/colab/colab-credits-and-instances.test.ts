import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseColabSessions,
  parseColabUsage,
  runColabAction,
  type ColabExecFn,
} from '../../colab/colab-service';
import { createColabRoutes } from '../../routes/core/colab.routes';

test('parseColabUsage, parseColabSessions, overview, stop --all, and credit/instance routes behave as expected', async () => {
  const usageSample = [
    'Current balance: 194.50 compute units',
    'Usage rate: 1.96/hr',
    'Active assignments: 2',
  ].join('\n');
  assert.deepEqual(parseColabUsage(usageSample), {
    computeUnitsBalance: 194.5,
    usageRatePerHour: 1.96,
    activeAssignments: 2,
  });

  const sessionsSample = [
    '[trainer] m-s-abc123 | Hardware: A100 | Shape: HIGHMEM | Variant: GPU',
    '[cpu1] m-s-def456 | Hardware: CPU | Shape: STANDARD | Variant: DEFAULT',
  ].join('\n');
  const parsedSessions = parseColabSessions(sessionsSample);
  assert.equal(parsedSessions.length, 2);
  assert.equal(parsedSessions[0].name, 'trainer');
  assert.equal(parsedSessions[0].hardware, 'A100');
  assert.equal(parsedSessions[0].shape, 'HIGHMEM');
  assert.equal(parsedSessions[0].busy, false);

  const statusSample = [
    '[trainer] m-s-abc123 | Hardware: A100 | Shape: HIGHMEM | Variant: GPU | Status: BUSY (python)',
    '  Last Execution: train.py | Cell: 2 at 2026-11-27 00:05:00',
    '[cpu1] m-s-def456 | Hardware: CPU | Shape: STANDARD | Variant: DEFAULT | Status: IDLE',
  ].join('\n');
  const parsedStatus = parseColabSessions(statusSample);
  assert.equal(parsedStatus[0].busy, true);
  assert.equal(parsedStatus[0].status, 'BUSY (python)');
  assert.equal(parsedStatus[0].lastExecution, 'train.py | Cell: 2 at 2026-11-27 00:05:00');
  assert.equal(parsedStatus[1].busy, false);

  const calls: string[][] = [];
  const mockExec: ColabExecFn = async (_cmd, args) => {
    calls.push(args);
    const sub = args.find((a) => ['version', 'whoami', 'usage', 'sessions', 'status', 'stop'].includes(a));
    if (sub === 'version') return { code: 0, stdout: 'Version: 0.8.0\n', stderr: '' };
    if (sub === 'whoami') return { code: 0, stdout: 'Auth provider: oauth2\nEmail: dev@example.com\nExpires in: 55m\n', stderr: '' };
    if (sub === 'usage') return { code: 0, stdout: usageSample, stderr: '' };
    if (sub === 'sessions') return { code: 0, stdout: sessionsSample, stderr: '' };
    if (sub === 'status') return { code: 0, stdout: statusSample, stderr: '' };
    return { code: 0, stdout: 'Stopped', stderr: '' };
  };

  const ov = await runColabAction('overview', {}, { execFn: mockExec, platform: 'linux', bin: 'colab' });
  assert.equal(ov.ok, true);
  if (ov.ok) {
    const doc = ov.data.doctor as { loggedIn: boolean; email: string };
    const u = ov.data.usage as { computeUnitsBalance: number; usageRatePerHour: number; activeAssignments: number };
    const sess = ov.data.sessions as Array<{ name: string; busy: boolean; lastExecution: string | null }>;
    assert.equal(doc.loggedIn, true);
    assert.equal(doc.email, 'dev@example.com');
    assert.equal(u.computeUnitsBalance, 194.5);
    assert.equal(u.usageRatePerHour, 1.96);
    assert.equal(ov.data.activeCount, 2);
    assert.equal(sess[0].busy, true);
    assert.equal(sess[0].lastExecution, 'train.py | Cell: 2 at 2026-11-27 00:05:00');
  }

  const stopAll = await runColabAction('stop', { all: true }, { execFn: mockExec, platform: 'linux', bin: 'colab' });
  assert.equal(stopAll.ok, true);
  assert.deepEqual(calls.at(-1), ['stop', '--all']);

  const routes = createColabRoutes({} as never);
  for (const p of ['/colab/overview', '/colab/usage', '/colab/credits', '/colab/sessions', '/colab/instances']) {
    const r = routes.find((rt) => rt.method === 'GET' && rt.pattern.test(p));
    assert.ok(r, `GET ${p} should be registered`);
  }
});
