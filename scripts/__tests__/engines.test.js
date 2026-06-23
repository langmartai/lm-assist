'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
function eng(rel) {
  const p = JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
  return p.engines && p.engines.node;
}

test('all package.json engines declare node >=20.9.0', () => {
  assert.strictEqual(eng('package.json'), '>=20.9.0');
  assert.strictEqual(eng('core/package.json'), '>=20.9.0');
  assert.strictEqual(eng('web/package.json'), '>=20.9.0');
});
