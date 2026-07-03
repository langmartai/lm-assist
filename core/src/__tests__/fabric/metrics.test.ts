import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { LinkMetrics, ClassScheduler } from '../../fabric/metrics';

test('EWMA rate rises after bytes and reports rtt + comp savings', () => {
  let t = 0;
  const m = new LinkMetrics(() => t);
  m.recordOut('rpc', 10_000); t = 1000;
  m.recordOut('rpc', 10_000); t = 2000;
  const s = m.snapshot();
  assert.ok(s.perClass.rpc.outBps > 0);
  m.recordRtt(7); m.recordCompSaved(500);
  const s2 = m.snapshot();
  assert.equal(s2.rttMs, 7);
  assert.equal(s2.compSavedBytes, 500);
});

test('scheduler: uncapped classes never delay; a capped bulk class delays over budget', () => {
  let t = 0;
  const sch = new ClassScheduler({ bulk: 1_000_000 }, () => t); // bulk 1 MB/s
  assert.equal(sch.reserve('control', 5_000_000), 0);   // control uncapped → immediate
  assert.equal(sch.reserve('rpc', 5_000_000), 0);       // rpc uncapped → immediate
  assert.equal(sch.reserve('bulk', 1_000_000), 0);      // first 1MB fits this second
  const delay = sch.reserve('bulk', 1_000_000);         // next 1MB must wait ~1s
  assert.ok(delay >= 900 && delay <= 1100, `delay=${delay}`);
});

test('setCap(null) removes a cap', () => {
  const sch = new ClassScheduler({ bulk: 1000 });
  sch.setCap('bulk', null);
  assert.equal(sch.reserve('bulk', 10_000_000), 0);
});
