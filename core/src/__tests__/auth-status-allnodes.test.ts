import { test } from 'node:test';
import assert from 'node:assert';
import { formatAllNodes } from '../mcp-server/tools/auth-status';

test('formatAllNodes: one line per node with both creds', () => {
  const s = formatAllNodes([
    { node: 'A', oauth: 'valid', cookie: 'ok' },
    { node: 'B', oauth: 'EXPIRED', cookie: 'session_expired' },
  ]);
  assert.match(s, /A/); assert.match(s, /B/);
  assert.match(s, /EXPIRED/); assert.match(s, /session_expired/);
});
test('formatAllNodes: empty → a clear message', () => {
  assert.match(formatAllNodes([]), /no nodes|none/i);
});
