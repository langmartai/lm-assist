/**
 * scheduler_jobs update/pause on BUILT-IN jobs (2026-09-07): with the
 * mission-controller job launching a controller every tick on 123, the operator
 * tried scheduler_jobs(action="update", id="mission-controller", auto_run=false)
 * and got "No job to update" — there was no way to pause a runaway built-in.
 * The exists probe read `.success` off an already-UNWRAPPED job, so it was
 * always false, for every job. Now: exists = the GET returned a job, and
 * pause/resume are first-class actions.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEDULER_HANDLERS, jobExists } from '../mcp-server/tools/scheduler';

const realFetch = global.fetch;
const JOB = { id: 'mission-controller', name: 'Mission controller', type: 'mission-controller', enabled: true, intervalMinutes: 1, builtin: true, config: {}, lastRunAt: null, lastResult: null, lastStatus: null, nextRunAt: '2026-09-07T20:00:00Z' };

/** Route GET/PUT to canned envelopes; record every PUT body. */
function stub(): { puts: Array<{ url: string; body: unknown }> } {
  const puts: Array<{ url: string; body: unknown }> = [];
  // @ts-expect-error test stub
  global.fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    const method = (init?.method || 'GET').toUpperCase();
    let payload: unknown;
    if (u.includes('/scheduler/jobs/mission-controller')) {
      if (method === 'PUT') {
        const body = JSON.parse(init?.body || '{}');
        puts.push({ url: u, body });
        payload = { success: true, data: { ...JOB, ...body, nextRunAt: body.enabled === false ? null : JOB.nextRunAt } };
      } else payload = { success: true, data: JOB };
    } else if (u.includes('/scheduler/jobs/no-such-job')) {
      payload = { success: false, error: { code: 'NOT_FOUND', message: 'No job "no-such-job"' } };
    } else payload = { success: false, error: 'no route' };
    const ok = !!(payload as { success?: boolean }).success;
    const text = JSON.stringify(payload);
    return { ok, status: ok ? 200 : 404, async text() { return text; }, async json() { return payload; } };
  };
  return { puts };
}
afterEach(() => { global.fetch = realFetch; });

test('jobExists: an unwrapped job object counts; envelopes, nulls and empties do not', () => {
  assert.equal(jobExists(JOB), true);
  assert.equal(jobExists({ success: true }), false);
  assert.equal(jobExists(null), false);
  assert.equal(jobExists({ id: '' }), false);
});

test('update on a BUILT-IN job succeeds (was: "No job to update") and PUTs the change', async () => {
  const { puts } = stub();
  const r = await SCHEDULER_HANDLERS.scheduler_jobs({ action: 'update', id: 'mission-controller', auto_run: false });
  assert.equal(r.isError, undefined);
  assert.match(String(r.content[0].text), /Updated "mission-controller"/);
  assert.equal(puts.length, 1);
  assert.equal((puts[0].body as { enabled?: boolean }).enabled, false);
});

test('update on an unknown job still refuses with the create hint', async () => {
  stub();
  const r = await SCHEDULER_HANDLERS.scheduler_jobs({ action: 'update', id: 'no-such-job', auto_run: false });
  assert.equal(r.isError, true);
  assert.match(String(r.content[0].text), /No job "no-such-job" to update/);
});

test('pause / resume flip enabled on a built-in job and say so', async () => {
  const { puts } = stub();
  const p = await SCHEDULER_HANDLERS.scheduler_jobs({ action: 'pause', id: 'mission-controller' });
  assert.equal(p.isError, undefined);
  assert.match(String(p.content[0].text), /Paused "mission-controller" \(built-in\): disabled/);
  const r = await SCHEDULER_HANDLERS.scheduler_jobs({ action: 'resume', id: 'mission-controller' });
  assert.match(String(r.content[0].text), /Resumed "mission-controller" \(built-in\): enabled/);
  assert.deepEqual(puts.map((x) => (x.body as { enabled: boolean }).enabled), [false, true]);
});

test('pause without an id is refused', async () => {
  stub();
  const r = await SCHEDULER_HANDLERS.scheduler_jobs({ action: 'pause' });
  assert.equal(r.isError, true);
});
