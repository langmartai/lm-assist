import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as oauth from '../../utils/claude-oauth';
import { listCoworkTasks, getCoworkTask, driveCoworkTask, renameCoworkTask, deleteCoworkTask } from '../cowork-tasks';

afterEach(() => mock.restoreAll());
function stubOrg() { mock.method(oauth, 'getOrganizationUuid', async () => 'org-x'); }
function ok(body: any, status = 200) { return { status, statusText: 'OK', headers: {}, body }; }

test('listCoworkTasks maps + filters cowork-tagged sessions', async () => {
  stubOrg();
  mock.method(oauth, 'anthropicOAuthGet', async (path: string) => {
    assert.match(path, /^\/v1\/code\/sessions/);
    return ok({ data: [
      { id: 'cse_a', title: 'A', status: 'active', tags: ['cowork', 'product:cowork-remote'], config: { model: 'claude-sonnet-5' }, last_event_at: 't1', post_turn_summary: { status_category: 'review_ready' } },
      { id: 'sess_b', title: 'not cowork', tags: ['code'] },
    ] });
  });
  const { tasks } = await listCoworkTasks({ filter: 'cowork' });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].sid, 'cse_a');
  assert.equal(tasks[0].statusCategory, 'review_ready');
});

test('getCoworkTask reads /events + session and parses', async () => {
  stubOrg();
  mock.method(oauth, 'anthropicOAuthGet', async (path: string) => {
    if (path.endsWith('/events')) return ok({ data: [
      { event_type: 'user', payload: { type: 'user', message: { role: 'user', content: 'hi' } } },
    ] });
    return ok({ id: 'cse_a', title: 'A', config: { model: 'claude-sonnet-5' }, post_turn_summary: { status_category: 'idle' } });
  });
  const d = await getCoworkTask('cse_a');
  assert.equal(d.sid, 'cse_a');
  assert.equal(d.messages[0].text, 'hi');
  assert.equal(d.statusCategory, 'idle');
});

test('driveCoworkTask posts a user event to /v1/code/sessions/{cse}/events', async () => {
  stubOrg();
  let posted: any;
  mock.method(oauth, 'anthropicOAuthPost', async (path: string, body: any) => { posted = { path, body }; return ok({ results: [{ event_id: 'e1' }] }); });
  const r = await driveCoworkTask({ cse: 'cse_a', text: 'go' });
  assert.equal(r.delivered, true);
  assert.match(posted.path, /\/v1\/code\/sessions\/cse_a\/events$/);
  assert.equal(posted.body.events[0].payload.message.content, 'go');
});

test('renameCoworkTask PUTs the title; delete DELETEs', async () => {
  stubOrg();
  let put: any, del: any;
  mock.method(oauth, 'anthropicOAuthPut', async (path: string, body: any) => { put = { path, body }; return ok({}); });
  mock.method(oauth, 'anthropicOAuthDelete', async (path: string) => { del = path; return ok({}); });
  await renameCoworkTask('cse_a', 'New');
  await deleteCoworkTask('cse_a');
  assert.match(put.path, /\/v1\/code\/sessions\/cse_a$/);
  assert.equal(put.body.title, 'New');
  assert.match(del, /\/v1\/code\/sessions\/cse_a$/);
});
