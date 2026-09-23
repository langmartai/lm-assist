/**
 * The assist-mcp-tools pane (ui-apps/assist-mcp-tools/assets/app.js — plain JS, no build) carries
 * its own copy of the Connectors table model: connNormalize / connState / connStatusLines. Its
 * comments say "keep the two in step" with normalizeProfileConnectors & co. here; this test is
 * what holds them to it. It lifts those functions out of app.js VERBATIM and runs both copies over
 * the same wire bodies — including connectors pinned to an unknown profile and duplicated URLs,
 * which both copies used to drop.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  connectorStateLabel,
  connectorStatusLines,
  normalizeProfileConnectors,
  type ProfileConnectorsWire,
  type WireConn,
} from '@/lib/mcp-tools';

const APP_JS = readFileSync(fileURLToPath(new URL('../../../../ui-apps/assist-mcp-tools/assets/app.js', import.meta.url)), 'utf8');

/** The source of `function <name>(…) { … }` in app.js: brace-matched, skipping strings and
 *  comments (the lifted functions contain no regex literals). */
function lift(name: string): string {
  const start = APP_JS.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`app.js has no function ${name}`);
  let depth = 0;
  let quote: string | null = null;
  for (let i = APP_JS.indexOf('{', start); i < APP_JS.length; i++) {
    const ch = APP_JS[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && APP_JS[i + 1] === '/') { i = APP_JS.indexOf('\n', i); continue; }
    if (ch === '/' && APP_JS[i + 1] === '*') { i = APP_JS.indexOf('*/', i) + 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return APP_JS.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in app.js function ${name}`);
}

const CONNECT_STEP_SRC = /var CONNECT_STEP = ('[^']*');/.exec(APP_JS)?.[1];
if (!CONNECT_STEP_SRC) throw new Error('app.js has no CONNECT_STEP');
type PaneRow = Record<string, unknown>;
const pane = new Function(
  `var CONNECT_STEP = ${CONNECT_STEP_SRC};\n`
    + ['connNormalize', 'connDupNote', 'connState', 'connStatusLines'].map(lift).join('\n')
    + '\nreturn { connNormalize, connState, connStatusLines };',
)() as {
  connNormalize: (d: unknown) => { connectors: PaneRow[] } & Record<string, unknown>;
  connState: (row: PaneRow, err?: string | null) => { text: string; cls: string };
  connStatusLines: (d: unknown) => unknown[];
};

const conn = (uuid: string, name: string, connected: boolean, toolCount: number | null = 3): WireConn =>
  ({ uuid, name, connected, authStatus: connected ? 'authenticated' : 'auth_required', toolCount });
const BASE = 'https://mcp.langmart.ai';
const WIRE: ProfileConnectorsWire = {
  base: BASE, hub: 'langmart', nodeDefault: 'admin', claudeai: { ok: true },
  unpinned: { url: `${BASE}/mcp`, suggestedName: 'lm-assist langmart', connector: conn('u', 'lm-assist langmart', true, 320), duplicates: 1 },
  profiles: [
    { profile: 'basic', url: `${BASE}/mcp/basic`, suggestedName: 'lm-assist langmart basic', connector: conn('b', 'lm-assist langmart basic', false, 0), duplicates: 0 },
    { profile: 'extended', url: `${BASE}/mcp/extended`, suggestedName: 'lm-assist langmart extended', connector: null, duplicates: 0 },
    { profile: 'admin', url: `${BASE}/mcp/admin`, suggestedName: 'lm-assist langmart admin', connector: conn('a', 'lm-assist langmart admin', true, 320), duplicates: 2 },
  ],
  unknownPins: [
    { profile: 'nextgen', url: `${BASE}/mcp/nextgen`, connector: conn('n', 'from a newer build', true) },
    { profile: 'basci', url: `${BASE}/mcp/basci`, connector: conn('t1', 'typo (dead)', false) },
    { profile: 'basci', url: `${BASE}/mcp/basci`, connector: conn('t2', 'typo (live)', true) },
  ],
};

describe('assist-mcp-tools pane ↔ web lib: the Connectors model stays in step', () => {
  it('connNormalize === normalizeProfileConnectors (unknown pins and duplicates carried, not dropped)', () => {
    const web = normalizeProfileConnectors(WIRE);
    expect(pane.connNormalize(WIRE)).toEqual(web);
    expect(web.connectors.map((r) => r.profile)).toEqual([null, 'basic', 'extended', 'admin', 'nextgen', 'basci']);
  });
  it('connStatusLines === connectorStatusLines — one line per connector of this hub, unknown pins included', () => {
    const lines = connectorStatusLines(normalizeProfileConnectors(WIRE));
    expect(pane.connStatusLines(pane.connNormalize(WIRE))).toEqual(lines);
    expect(lines.map((l) => l.label)).toEqual([
      'Connector', 'Connector · basic', 'Connector · admin',
      'Connector · nextgen (unknown profile)', 'Connector · basci (unknown profile)',
    ]);
  });
  it('connState text === connectorStateLabel text for every row, with and without a claude.ai error', () => {
    const rows = normalizeProfileConnectors(WIRE).connectors;
    for (const err of [null, 'no claude.ai cookie on this node']) {
      for (const row of rows) {
        expect(pane.connState(row as unknown as PaneRow, err).text, `${row.profile} (${err})`).toBe(connectorStateLabel(row, err).text);
      }
    }
  });
  it('the unreadable-claude.ai and no-hub states agree too', () => {
    const down = { ...WIRE, claudeai: { ok: false, error: 'no cookie' } };
    expect(pane.connStatusLines(pane.connNormalize(down))).toEqual(connectorStatusLines(normalizeProfileConnectors(down)));
    const noHub = { base: null, nodeDefault: '', connectors: [], claudeaiError: null };
    expect(pane.connStatusLines(noHub)).toEqual(connectorStatusLines(noHub));
  });
});
