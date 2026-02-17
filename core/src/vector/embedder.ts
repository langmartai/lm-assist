/**
 * Embedder Module
 *
 * Local text embedding using transformers.js (all-MiniLM-L6-v2).
 * Generates 384-dimensional vectors for semantic search.
 *
 * ONNX inference runs on a dedicated worker thread so it never blocks
 * the main Node.js event loop — even during heavy batch operations.
 *
 * Loads model lazily on first use (~2-3s). Subsequent calls are fast (~5ms).
 */

import * as path from 'path';
import { Worker } from 'worker_threads';
import { getDataDir } from '../utils/path-utils';

const VECTOR_DIM = 384;

export class Embedder {
  private worker: Worker | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private requestId = 0;
  private pending = new Map<number, {
    resolve: (embeddings: number[][]) => void;
    reject: (err: Error) => void;
  }>();

  /**
   * Start the worker thread and wait for model load.
   */
  async load(): Promise<void> {
    if (this.ready) return;
    if (this.readyPromise) {
      await this.readyPromise;
      return;
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const startTime = Date.now();
      console.log('[Embedder] Starting worker thread...');

      const workerPath = path.join(__dirname, 'embedder-worker.js');
      this.worker = new Worker(workerPath, {
        env: {
          ...process.env,
          LM_ASSIST_DATA_DIR: getDataDir(),
        },
      });

      this.worker.on('message', (msg: any) => {
        if (msg.type === 'ready') {
          this.ready = true;
          console.log(`[Embedder] Worker ready in ${Date.now() - startTime}ms`);
          resolve();
        } else if (msg.type === 'result') {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            p.resolve(msg.embeddings);
          }
        } else if (msg.type === 'error') {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            p.reject(new Error(msg.message));
          }
        }
      });

      this.worker.on('error', (err) => {
        console.error('[Embedder] Worker error:', err);
        // Reject all pending requests
        for (const [, p] of this.pending) {
          p.reject(err);
        }
        this.pending.clear();
        reject(err);
      });

      this.worker.on('exit', (code) => {
        if (code !== 0) {
          console.error(`[Embedder] Worker exited with code ${code}`);
        }
        this.worker = null;
        this.ready = false;
        this.readyPromise = null;
      });
    });

    await this.readyPromise;
  }

  /**
   * Send texts to the worker and receive embeddings back.
   * Fully async — does not block the main event loop.
   */
  private async requestEmbed(texts: string[]): Promise<number[][]> {
    await this.load();
    if (!this.worker) throw new Error('Embedder worker not available');

    const id = this.requestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ type: 'embed', id, texts });
    });
  }

  /**
   * Embed a single text string into a 384-dim vector
   */
  async embed(text: string): Promise<number[]> {
    const [result] = await this.requestEmbed([text]);
    return result;
  }

  /**
   * Embed multiple texts in batch.
   * Runs entirely on the worker thread — zero main-thread blocking.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.requestEmbed(texts);
  }

  /**
   * Check if model is loaded
   */
  isLoaded(): boolean {
    return this.ready;
  }

  /**
   * Get vector dimension
   */
  getDimension(): number {
    return VECTOR_DIM;
  }
}

// Singleton
let instance: Embedder | null = null;

export function getEmbedder(): Embedder {
  if (!instance) {
    instance = new Embedder();
  }
  return instance;
}

export { VECTOR_DIM };
