import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Hermetic, BEFORE the lm-assist imports: bootstrap serves the node-default profile's
// playbooks, read from the profile file under getDataDir(). Never the developer's real
// ~/.lm-assist.
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fid-bootstrap-'));
import { fleetIdentity } from '../mcp-server/fleet-identity';
import { GUIDE_HANDLERS } from '../mcp-server/tools/guide';

// Tests run via `node --test` from the `core/` dir → process.cwd() is core/.
const GUIDE_SRC = path.join(process.cwd(), 'src', 'mcp-server', 'tools', 'guide.ts');

test('fleetIdentity is non-empty + carries the multi-connector caveat', () => {
  assert.match(fleetIdentity(), /FLEET \/ CONNECTOR IDENTITY/);
});

test('guide.ts no longer hardcodes "langmart MCP connector"', () => {
  const src = fs.readFileSync(GUIDE_SRC, 'utf8');
  assert.doesNotMatch(src, /langmart MCP connector/);
});

test('bootstrap page 1 leads with fleetIdentity()', async () => {
  // Behavioral: page 1 (the no-arg session-start call) must OPEN with the fleet/connector
  // identity, ahead of the paged bootstrap body + manifest.
  const p1 = (await GUIDE_HANDLERS.bootstrap({})).content[0].text as string;
  assert.ok(p1.startsWith(fleetIdentity()), 'page 1 begins with the fleet identity block');
  assert.match(p1.slice(0, 400), /FLEET \/ CONNECTOR IDENTITY/);
});
