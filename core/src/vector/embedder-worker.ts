/**
 * Embedder Worker Thread
 *
 * Runs ONNX inference (transformers.js) on a separate thread so the main
 * event loop is never blocked by CPU-intensive embedding operations.
 *
 * Protocol:
 *   Main → Worker: { type: 'embed', id: number, texts: string[] }
 *   Worker → Main: { type: 'result', id: number, embeddings: number[][] }
 *   Worker → Main: { type: 'error', id: number, message: string }
 *   Worker → Main: { type: 'ready' }
 */

import { parentPort } from 'worker_threads';
import * as path from 'path';

if (!parentPort) {
  throw new Error('This module must be run as a worker thread');
}

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const VECTOR_DIM = 384;

let extractor: any = null;

async function loadModel(): Promise<void> {
  const dataDir = process.env.LM_ASSIST_DATA_DIR || path.join(require('os').homedir(), '.lm-assist');
  const mod = await import('@huggingface/transformers');
  mod.env.cacheDir = path.join(dataDir, 'models');
  mod.env.allowRemoteModels = true;
  mod.env.useFSCache = true;
  extractor = await (mod.pipeline as any)('feature-extraction', MODEL_NAME, { quantized: true });
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  // Process in batches of 16 — inside the worker, blocking is fine
  const BATCH_SIZE = 16;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map(t =>
      t.length > 2000 ? t.slice(0, 2000) : t
    );
    const outputs = await extractor(batch, { pooling: 'mean', normalize: true });
    const data = Array.from(outputs.data as Float32Array);
    for (let j = 0; j < batch.length; j++) {
      const start = j * VECTOR_DIM;
      results.push(data.slice(start, start + VECTOR_DIM));
    }
  }
  return results;
}

// Message handler
parentPort.on('message', async (msg: any) => {
  if (msg.type === 'embed') {
    try {
      if (!extractor) await loadModel();
      const embeddings = await embedTexts(msg.texts);
      parentPort!.postMessage({ type: 'result', id: msg.id, embeddings });
    } catch (err: any) {
      parentPort!.postMessage({ type: 'error', id: msg.id, message: err.message || String(err) });
    }
  }
});

// Signal ready after loading
(async () => {
  try {
    await loadModel();
    parentPort!.postMessage({ type: 'ready' });
  } catch (err: any) {
    console.error('[EmbedderWorker] Failed to load model:', err);
    parentPort!.postMessage({ type: 'ready' }); // still signal ready, will retry on first use
  }
})();
