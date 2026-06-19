import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCacheDir, isDevRepo, getDataDir } from '../utils/path-utils';

/**
 * dev/prod-aware cache dirs: the dev (:3200) and prod (:3100) cores must NOT
 * share an LMDB store (or they contend on its write mutex and one hangs on
 * startup — root-caused 2026-06-20). prod (run from node_modules) keeps the
 * bare name (no migration); dev (run from the repo) gets a `-dev` suffix.
 */

test('isDevRepo honors LM_ASSIST_PROD=true (→ prod)', () => {
  const prev = process.env.LM_ASSIST_PROD;
  try {
    process.env.LM_ASSIST_PROD = 'true';
    assert.equal(isDevRepo(), false);
  } finally {
    if (prev === undefined) delete process.env.LM_ASSIST_PROD; else process.env.LM_ASSIST_PROD = prev;
  }
});

test('getCacheDir: prod uses the bare name (no suffix) — keeps the existing cache', () => {
  const prev = process.env.LM_ASSIST_PROD;
  try {
    process.env.LM_ASSIST_PROD = 'true';
    assert.equal(getCacheDir('session-cache'), `${getDataDir()}/session-cache`);
    assert.equal(getCacheDir('memory-cache'), `${getDataDir()}/memory-cache`);
  } finally {
    if (prev === undefined) delete process.env.LM_ASSIST_PROD; else process.env.LM_ASSIST_PROD = prev;
  }
});

test('getCacheDir: dev gets a -dev suffix — a separate store from prod', () => {
  const prev = process.env.LM_ASSIST_PROD;
  try {
    delete process.env.LM_ASSIST_PROD; // tests run from the repo → dev
    assert.equal(getCacheDir('session-cache'), `${getDataDir()}/session-cache-dev`);
    assert.notEqual(getCacheDir('session-cache'), `${getDataDir()}/session-cache`);
  } finally {
    if (prev === undefined) delete process.env.LM_ASSIST_PROD; else process.env.LM_ASSIST_PROD = prev;
  }
});
