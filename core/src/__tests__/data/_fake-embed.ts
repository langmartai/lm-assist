// Deterministic, model-free embedder for hermetic tests.
// Hashes whitespace tokens into a 384-dim bag-of-tokens vector, then L2-normalizes.
// Same text -> same vector; texts sharing tokens have higher cosine similarity.
import { VECTOR_DIM } from '../../vector/embedder';

export function fakeEmbed(text: string): Promise<number[]> {
  const v = new Array(VECTOR_DIM).fill(0);
  for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) % VECTOR_DIM;
    v[h] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return Promise.resolve(v.map((x) => x / norm));
}
