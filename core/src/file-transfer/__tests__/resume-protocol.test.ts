import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeControl, FrameReader } from '../frame';
import type { FtResumeState, FtCancel } from '../types';

test('FT_RESUME_STATE and FT_CANCEL round-trip through encodeControl/FrameReader', () => {
  const reader = new FrameReader();
  const rs: FtResumeState = { type: 'FT_RESUME_STATE', transferId: 't1', bytesDone: 4096 };
  const cx: FtCancel = { type: 'FT_CANCEL', transferId: 't1', reason: 'user' };
  const frames = [...reader.push(encodeControl(rs)), ...reader.push(encodeControl(cx))];
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0].kind === 'control' && frames[0].msg, rs);
  assert.deepEqual(frames[1].kind === 'control' && frames[1].msg, cx);
});
