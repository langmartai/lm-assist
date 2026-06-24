'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const path = require('node:path');

const BIN = path.join(__dirname, '..', '..', 'bin', 'lm-assist.js');

// isNpmGreater is exported when bin/lm-assist.js is required with LM_ASSIST_NO_RUN=1 (guard added in Step 3).
test('isNpmGreater: only true when latest > installed', () => {
  process.env.LM_ASSIST_NO_RUN = '1';
  delete require.cache[require.resolve('../../bin/lm-assist.js')];
  const { isNpmGreater } = require('../../bin/lm-assist.js');
  assert.strictEqual(isNpmGreater('0.1.75', '0.1.76'), true);
  assert.strictEqual(isNpmGreater('0.1.76', '0.1.76'), false);
  assert.strictEqual(isNpmGreater('0.1.76', '0.1.75'), false); // installed ahead → NOT an update
  assert.strictEqual(isNpmGreater('0.1.76', '0.2.0'), true);
  assert.strictEqual(isNpmGreater('0.1.9', '0.1.10'), true);   // numeric, not lexical
  delete process.env.LM_ASSIST_NO_RUN;
});
