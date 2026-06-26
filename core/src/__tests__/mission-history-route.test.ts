import { test } from 'node:test';
import assert from 'node:assert';
import { handleHistory } from '../routes/core/mission.routes';
import type { MissionHistoryRecord } from '../mission/mission-store';

const rec = (rev: number): MissionHistoryRecord => ({ id: `mission_a:${rev}`, missionId: 'mission_a', rev, at: rev, actor: { kind: 'user', channel: 'mcp', node: 'n', at: rev }, changes: { status: { from: 'a', to: 'b' } } });

test('handleHistory returns rows from the injected lister, newest-first', async () => {
  const fakeList = async (id: string, opts: { limit?: number; beforeRev?: number }) => {
    assert.equal(id, 'mission_a');
    assert.equal(opts.limit, 2);
    return [rec(4), rec(3)];
  };
  const r = await handleHistory('mission_a', { limit: 2 }, undefined, fakeList as any);
  assert.equal(r.success, true);
  assert.deepEqual(((r.data as { history: MissionHistoryRecord[] }).history).map((x) => x.rev), [4, 3]);
});
