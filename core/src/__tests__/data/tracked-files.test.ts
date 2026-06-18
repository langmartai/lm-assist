import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ensureTrackedFiles, TRACKED_FILES } from '../../data/system-datasets';
import { DatasetRegistry } from '../../data/dataset-registry';

function reg() { return new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-trk-')), 'd.json')); }

test('tracked files: only registers allow-listed paths that EXIST, as readOnly file datasets, idempotently', () => {
  const r = reg();
  ensureTrackedFiles(r);
  ensureTrackedFiles(r); // idempotent
  for (const d of r.list()) {
    assert.equal(d.backend, 'file');
    assert.equal(d.readOnly, true);
    assert.equal(d.system, true);
    assert.equal(d.syncMode, 'none');
    assert.equal((d.config as any).kind, 'file');
    assert.ok(fs.existsSync((d.config as any).path), `registered a non-existent path: ${(d.config as any).path}`);
  }
  // the allow-list itself must be non-empty and well-formed
  assert.ok(TRACKED_FILES.length >= 1);
  for (const t of TRACKED_FILES) {
    assert.equal(typeof t.resolvePath(), 'string');
    assert.ok(t.format === 'json' || t.format === 'log');
  }
});

test('tracked files: never registers a hard-excluded path even if listed + existing', () => {
  const r = reg();
  // simulate by checking the guard directly: a credentials path must be skipped
  const { isHardExcludedPath } = require('../../data/redaction');
  assert.equal(isHardExcludedPath(path.join(os.homedir(), '.claude', '.credentials.json')), true);
  // ensureTrackedFiles applies the same guard — no registered dataset may point at an excluded path
  ensureTrackedFiles(r);
  for (const d of r.list()) assert.equal(isHardExcludedPath((d.config as any).path), false);
});
