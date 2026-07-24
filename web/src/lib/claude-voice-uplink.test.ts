import { describe, it, expect } from 'vitest';
import { createUplinkGate, MAX_BUFFERED_FRAMES } from './claude-voice-uplink';

const frame = (n: number) => new Uint8Array([n]);
const ids = (sent: Uint8Array[]) => sent.map((f) => f[0]);

describe('createUplinkGate', () => {
  it('buffers instead of dropping before the relay is ready — the opening words survive', () => {
    const sent: Uint8Array[] = [];
    const gate = createUplinkGate((f) => sent.push(f));
    gate.push(frame(1));
    gate.push(frame(2));
    expect(sent).toEqual([]);
    expect(gate.buffered).toBe(2);
  });

  it('flushes the ring oldest-first on open(), then passes frames straight through', () => {
    const sent: Uint8Array[] = [];
    const gate = createUplinkGate((f) => sent.push(f));
    gate.push(frame(1));
    gate.push(frame(2));
    gate.open();
    expect(ids(sent)).toEqual([1, 2]);
    expect(gate.buffered).toBe(0);

    gate.push(frame(3));
    expect(ids(sent)).toEqual([1, 2, 3]);
    expect(gate.buffered).toBe(0);
  });

  it('caps the ring, dropping the OLDEST frames — a long wait cannot flush a huge stale burst', () => {
    const sent: Uint8Array[] = [];
    const gate = createUplinkGate((f) => sent.push(f), 3);
    for (let i = 1; i <= 10; i++) gate.push(frame(i));
    expect(gate.buffered).toBe(3);
    gate.open();
    // The most recent audio is what the user is saying now; frames 1-7 are gone.
    expect(ids(sent)).toEqual([8, 9, 10]);
  });

  it('is idempotent on a duplicate open() — a second {ready} must not re-send anything', () => {
    const sent: Uint8Array[] = [];
    const gate = createUplinkGate((f) => sent.push(f));
    gate.push(frame(1));
    gate.open();
    gate.open();
    expect(ids(sent)).toEqual([1]);
  });

  it('keeps capturing when send throws — a dead socket must not break the mic', () => {
    let calls = 0;
    const gate = createUplinkGate(() => { calls++; throw new Error('socket closed'); });
    gate.push(frame(1));
    expect(() => gate.open()).not.toThrow();
    expect(calls).toBe(1);
    expect(() => gate.push(frame(2))).not.toThrow();
    expect(calls).toBe(2);
    // The flush cleared the ring before sending, so the throwing frame is not queued for a
    // second delivery attempt.
    expect(gate.buffered).toBe(0);
  });

  it('reset() re-closes the gate and empties the ring so the next session starts clean', () => {
    const sent: Uint8Array[] = [];
    const gate = createUplinkGate((f) => sent.push(f));
    gate.push(frame(1));
    gate.open();
    expect(gate.isOpen).toBe(true);

    gate.reset();
    expect(gate.isOpen).toBe(false);
    expect(gate.buffered).toBe(0);

    gate.push(frame(2));
    expect(ids(sent)).toEqual([1]); // buffered again, not sent into the abandoned session
    expect(gate.buffered).toBe(1);
  });

  it('defaults to ~5s of Opus (20ms frames at ~50fps)', () => {
    expect(MAX_BUFFERED_FRAMES).toBe(250);
    const gate = createUplinkGate(() => {});
    for (let i = 0; i < MAX_BUFFERED_FRAMES + 50; i++) gate.push(frame(i % 256));
    expect(gate.buffered).toBe(MAX_BUFFERED_FRAMES);
  });
});
