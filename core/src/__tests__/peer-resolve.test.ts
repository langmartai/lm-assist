import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectsMatchingRemote, resolvePeers } from '../memory/peer-resolve';

test('projectsMatchingRemote returns slugs whose cwd remote matches the key', () => {
  const projects = [
    { projectId: '-a', projectPath: '/home/u/lm-assist' },
    { projectId: '-b', projectPath: '/home/u/other' },
    { projectId: '-c', projectPath: '/home/u/nogit' },
  ];
  const remoteKeyOf = (cwd: string) =>
    cwd.endsWith('lm-assist') ? 'github.com/langmartai/lm-assist'
    : cwd.endsWith('other') ? 'github.com/x/other' : null;
  assert.deepEqual(projectsMatchingRemote(projects, 'github.com/langmartai/lm-assist', remoteKeyOf), ['-a']);
  assert.deepEqual(projectsMatchingRemote(projects, 'github.com/none/none', remoteKeyOf), []);
  assert.deepEqual(projectsMatchingRemote(projects, '', remoteKeyOf), []);
});

test('resolvePeers collects {node,slug} for fleet nodes sharing the remote', async () => {
  const slugsByRemote = async (node: string) => {
    if (node === 'gw-b') return ['-bb'];
    if (node === 'gw-c') return ['-cc1', '-cc2'];
    if (node === 'gw-d') throw new Error('unreachable');
    return []; // gw-e has the repo nowhere
  };
  const peers = await resolvePeers('github.com/langmartai/lm-assist', ['gw-b', 'gw-c', 'gw-d', 'gw-e'], slugsByRemote);
  assert.deepEqual(peers, [
    { node: 'gw-b', slug: '-bb' },
    { node: 'gw-c', slug: '-cc1' },
    { node: 'gw-c', slug: '-cc2' },
  ]); // gw-d (threw) + gw-e (empty) excluded
});

test('resolvePeers with no local remote → no peers', async () => {
  const peers = await resolvePeers('', ['gw-b'], async () => ['-x']);
  assert.deepEqual(peers, []);
});
