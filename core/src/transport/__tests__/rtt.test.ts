// core/src/transport/__tests__/rtt.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { RttEstimator } from '../../transport/rtt';

test('no sample yet → initial 300ms rto', () => {
  assert.equal(new RttEstimator().rto(), 300);
});
test('first sample sets SRTT=R, RTTVAR=R/2 → rto = R + 4*(R/2) = 3R, clamped', () => {
  const e = new RttEstimator({ minRtoMs: 40, maxRtoMs: 4000 });
  e.sample(100);
  assert.equal(e.srtt(), 100);
  assert.equal(e.rto(), 300);           // 100 + 4*50
});
test('steady low-RTT LAN converges to a low rto, floored at min', () => {
  const e = new RttEstimator({ minRtoMs: 40 });
  for (let i = 0; i < 50; i++) e.sample(2);
  assert.ok(e.rto() <= 60, `rto ${e.rto()} should approach the 40ms floor`);
  assert.ok(e.rto() >= 40);
});
test('rto never exceeds maxRtoMs', () => {
  const e = new RttEstimator({ maxRtoMs: 4000 });
  e.sample(100000);
  assert.equal(e.rto(), 4000);
});
