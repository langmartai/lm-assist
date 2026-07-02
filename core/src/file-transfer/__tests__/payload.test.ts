import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { FileSource, FileSink } from '../payload';

test('FileSource reads at offset + hashes; FileSink writes at offset + finalizes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-'));
  const src = path.join(dir, 'in.bin'); const dst = path.join(dir, 'out.bin');
  const data = Buffer.alloc(10000, 9); fs.writeFileSync(src, data);
  const s = new FileSource(src);
  assert.equal(await s.size(), 10000);
  assert.equal((await s.read(4000, 100)).length, 100);
  const sink = new FileSink();
  const open = await sink.open(dst, 0);
  await open.write(0, await s.read(0, 6000));
  await open.write(6000, await s.read(6000, 4000));
  await open.finalize();
  assert.deepEqual(fs.readFileSync(dst), data);
  assert.equal(await sink.receivedBytes(dst), 10000);
});
