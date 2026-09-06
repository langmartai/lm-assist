/**
 * Mission-controller DEMAND gate (2026-09): a default install must not keep a
 * controller session alive with nothing to control, and a controller whose
 * missions have gone cold is torn down and relaunched on demand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeControllerDemand, decideSupervisor } from '../mission/mission-controller';

const MIN = 60_000;
const now = 10_000 * MIN;
const m = (status: string, agoMin: number) => ({ status, updatedAt: now - agoMin * MIN, createdAt: now - (agoMin + 5) * MIN });

test('computeControllerDemand: no missions / only done+failed ⇒ none', () => {
  assert.equal(computeControllerDemand([], now, 60 * MIN), 'none');
  assert.equal(computeControllerDemand([m('done', 1), m('failed', 1)], now, 60 * MIN), 'none');
});

test('computeControllerDemand: any active mission ⇒ active, whatever its age', () => {
  assert.equal(computeControllerDemand([m('active', 500), m('done', 0)], now, 60 * MIN), 'active');
});

test('computeControllerDemand: open-but-not-active missions are warm within coldMin, cold after', () => {
  assert.equal(computeControllerDemand([m('waiting', 30)], now, 60 * MIN), 'warm');
  assert.equal(computeControllerDemand([m('waiting', 61), m('paused', 200)], now, 60 * MIN), 'cold');
  assert.equal(computeControllerDemand([m('waiting', 61), m('blocked', 10)], now, 60 * MIN), 'warm', 'the most recently touched open mission decides');
  // a fresh create with no updatedAt yet still counts as a touch
  assert.equal(computeControllerDemand([{ status: 'draft', createdAt: now - 1 * MIN }], now, 60 * MIN), 'warm');
});

test('computeControllerDemand: coldMin 0 disables the cold verdict', () => {
  assert.equal(computeControllerDemand([m('waiting', 9999)], now, 0), 'warm');
});

test('decideSupervisor: no demand ⇒ a live controller is torn down, a dead one is NOT launched', () => {
  const dead = decideSupervisor({ isMonitor: true, live: false, driveDue: true, demand: 'none' });
  assert.equal(dead.action, 'idle');
  assert.match(dead.reason || '', /no missions/);
  const live = decideSupervisor({ isMonitor: true, live: true, driveDue: true, demand: 'none' });
  assert.equal(live.action, 'teardown');
  const cold = decideSupervisor({ isMonitor: true, live: true, driveDue: false, demand: 'cold' });
  assert.equal(cold.action, 'teardown');
  assert.match(cold.reason || '', /cold/);
  assert.equal(decideSupervisor({ isMonitor: true, live: false, driveDue: false, demand: 'cold' }).action, 'idle');
});

test('decideSupervisor: demand returning launches; warm/active keep the normal table; absent demand = always-on', () => {
  assert.equal(decideSupervisor({ isMonitor: true, live: false, driveDue: false, demand: 'warm' }).action, 'launch');
  assert.equal(decideSupervisor({ isMonitor: true, live: false, driveDue: false, demand: 'active' }).action, 'launch');
  assert.equal(decideSupervisor({ isMonitor: true, live: true, driveDue: true, demand: 'warm' }).action, 'drive');
  assert.equal(decideSupervisor({ isMonitor: true, live: true, driveDue: false, demand: 'active' }).action, 'idle');
  assert.equal(decideSupervisor({ isMonitor: true, live: false, driveDue: false }).action, 'launch');
});

test('decideSupervisor: election still outranks demand — a non-leader never tears down for demand, and indeterminate stays idle', () => {
  assert.equal(decideSupervisor({ isMonitor: false, live: true, driveDue: false, demand: 'none', notMonitorStreak: 1 }).action, 'idle');
  assert.equal(decideSupervisor({ isMonitor: false, live: true, driveDue: false, demand: 'none', notMonitorStreak: 2 }).action, 'teardown');
  assert.equal(decideSupervisor({ isMonitor: true, live: true, driveDue: true, demand: 'none', indeterminate: true }).action, 'idle');
});
