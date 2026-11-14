import { describe, it, expect } from 'vitest';
import { decideLanGuard, shouldClearStoredKey, type LanGuardInput } from '../lan-guard';

const base: LanGuardInput = { hostname: '10.0.0.5', isProxied: false, isHubHost: false, status: 'denied', hadStoredKey: false };
const decide = (o: Partial<LanGuardInput>) => decideLanGuard({ ...base, ...o });

describe('decideLanGuard', () => {
  it('passes hub-proxied pages and hub hosts whatever the bootstrap said', () => {
    for (const status of ['denied', 'lan-key-invalid', 'unreachable'] as const) {
      expect(decide({ isProxied: true, status })).toBe('pass');
      expect(decide({ isHubHost: true, status })).toBe('pass');
    }
  });

  it('passes on a grant (ok) and when Core needs no token (not-needed)', () => {
    expect(decide({ status: 'ok' })).toBe('pass');
    expect(decide({ status: 'not-needed' })).toBe('pass');
    expect(decide({ hostname: 'localhost', status: 'ok' })).toBe('pass');
  });

  it('passes localhost when Core is unreachable (Core still gates the data)', () => {
    expect(decide({ hostname: 'localhost', status: 'unreachable' })).toBe('pass');
    expect(decide({ hostname: '127.0.0.1', status: 'unreachable' })).toBe('pass');
  });

  it('fails CLOSED off-localhost when Core is unreachable', () => {
    expect(decide({ hostname: '10.0.0.5', status: 'unreachable' })).toBe('/lan-blocked?error=unreachable');
    expect(decide({ hostname: 'my-box.local', status: 'unreachable', hadStoredKey: true })).toBe('/lan-blocked?error=unreachable');
  });

  it('sends a refused stored key to the sign-in-again page and clears it', () => {
    const invalid = decide({ status: 'lan-key-invalid', hadStoredKey: true });
    expect(invalid).toBe('/lan-blocked?expired=1');
    expect(shouldClearStoredKey(invalid)).toBe(true);

    const deniedWithKey = decide({ status: 'denied', hadStoredKey: true });
    expect(deniedWithKey).toBe('/lan-blocked?expired=1');
    expect(shouldClearStoredKey(deniedWithKey)).toBe(true);
  });

  it('sends a keyless refusal to the plain block page', () => {
    const d = decide({ status: 'denied', hadStoredKey: false });
    expect(d).toBe('/lan-blocked');
    expect(shouldClearStoredKey(d)).toBe(false);
  });

  it('does not special-case localhost for a refusal (Core decides)', () => {
    expect(decide({ hostname: 'localhost', status: 'denied' })).toBe('/lan-blocked');
  });

  it('never clears the key for pass or unreachable', () => {
    expect(shouldClearStoredKey('pass')).toBe(false);
    expect(shouldClearStoredKey('/lan-blocked?error=unreachable')).toBe(false);
  });
});
