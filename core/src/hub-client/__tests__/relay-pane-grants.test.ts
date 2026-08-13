/**
 * Every pane grant must be reachable over the hub relay.
 *
 * A pane's `service: "node"` grant authorizes a path on the gateway side, but the request
 * still has to pass the node-side relay allow-list (ALLOWED_API_PREFIXES). When a pane
 * ships a grant the relay refuses, the pane works on the node-local tier (which never
 * touches the relay) and is 100% broken on its hub URL — the way users actually open it.
 * That exact gap shipped twice in one batch (scheduler, skills: "Path not allowed"), so
 * this test pins the invariant: grant present ⇒ relay allows it.
 */
import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { ApiRelayHandler } from '../api-relay-handler';

function repoRoot(): string {
  let d = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'ui-apps')) && fs.existsSync(path.join(d, 'package.json'))) return d;
    d = path.dirname(d);
  }
  throw new Error(`could not locate the repo root above ${__dirname}`);
}

test('every ui-apps pane node-grant path passes the relay allow-list', () => {
  const uiApps = path.join(repoRoot(), 'ui-apps');
  const panes = fs.readdirSync(uiApps, { withFileTypes: true }).filter((e) => e.isDirectory());
  let checked = 0;
  for (const pane of panes) {
    const cfgPath = path.join(uiApps, pane.name, 'lmui.config.json');
    if (!fs.existsSync(cfgPath)) continue;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    for (const rule of cfg.grant ?? []) {
      if (rule.service !== 'node' || !rule.pathPrefix) continue;
      // A '*' grant segment matches any single path segment — substitute a literal so the
      // relay sees the shape of a real request ('/scheduler/jobs/*/run' → '.../x/run').
      const probe = String(rule.pathPrefix).replace(/\*/g, 'x');
      assert.ok(
        ApiRelayHandler.isApiPathAllowed(probe),
        `${pane.name}: grant path "${rule.pathPrefix}" is refused by the relay allow-list ` +
        `(ALLOWED_API_PREFIXES in api-relay-handler.ts) — the pane would break on its hub URL`
      );
      checked++;
    }
  }
  assert.ok(checked > 20, `sanity: expected to check >20 grant rules, saw ${checked}`);
});
