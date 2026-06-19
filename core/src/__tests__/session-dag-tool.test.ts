import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_DAG_HANDLERS } from '../mcp-server/tools/session-dag-tool';

const realFetch = global.fetch;
function routeStub(map: (url: string) => unknown): void {
  // @ts-expect-error stub
  global.fetch = async (url: string) => {
    const data = map(String(url));
    const env = data === undefined ? { success: false, error: { message: 'not found' } } : { success: true, data };
    const text = JSON.stringify(env);
    return { ok: data !== undefined, status: data !== undefined ? 200 : 404, async text() { return text; }, async json() { return env; } };
  };
}
afterEach(() => { global.fetch = realFetch; });

const SID = '99d239ac-5eba-4509-96c0-a14d00a32fd7';

test('session_dag summary: lists fork points with line + branch sizes', async () => {
  routeStub((u) => {
    if (u.includes('/dag/branches')) return {
      forkPoints: [
        { forkNode: { id: 'fork-1', type: 'assistant', metadata: { lineIndex: 549, toolName: 'Bash', timestamp: '2026-06-16T04:04:26Z' } },
          branches: [{ firstNode: { id: 'b1' }, messageCount: 738 }, { firstNode: { id: 'b2' }, messageCount: 12 }] },
      ],
    };
    return undefined;
  });
  const t = (await SESSION_DAG_HANDLERS.session_dag({ id: SID })).content[0].text;
  assert.match(t, /1 fork point/i);
  assert.match(t, /line 549/);
  assert.match(t, /738 msgs/);
  assert.match(t, /12 msgs/);
  assert.match(t, /fork-1/);
});

test('session_dag summary: a linear session says so', async () => {
  routeStub((u) => (u.includes('/dag/branches') ? { forkPoints: [] } : undefined));
  const t = (await SESSION_DAG_HANDLERS.session_dag({ id: SID })).content[0].text;
  assert.match(t, /linear/i);
});

test('session_dag ancestry: shows the lineage path', async () => {
  routeStub((u) => {
    if (u.includes('/dag/ancestors/')) return { depth: 2, path: [
      { id: 'a', type: 'user', label: 'do the thing', metadata: { lineIndex: 1 } },
      { id: 'b', type: 'assistant', label: 'sure, doing it', metadata: { lineIndex: 2 } },
    ] };
    return undefined;
  });
  const t = (await SESSION_DAG_HANDLERS.session_dag({ id: SID, view: 'ancestry', message: 'b' })).content[0].text;
  assert.match(t, /do the thing/);
  assert.match(t, /sure, doing it/);
});

test('session_dag: a drill-in view requires a message uuid', async () => {
  routeStub(() => ({}));
  const res = await SESSION_DAG_HANDLERS.session_dag({ id: SID, view: 'ancestry' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /message/i);
});

test('session_dag: requires id', async () => {
  routeStub(() => ({}));
  const res = await SESSION_DAG_HANDLERS.session_dag({});
  assert.equal(res.isError, true);
});
