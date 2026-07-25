import { describe, it, expect, beforeEach } from 'vitest';
import { dedupedRequest, clearRequestDedupe, requestDedupeSize } from '../request-dedupe';

describe('dedupedRequest', () => {
  beforeEach(() => clearRequestDedupe());

  it('shares one in-flight request between concurrent callers', async () => {
    let calls = 0;
    const fn = () => { calls++; return new Promise<number>(r => setTimeout(() => r(42), 10)); };

    const [a, b, c] = await Promise.all([
      dedupedRequest('k', 1000, fn),
      dedupedRequest('k', 1000, fn),
      dedupedRequest('k', 1000, fn),
    ]);

    expect(calls).toBe(1);
    expect([a, b, c]).toEqual([42, 42, 42]);
  });

  it('serves the cached value to callers arriving within the TTL', async () => {
    let calls = 0;
    const fn = async () => { calls++; return calls; };

    expect(await dedupedRequest('k', 1000, fn)).toBe(1);
    expect(await dedupedRequest('k', 1000, fn)).toBe(1);
    expect(calls).toBe(1);
  });

  it('re-fetches once the TTL has elapsed', async () => {
    let calls = 0;
    const fn = async () => { calls++; return calls; };

    expect(await dedupedRequest('k', 5, fn)).toBe(1);
    await new Promise(r => setTimeout(r, 20));
    expect(await dedupedRequest('k', 5, fn)).toBe(2);
    expect(calls).toBe(2);
  });

  it('keys are independent', async () => {
    let calls = 0;
    const fn = async () => { calls++; return calls; };

    await dedupedRequest('a', 1000, fn);
    await dedupedRequest('b', 1000, fn);
    expect(calls).toBe(2);
  });

  it('never caches a rejection — the next caller retries', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return 'ok';
    };

    await expect(dedupedRequest('k', 1000, fn)).rejects.toThrow('boom');
    expect(await dedupedRequest('k', 1000, fn)).toBe('ok');
    expect(calls).toBe(2);
  });

  it('propagates the rejection to every concurrent caller', async () => {
    let calls = 0;
    const fn = () => { calls++; return Promise.reject(new Error('boom')); };

    const results = await Promise.allSettled([
      dedupedRequest('k', 1000, fn),
      dedupedRequest('k', 1000, fn),
    ]);

    expect(calls).toBe(1);
    expect(results.map(r => r.status)).toEqual(['rejected', 'rejected']);
  });

  it('bypasses and refreshes the entry when force is set', async () => {
    let calls = 0;
    const fn = async () => { calls++; return calls; };

    expect(await dedupedRequest('k', 1000, fn)).toBe(1);
    expect(await dedupedRequest('k', 1000, fn, { force: true })).toBe(2);
    // the forced result becomes the new shared entry
    expect(await dedupedRequest('k', 1000, fn)).toBe(2);
    expect(calls).toBe(2);
  });

  it('clearRequestDedupe() drops a single key or everything', async () => {
    const fn = async () => 1;
    await dedupedRequest('a', 1000, fn);
    await dedupedRequest('b', 1000, fn);
    expect(requestDedupeSize()).toBe(2);

    clearRequestDedupe('a');
    expect(requestDedupeSize()).toBe(1);

    clearRequestDedupe();
    expect(requestDedupeSize()).toBe(0);
  });

  it('a zero/negative TTL disables value caching but still shares in-flight work', async () => {
    let calls = 0;
    const fn = () => { calls++; return new Promise<number>(r => setTimeout(() => r(calls), 10)); };

    // concurrent -> shared
    await Promise.all([dedupedRequest('k', 0, fn), dedupedRequest('k', 0, fn)]);
    expect(calls).toBe(1);

    // sequential -> not cached
    await dedupedRequest('k', 0, fn);
    expect(calls).toBe(2);
  });
});
