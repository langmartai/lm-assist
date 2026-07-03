import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import * as crypto from 'crypto';
import { FileSource, FileSink } from '../payload';

test('FileSource reads at offset + hashes; FileSink writes at offset + finalizes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-'));
  const src = path.join(dir, 'in.bin'); const dst = path.join(dir, 'out.bin');
  const data = Buffer.alloc(10000, 9); fs.writeFileSync(src, data);
  const s = new FileSource(src);
  assert.equal(await s.size(), 10000);
  assert.equal((await s.read(4000, 100)).length, 100);

  // read() past EOF returns only the remaining bytes, not the requested length.
  const pastEof = await s.read(9900, 500);
  assert.equal(pastEof.length, 100);

  // sha256() matches an independently computed hash of the source bytes.
  const expectedHash = crypto.createHash('sha256').update(data).digest('hex');
  assert.equal(await s.sha256(), expectedHash);

  const sink = new FileSink();
  const open = await sink.open(dst, 0);
  await open.write(0, await s.read(0, 6000));
  await open.write(6000, await s.read(6000, 4000));
  await open.finalize();
  assert.deepEqual(fs.readFileSync(dst), data);
  assert.equal(await sink.receivedBytes(dst), 10000);
});

test('FileSink resume: reopening with resumeFrom preserves existing bytes and appends the tail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-resume-'));
  const dst = path.join(dir, 'out.bin');
  const head = Buffer.alloc(4000, 7);
  const tail = Buffer.alloc(6000, 3);
  const full = Buffer.concat([head, tail]);

  const sink = new FileSink();
  // First pass: write only the head, then finalize (simulating an interrupted transfer).
  const firstOpen = await sink.open(dst, 0);
  await firstOpen.write(0, head);
  await firstOpen.finalize();
  assert.equal(await sink.receivedBytes(dst), head.length);

  // Resume: reopen with resumeFrom = existing length, write the tail at the correct offset.
  const resumeOpen = await sink.open(dst, head.length);
  await resumeOpen.write(head.length, tail);
  await resumeOpen.finalize();

  const result = fs.readFileSync(dst);
  assert.deepEqual(result.subarray(0, head.length), head); // pre-existing bytes survived, not truncated
  assert.deepEqual(result, full); // whole file matches the expected full content
  assert.equal(await sink.receivedBytes(dst), full.length);
});
