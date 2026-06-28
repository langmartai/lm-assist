import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fleetIdentity } from '../mcp-server/fleet-identity';

// Tests run via `node --test` from the `core/` dir → process.cwd() is core/.
const GUIDE_SRC = path.join(process.cwd(), 'src', 'mcp-server', 'tools', 'guide.ts');

test('fleetIdentity is non-empty + carries the multi-connector caveat', () => {
  assert.match(fleetIdentity(), /FLEET \/ CONNECTOR IDENTITY/);
});

test('guide.ts no longer hardcodes "langmart MCP connector"', () => {
  const src = fs.readFileSync(GUIDE_SRC, 'utf8');
  assert.doesNotMatch(src, /langmart MCP connector/);
});

test('handleBootstrap prepends fleetIdentity() to the response', () => {
  const src = fs.readFileSync(GUIDE_SRC, 'utf8');
  // The bootstrap assembly must put fleetIdentity() ahead of BOOTSTRAP.
  assert.match(src, /ok\(fleetIdentity\(\)\s*\+\s*'\\n\\n'\s*\+\s*BOOTSTRAP/);
});
