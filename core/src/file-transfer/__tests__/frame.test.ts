/**
 * Unit tests for the file-transfer framing layer + path-traversal guard.
 *
 * No transport, no hub, no filesystem writes for the framing tests — an
 * in-memory fake Channel pair carries the bytes. The sender/receiver
 * integration is exercised end-to-end through a fake Channel into a temp dir.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import {
  FrameReader,
  encodeControl,
  encodeData,
  decodePayload,
} from '../frame';
import { safeJoin, UnsafePathError } from '../safe-path';
import type { Channel } from '../../transport';
import type { FtMeta } from '../types';
import { handleIncomingTransfer } from '../receiver';
import { encodeControl as enc } from '../frame';

// ---- In-memory fake Channel pair -------------------------------------------

interface FakePair {
  a: Channel;
  b: Channel;
}

/**
 * Two linked channels. Bytes written to a.send arrive on b's onData and vice
 * versa, asynchronously (microtask) to mimic real ordered delivery. We also
 * randomly split sends to prove the FrameReader re-assembles correctly.
 */
function makeFakePair(splitBytes = false): FakePair {
  let aData: ((d: Buffer) => void) | null = null;
  let bData: ((d: Buffer) => void) | null = null;
  let aClose: ((r?: string) => void) | null = null;
  let bClose: ((r?: string) => void) | null = null;
  let closed = false;

  const deliver = (cb: () => void) => Promise.resolve().then(cb);

  const pump = (to: () => ((d: Buffer) => void) | null, data: Buffer) => {
    if (closed) {
      return;
    }
    if (splitBytes && data.length > 3) {
      const mid = Math.floor(data.length / 2);
      void deliver(() => to()?.(data.subarray(0, mid)));
      void deliver(() => to()?.(data.subarray(mid)));
    } else {
      void deliver(() => to()?.(data));
    }
  };

  const a: Channel = {
    id: 'fake-a',
    peerGatewayId: 'peer-b',
    mode: 'relay',
    send: (d) => pump(() => bData, d),
    onData: (cb) => {
      aData = cb;
    },
    onClose: (cb) => {
      aClose = cb;
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      void deliver(() => aClose?.());
      void deliver(() => bClose?.());
    },
  };
  const b: Channel = {
    id: 'fake-b',
    peerGatewayId: 'peer-a',
    mode: 'relay',
    send: (d) => pump(() => aData, d),
    onData: (cb) => {
      bData = cb;
    },
    onClose: (cb) => {
      bClose = cb;
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      void deliver(() => aClose?.());
      void deliver(() => bClose?.());
    },
  };
  return { a, b };
}

// ---- Framing round-trip -----------------------------------------------------

test('control frame round-trips through FrameReader', () => {
  const meta: FtMeta = {
    type: 'FT_META',
    transferId: 't1',
    root: 'dest',
    entries: [{ relPath: 'a.txt', size: 3, mode: 0o644, isDir: false }],
    totalBytes: 3,
  };
  const reader = new FrameReader();
  const frames = reader.push(encodeControl(meta));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, 'control');
  if (frames[0].kind === 'control') {
    assert.deepEqual(frames[0].msg, meta);
  }
  assert.equal(reader.pending(), 0);
});

test('binary data frame round-trips with correct header', () => {
  const payload = Buffer.from('hello world bytes');
  const reader = new FrameReader();
  const frames = reader.push(encodeData('tx-42', 7, 1024, payload));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, 'data');
  if (frames[0].kind === 'data') {
    assert.equal(frames[0].entryIndex, 7);
    assert.equal(frames[0].offset, 1024);
    assert.deepEqual(frames[0].bytes, payload);
  }
});

test('FrameReader re-assembles frames split across chunks', () => {
  const f1 = encodeControl({ type: 'FT_OK', transferId: 'x' });
  const f2 = encodeData('x', 0, 0, Buffer.from('abcdef'));
  const combined = Buffer.concat([f1, f2]);
  const reader = new FrameReader();
  const out: ReturnType<FrameReader['push']> = [];
  // Feed one byte at a time — worst-case fragmentation.
  for (const byte of combined) {
    out.push(...reader.push(Buffer.from([byte])));
  }
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'control');
  assert.equal(out[1].kind, 'data');
  assert.equal(reader.pending(), 0);
});

test('FrameReader yields multiple frames from one chunk', () => {
  const combined = Buffer.concat([
    encodeControl({ type: 'FT_OK', transferId: '1' }),
    encodeControl({ type: 'FT_OK', transferId: '2' }),
    encodeControl({ type: 'FT_OK', transferId: '3' }),
  ]);
  const reader = new FrameReader();
  const frames = reader.push(combined);
  assert.equal(frames.length, 3);
});

test('decodePayload rejects unknown kind', () => {
  assert.throws(() => decodePayload(Buffer.from([0x09, 1, 2, 3])), /unknown kind/);
});

// ---- Path-traversal guard ---------------------------------------------------

