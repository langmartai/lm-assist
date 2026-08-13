// Which cloud handle (`cse`) belongs to the controller — and how a HUMAN's session got driven.
//
// Incident 2026-08-13 (117): a controller pass directive, cmd id and all, was enqueued into a
// human's Claude Code session (`d15a717d`, and `cbe87447` the day before). It arrived over that
// session's REMOTE CONTROL BRIDGE — the transcript line before it is
// {"type":"bridge-session","bridgeSessionId":"cse_…"} — not over tmux.
//
// The launch bound `cs.cse` with pickNewSession(): "any cloud session in the ACCOUNT list that
// was not there 40 seconds ago". Nothing tied that candidate to the session we had just
// launched, and a human running `claude --remote-control` registers in exactly that list
// (verified: this session appears in ccr_cloud_list). Adopt a stranger's handle once and EVERY
// later cloud drive — the controller's pass directive — is delivered into their composer.
//
// The session's own transcript is authoritative: the CLI writes `/remote-control is active …
// https://claude.ai/code/<sid>` into it (extractBridgeSid). Ask the session we launched; never
// infer from who else showed up.
import { test } from 'node:test';
import assert from 'node:assert';
import { pickControllerCse } from '../mission/mission-controller';

const OWN = 'session_01Tj5GJRtpzQTT49b9S5UDYK';   // what the launched controller declares
const HUMAN = 'session_01AawAPn8Nc6vQQf9xxM7caw'; // a human's bridge that appeared in the window

test('the launched session\'s OWN declared bridge wins over anything the poll saw', () => {
  assert.equal(
    pickControllerCse({ nativeSessionId: 'uuid-1', ownBridgeSid: OWN, discovered: HUMAN }),
    OWN,
  );
});

test('a native controller with no declared bridge yet binds NOTHING — never the poll\'s guess', () => {
  // THE regression: this is where a human's cse used to be adopted. Leaving it null is safe —
  // the supervisor's bridge-sid backfill fills it in later from the same authoritative source.
  assert.equal(
    pickControllerCse({ nativeSessionId: 'uuid-1', ownBridgeSid: null, discovered: HUMAN }),
    null,
  );
});

test('no native session (the handle is unfillable) — the poll is all there is', () => {
  assert.equal(
    pickControllerCse({ nativeSessionId: null, ownBridgeSid: null, discovered: OWN }),
    OWN,
  );
  assert.equal(
    pickControllerCse({ nativeSessionId: '', ownBridgeSid: null, discovered: null }),
    null,
  );
});

test('nothing anywhere → null, not undefined', () => {
  assert.equal(
    pickControllerCse({ nativeSessionId: 'uuid-1', ownBridgeSid: null, discovered: null }),
    null,
  );
});
