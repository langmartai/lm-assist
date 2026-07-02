import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as crypto from 'crypto';

export interface Source {
  size(): Promise<number>;
  sha256(): Promise<string>;
  read(offset: number, length: number): Promise<Buffer>;
}
export interface OpenSink {
  write(offset: number, chunk: Buffer): Promise<void>;
  finalize(): Promise<void>;
  abort(): Promise<void>;
}
export interface Sink {
  open(destPath: string, resumeFrom: number): Promise<OpenSink>;
  receivedBytes(destPath: string): Promise<number>;
}

export class FileSource implements Source {
  constructor(private readonly path: string) {}
  async size(): Promise<number> { return (await fsp.stat(this.path)).size; }
  async read(offset: number, length: number): Promise<Buffer> {
    const fd = await fsp.open(this.path, 'r');
    try { const buf = Buffer.allocUnsafe(length); const { bytesRead } = await fd.read(buf, 0, length, offset); return buf.subarray(0, bytesRead); }
    finally { await fd.close(); }
  }
  sha256(): Promise<string> {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256'); const rs = fs.createReadStream(this.path);
      rs.on('error', reject); rs.on('data', (d) => h.update(d)); rs.on('end', () => resolve(h.digest('hex')));
    });
  }
}

export class FileSink implements Sink {
  async receivedBytes(destPath: string): Promise<number> {
    try { return (await fsp.stat(destPath)).size; } catch { return 0; }
  }
  async open(destPath: string, resumeFrom: number): Promise<OpenSink> {
    await fsp.mkdir(require('path').dirname(destPath), { recursive: true });
    // resumeFrom>0 ⇒ keep existing bytes (r+); else truncate (w).
    const handle = await fsp.open(destPath, resumeFrom > 0 ? 'r+' : 'w');
    return {
      write: async (offset, chunk) => { await handle.write(chunk, 0, chunk.length, offset); },
      finalize: async () => { await handle.close(); },
      abort: async () => { await handle.close().catch(() => {}); await fsp.unlink(destPath).catch(() => {}); },
    };
  }
}