test('safeJoin accepts normal relative paths', () => {
  const root = '/srv/received';
  assert.equal(safeJoin(root, 'a/b/c.txt'), path.resolve(root, 'a/b/c.txt'));
  assert.equal(safeJoin(root, './x.txt'), path.resolve(root, 'x.txt'));
});

test('safeJoin rejects parent-traversal "../etc/x"', () => {
  assert.throws(() => safeJoin('/srv/received', '../etc/x'), UnsafePathError);
  assert.throws(
    () => safeJoin('/srv/received', 'a/../../etc/passwd'),
    UnsafePathError,
  );
});

test('safeJoin rejects absolute "/abs"', () => {
  assert.throws(() => safeJoin('/srv/received', '/abs'), UnsafePathError);
  assert.throws(() => safeJoin('/srv/received', '/etc/passwd'), UnsafePathError);
});

test('safeJoin rejects empty and drive-letter paths', () => {
  assert.throws(() => safeJoin('/srv/received', ''), UnsafePathError);
  assert.throws(() => safeJoin('/srv/received', 'C:/win'), UnsafePathError);
});

// ---- Receiver end-to-end over fake channel ----------------------------------

test('handleIncomingTransfer writes a file and replies FT_OK', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ft-recv-'));
  const { a, b } = makeFakePair(true);

  // b is the receiver side.
  const recvDone = handleIncomingTransfer(b, { root: tmp });

  // a is the sender side: collect replies.
  const reader = new FrameReader();
  const okSeen = new Promise<void>((resolve, reject) => {
    a.onData((d) => {
      for (const f of reader.push(d)) {
        if (f.kind === 'control' && f.msg.type === 'FT_OK') {
          resolve();
        }
        if (f.kind === 'control' && f.msg.type === 'FT_ERR') {
          reject(new Error('got FT_ERR'));
        }
      }
    });
  });

  const body = Buffer.from('the quick brown fox');
  const sha = require('crypto')
    .createHash('sha256')
    .update(body)
    .digest('hex');
  const meta: FtMeta = {
    type: 'FT_META',
    transferId: 'e2e',
    root: 'sub',
    entries: [{ relPath: 'note.txt', size: body.length, mode: 0o600, isDir: false }],
    totalBytes: body.length,
  };
  a.send(enc(meta));
  a.send(encodeData('e2e', 0, 0, body));
  a.send(
    enc({ type: 'FT_END', transferId: 'e2e', sha256PerEntry: [sha] }),
  );

  await okSeen;
  await recvDone;

  const written = await fsp.readFile(path.join(tmp, 'sub', 'note.txt'));
  assert.deepEqual(written, body);
  const st = fs.statSync(path.join(tmp, 'sub', 'note.txt'));
  assert.equal(st.mode & 0o777, 0o600);

  await fsp.rm(tmp, { recursive: true, force: true });
});

test('handleIncomingTransfer rejects sha256 mismatch with FT_ERR', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ft-recv-'));
  const { a, b } = makeFakePair();
  const recvDone = handleIncomingTransfer(b, { root: tmp });

  const reader = new FrameReader();
  const errSeen = new Promise<string>((resolve) => {
    a.onData((d) => {
      for (const f of reader.push(d)) {
        if (f.kind === 'control' && f.msg.type === 'FT_ERR') {
          resolve(f.msg.error);
        }
      }
    });
  });

  const body = Buffer.from('payload');
  const meta: FtMeta = {
    type: 'FT_META',
    transferId: 'bad',
    root: '.',
    entries: [{ relPath: 'x.bin', size: body.length, mode: 0o644, isDir: false }],
    totalBytes: body.length,
  };
  a.send(enc(meta));
  a.send(encodeData('bad', 0, 0, body));
  a.send(enc({ type: 'FT_END', transferId: 'bad', sha256PerEntry: ['deadbeef'] }));

  const err = await errSeen;
  assert.match(err, /sha256 mismatch/);
  await recvDone;
  await fsp.rm(tmp, { recursive: true, force: true });
});

test('handleIncomingTransfer rejects traversal relPath with FT_ERR', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ft-recv-'));
  const { a, b } = makeFakePair();
  const recvDone = handleIncomingTransfer(b, { root: tmp });

  const reader = new FrameReader();
  const errSeen = new Promise<string>((resolve) => {
    a.onData((d) => {
      for (const f of reader.push(d)) {
        if (f.kind === 'control' && f.msg.type === 'FT_ERR') {
          resolve(f.msg.error);
        }
      }
    });
  });

  const meta: FtMeta = {
    type: 'FT_META',
    transferId: 'evil',
    root: '.',
    entries: [{ relPath: '../escape.txt', size: 1, mode: 0o644, isDir: false }],
    totalBytes: 1,
  };
  a.send(enc(meta));

  const err = await errSeen;
  assert.match(err, /unsafe path/);
  // Nothing escaped the temp root.
  assert.equal(fs.existsSync(path.join(path.dirname(tmp), 'escape.txt')), false);
  await recvDone;
  await fsp.rm(tmp, { recursive: true, force: true });
});
