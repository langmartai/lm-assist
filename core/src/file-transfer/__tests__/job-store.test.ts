import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { JobStore, type JobRecord } from '../job-store';

function rec(id: string, state: JobRecord['state']): JobRecord {
  return { jobId: id, peer: 'p', source: { kind: 'file', path: '/a' }, sink: { kind: 'file', path: '/b' },
    size: 1, state, attempts: 0, maxAttempts: 5, bytesDone: 0, resumeCount: 0, enqueuedAt: 1, deadlineAt: 2 };
}

test('append then loadAll replays last-write-wins per jobId', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'js-')), 'jobs.jsonl');
  const store = new JobStore(f);
  store.append(rec('j1', 'queued'));
  store.append(rec('j1', 'active'));
  store.append(rec('j2', 'queued'));
  const all = new JobStore(f).loadAll();
  assert.equal(all.length, 2);
  assert.equal(all.find((r) => r.jobId === 'j1')!.state, 'active');
});

test('loadAll tolerates a torn final line', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'js-')), 'jobs.jsonl');
  const store = new JobStore(f); store.append(rec('j1', 'done'));
  fs.appendFileSync(f, '{"jobId":"j2","st'); // torn
  assert.equal(new JobStore(f).loadAll().length, 1);
});

test('compact rewrites to one line per live job', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'js-')), 'jobs.jsonl');
  const store = new JobStore(f);
  store.append(rec('j1', 'queued')); store.append(rec('j1', 'active')); store.append(rec('j2', 'done'));
  store.compact([rec('j1', 'active')]);
  assert.equal(fs.readFileSync(f, 'utf8').trim().split('\n').length, 1);
  assert.equal(new JobStore(f).loadAll().length, 1);
});
