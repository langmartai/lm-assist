import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readDeclaredGrant, grantAllows } from '../grants';

function writeConfig(obj: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmui-cfg-'));
  fs.writeFileSync(path.join(dir, 'lmui.config.json'), JSON.stringify(obj));
  return dir;
}

test('reads and normalizes declared grants (verbs uppercased)', () => {
  const dir = writeConfig({ grant: [{ service: 'node', pathPrefix: '/backlog', verbs: ['get', 'Post'] }] });
  assert.deepEqual(readDeclaredGrant(dir), [{ service: 'node', pathPrefix: '/backlog', verbs: ['GET', 'POST'] }]);
});

test('missing config and malformed JSON yield an empty grant', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lmui-empty-'));
  assert.deepEqual(readDeclaredGrant(empty), []);
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmui-bad-'));
  fs.writeFileSync(path.join(badDir, 'lmui.config.json'), '{ not json');
  assert.deepEqual(readDeclaredGrant(badDir), []);
});

test('rules missing service or pathPrefix are dropped; non-array/absent grant → []', () => {
  const dir = writeConfig({ grant: [
    { pathPrefix: '/x', verbs: ['GET'] },                 // no service
    { service: 'node', verbs: ['GET'] },                  // no pathPrefix
    { service: 'node', pathPrefix: '/ok', verbs: ['GET'] },
  ] });
  assert.deepEqual(readDeclaredGrant(dir).map((r) => r.pathPrefix), ['/ok']);
  assert.deepEqual(readDeclaredGrant(writeConfig({ grant: 'nope' })), []);
  assert.deepEqual(readDeclaredGrant(writeConfig({})), []);
});

test('grantAllows enforces the segment boundary', () => {
  const grant = readDeclaredGrant(writeConfig({ grant: [{ service: 'node', pathPrefix: '/backlog', verbs: ['GET'] }] }));
  assert.ok(grantAllows(grant, 'node', '/backlog', 'GET'));
  assert.ok(grantAllows(grant, 'node', '/backlog/x', 'GET'));
  assert.ok(!grantAllows(grant, 'node', '/backlogx', 'GET')); // not a boundary
});

test('grantAllows checks verb (case-insensitive) and service', () => {
  const grant = readDeclaredGrant(writeConfig({ grant: [{ service: 'node', pathPrefix: '/data', verbs: ['post'] }] }));
  assert.ok(grantAllows(grant, 'node', '/data', 'POST'));
  assert.ok(grantAllows(grant, 'node', '/data', 'post')); // method case-insensitive
  assert.ok(!grantAllows(grant, 'node', '/data', 'GET'));  // verb not granted
  assert.ok(!grantAllows(grant, 'other', '/data', 'POST')); // wrong service
});

test('a trailing-slash prefix is its own boundary and matches deeper paths', () => {
  const grant = readDeclaredGrant(writeConfig({ grant: [{ service: 'node', pathPrefix: '/data/', verbs: ['GET'] }] }));
  assert.ok(grantAllows(grant, 'node', '/data/', 'GET'));
  assert.ok(grantAllows(grant, 'node', '/data/x/y', 'GET'));
  assert.ok(!grantAllows(grant, 'node', '/database', 'GET'));
});
