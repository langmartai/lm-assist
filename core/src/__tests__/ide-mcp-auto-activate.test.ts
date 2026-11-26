import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ideMcpOptOutFilePath,
  isIdeMcpOptedOut,
  readIdeMcpOptOuts,
  runAutoIdeMcpActivation,
  setIdeMcpOptOut,
} from '../utils/ide-mcp-optout';

test('ide-mcp-optout tracks deactivation state and gates auto-activation cleanly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ide-mcp-optout-'));
  try {
    assert.equal(isIdeMcpOptedOut('antigravity', tmpDir), false);
    assert.deepEqual(readIdeMcpOptOuts(tmpDir), {});

    let agyActivated = 0;
    let geminiActivated = 0;

    // 1. Detected + uninstalled -> activates antigravity; undetected gemini-cli is skipped.
    const first = runAutoIdeMcpActivation(
      [
        {
          id: 'antigravity',
          detected: true,
          installed: false,
          activate: () => {
            agyActivated++;
          },
        },
        {
          id: 'gemini-cli',
          detected: false,
          installed: false,
          activate: () => {
            geminiActivated++;
          },
        },
      ],
      { dataDir: tmpDir, disabled: false },
    );
    assert.deepEqual(first.activated, ['antigravity']);
    assert.equal(agyActivated, 1);
    assert.equal(geminiActivated, 0);
    assert.deepEqual(first.skipped, [{ id: 'gemini-cli', reason: 'not_detected' }]);

    // 2. Persisting opt-out blocks subsequent auto-activation even when detected and uninstalled.
    setIdeMcpOptOut('antigravity', true, tmpDir);
    assert.equal(isIdeMcpOptedOut('antigravity', tmpDir), true);
    assert.ok(fs.existsSync(ideMcpOptOutFilePath(tmpDir)));

    const second = runAutoIdeMcpActivation(
      [
        {
          id: 'antigravity',
          detected: true,
          installed: false,
          activate: () => {
            agyActivated++;
          },
        },
        {
          id: 'gemini-cli',
          detected: true,
          installed: true,
          activate: () => {
            geminiActivated++;
          },
        },
      ],
      { dataDir: tmpDir, disabled: false },
    );
    assert.deepEqual(second.activated, []);
    assert.equal(agyActivated, 1);
    assert.deepEqual(second.skipped, [
      { id: 'antigravity', reason: 'opted_out' },
      { id: 'gemini-cli', reason: 'already_installed' },
    ]);

    // 3. Clearing opt-out allows activation again (unless disabled=true).
    setIdeMcpOptOut('antigravity', false, tmpDir);
    assert.equal(isIdeMcpOptedOut('antigravity', tmpDir), false);

    const disabledRun = runAutoIdeMcpActivation(
      [
        {
          id: 'antigravity',
          detected: true,
          installed: false,
          activate: () => {
            agyActivated++;
          },
        },
      ],
      { dataDir: tmpDir, disabled: true },
    );
    assert.deepEqual(disabledRun.activated, []);
    assert.deepEqual(disabledRun.skipped, [{ id: 'antigravity', reason: 'disabled' }]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
