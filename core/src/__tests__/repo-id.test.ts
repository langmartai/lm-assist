import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOriginRepo, repoOf, repoLabel } from '../utils/repo-id';

const SRC = join(__dirname, '..', '..', 'src'); // compiled test at core/dist-test/__tests__/
const src = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const cfg = (url: string) => `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;

test('parseOriginRepo — scp-style git@host:owner/repo.git → owner/repo', () => {
  assert.equal(parseOriginRepo(cfg('git@github.com:langmartai/lm-assist.git')), 'langmartai/lm-assist');
});

test('parseOriginRepo — https without .git → owner/repo', () => {
  assert.equal(parseOriginRepo(cfg('https://github.com/owner/repo')), 'owner/repo');
});

test('parseOriginRepo — https with .git → owner/repo', () => {
  assert.equal(parseOriginRepo(cfg('https://github.com/owner/repo.git')), 'owner/repo');
});

test('parseOriginRepo — ssh:// url → owner/repo', () => {
  assert.equal(parseOriginRepo(cfg('ssh://git@github.com/owner/repo.git')), 'owner/repo');
});

test('parseOriginRepo — picks the origin remote, not another remote', () => {
  const multi = `[remote "upstream"]\n\turl = git@github.com:up/stream.git\n[remote "origin"]\n\turl = git@github.com:me/mine.git\n`;
  assert.equal(parseOriginRepo(multi), 'me/mine');
});

test('parseOriginRepo — no origin / garbage → null', () => {
  assert.equal(parseOriginRepo('[core]\n\tbare = false\n'), null);
  assert.equal(parseOriginRepo(''), null);
});

test('repoOf — git cwd yields project leaf + repo (injected reader)', () => {
  const r = repoOf('/home/ubuntu/lm-assist', () => cfg('git@github.com:langmartai/lm-assist.git'));
  assert.deepEqual(r, { project: 'lm-assist', repo: 'langmartai/lm-assist' });
});

test('repoOf — Windows-style path leaf is extracted cross-platform', () => {
  const r = repoOf('C:\\Users\\yi\\code\\lm-assist', () => cfg('git@github.com:langmartai/lm-assist.git'));
  assert.equal(r?.project, 'lm-assist');
});

test('repoOf — non-git cwd (reader throws) yields project only', () => {
  const r = repoOf('/tmp/scratch', () => { throw new Error('ENOENT'); });
  assert.deepEqual(r, { project: 'scratch', repo: undefined });
});

test('repoOf — empty/invalid cwd → null', () => {
  assert.equal(repoOf(''), null);
  assert.equal(repoOf(undefined), null);
});

test('repoLabel — compact forms', () => {
  // repoLabel reads the local disk (memoized); a non-existent cwd → project only or ''.
  assert.equal(repoLabel(''), '');
  assert.equal(repoLabel('/definitely/not/a/real/dir/zzz-scratch'), 'zzz-scratch');
});

test('wiring — session resource tools surface project/repo via repoOfCached', () => {
  assert.match(src('mcp-server/tools/list-recent-sessions.ts'), /repoOfCached\(cd\?\.cwd\)/,
    'list_recent_sessions must derive project/repo from each session cwd');
  assert.match(src('mcp-server/tools/detail.ts'), /repoOfCached\(cd\.cwd\)/,
    'session detail must derive repo from the session cwd');
  assert.match(src('mcp-server/tools/expanded.ts'), /repoOfCached\(merged\.cwd\)/,
    'get_execution must derive project/repo from the execution cwd');
});

test('wiring — get_execution response carries cwd for provenance', () => {
  assert.match(src('api/agent-api.ts'), /cwd: entry\.request\.cwd \|\| undefined/,
    'getExecution must include cwd in its response');
  assert.match(src('types/agent-api.ts'), /cwd\?: string;/,
    'AgentExecutionStatusResponse must declare cwd');
});
