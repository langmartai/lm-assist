import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceV2Capability } from '../voice/voice-v2-capability';

test('available only when https + cookie + chrome all present', () => {
  assert.equal(voiceV2Capability({ httpsEnabled: true, cookiePresent: true, chromePath: '/usr/bin/google-chrome' }).available, true);
});
test('unavailable names the first missing precondition', () => {
  assert.match(voiceV2Capability({ httpsEnabled: false, cookiePresent: true, chromePath: '/x' }).reason, /https/i);
  assert.match(voiceV2Capability({ httpsEnabled: true, cookiePresent: false, chromePath: '/x' }).reason, /cookie/i);
  assert.match(voiceV2Capability({ httpsEnabled: true, cookiePresent: true, chromePath: null }).reason, /chrome/i);
});
