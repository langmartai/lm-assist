import { test } from 'node:test';
import assert from 'node:assert';
import { missionSessionTitle, Mission } from '../mission/mission-model';
const m = (over: Partial<Mission>): Mission => ({ id: 'mission_73411da5', title: 'Refactor auth', objective: 'o', projects: [], dependsOn: [], env: { isolation: 'cloud', resources: [] }, binding: null, progress: null, control: { nudgeCount: 0, backoffStep: 0 }, results: [], adjustments: [], status: 'active', ownerNode: 'n', createdAt: 0, updatedAt: 0, ...over } as unknown as Mission);
test('mission session title is identifiable + traceable', () => {
  assert.strictEqual(missionSessionTitle(m({})), 'Mission: Refactor auth · 73411da5');
});
