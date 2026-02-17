/**
 * Embedder Module
 *
 * Local text embedding using transformers.js (all-MiniLM-L6-v2).
 * Generates 384-dimensional vectors for semantic search via Vectra.
 *
 * Loads model lazily on first use (~2-3s). Subsequent calls are fast (~5ms).
 */

import * as path from 'path';
import { getDataDir } from '../utils/path-utils';

// Dynamic import for ESM-only transformers.js
let pipelineModule: any = null;

async function getTransformers(): Promise<any> {
  if (!pipelineModule) {
    const mod = await import('@huggingface/transformers');
    // Configure cache directory
    mod.env.cacheDir = path.join(getDataDir(), 'models');
    mod.env.allowRemoteModels = true;
    mod.env.useFSCache = true;
    pipelineModule = mod;
  }
  return pipelineModule;
}

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const VECTOR_DIM = 384;

const yieldToEventLoop = () => new Promise<void>(r => setImmediate(r));

export class Embedder {
  private extractor: any = null;
  private loading: Promise<void> | null = null;

  /**
   * Load the embedding model (lazy, called on first embed)
   */
  async load(): Promise<void> {
    if (this.extractor) return;
    if (this.loading) {
      await this.loading;
      return;
    }

    this.loading = (async () => {
      const startTime = Date.now();
      console.log('[Embedder] Loading model:', MODEL_NAME);
      const { pipeline } = await getTransformers();
      this.extractor = await pipeline('feature-extraction', MODEL_NAME, {
        quantized: true,
      });
      console.log(`[Embedder] Model loaded in ${Date.now() - startTime}ms`);
    })();

    await this.loading;
  }

  /**
   * Embed a single text string into a 384-dim vector
   */
  async embed(text: string): Promise<number[]> {
    await this.load();

    // Truncate very long texts to avoid OOM (model max ~512 tokens)
    const truncated = text.length > 2000 ? text.slice(0, 2000) : text;

    const output = await this.extractor(truncated, {
      pooling: 'mean',
      normalize: true,
    });

    // output.data is a TypedArray, convert to regular array
    return Array.from(output.data as Float32Array).slice(0, VECTOR_DIM);
  }

  /**
   * Embed multiple texts in batch
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    await this.load();

    const results: number[][] = [];
    // Process in batches — MiniLM is small enough for larger batches
    const BATCH_SIZE = 64;

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE).map(t =>
        t.length > 2000 ? t.slice(0, 2000) : t
      );

      const outputs = await this.extractor(batch, {
        pooling: 'mean',
        normalize: true,
      });

      // outputs.data is a flat Float32Array of shape [batch_size * VECTOR_DIM]
      // This relies on mean pooling producing one VECTOR_DIM vector per input.
      const data = Array.from(outputs.data as Float32Array);
      for (let j = 0; j < batch.length; j++) {
        const start = j * VECTOR_DIM;
        results.push(data.slice(start, start + VECTOR_DIM));
      }

      // Yield to event loop between batches to avoid blocking the server
      if (i + BATCH_SIZE < texts.length) {
        await yieldToEventLoop();
      }
    }

    return results;
  }

  /**
   * Check if model is loaded
   */
  isLoaded(): boolean {
    return this.extractor !== null;
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
