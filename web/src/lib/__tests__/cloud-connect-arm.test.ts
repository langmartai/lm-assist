import { describe, it, expect } from 'vitest';
import {
  decideCloudConnectArm,
  isTopLevelWindow,
  cloudConnectPrompt,
  CLOUD_CONNECT_FRAMED_ERROR,
} from '@/lib/cloud-connect-arm';

// The #cloudConnect hand-off is attacker-craftable (any page can link to
// /api/auth/cloud-connect?key=<their key>&hubUrl=<real hub>). The confirm click is the only
// control, so it must never arm inside a frame, and its copy must not vouch for a sign-in.

const HUBS = ['wss://assist-api.langmart.ai', 'wss://assist-api.xeenhub.com'];
const frag = (p: Record<string, string>) => '#' + new URLSearchParams(p).toString();
const ATTACKER = frag({ cloudConnect: '1', key: 'sk-attacker', hubUrl: 'wss://assist-api.langmart.ai' });

describe('decideCloudConnectArm', () => {
  it('ignores a page without the hand-off', () => {
    expect(decideCloudConnectArm('', { isTopLevel: true, platformHubUrls: HUBS })).toEqual({ kind: 'none' });
    expect(decideCloudConnectArm('#tab=connection', { isTopLevel: true, platformHubUrls: HUBS })).toEqual({ kind: 'none' });
  });

  it('REFUSES to arm inside a frame, even with a valid-looking key and the real hub (clickjacking)', () => {
    const d = decideCloudConnectArm(ATTACKER, { isTopLevel: false, platformHubUrls: HUBS });
    expect(d).toEqual({ kind: 'error', message: CLOUD_CONNECT_FRAMED_ERROR });
  });

  it('arms at top level for an exact platform hub (the legitimate popup fallback)', () => {
    expect(decideCloudConnectArm(ATTACKER, { isTopLevel: true, platformHubUrls: HUBS })).toEqual({
      kind: 'arm',
      key: 'sk-attacker',
      hubUrl: 'wss://assist-api.langmart.ai',
    });
  });

  it('refuses an unknown or look-alike hub and a missing key', () => {
    for (const hubUrl of ['wss://evil.example', 'wss://assist-api.langmart.ai.evil.example', 'wss://assist-api.langmart.ai/']) {
      const d = decideCloudConnectArm(frag({ cloudConnect: '1', key: 'k', hubUrl }), { isTopLevel: true, platformHubUrls: HUBS });
      expect(d.kind).toBe('error');
    }
    const d = decideCloudConnectArm(frag({ cloudConnect: '1', hubUrl: HUBS[0] }), { isTopLevel: true, platformHubUrls: HUBS });
    expect(d.kind).toBe('error');
  });
});

describe('isTopLevelWindow', () => {
  it('top-level window → true', () => {
    const w: any = {};
    w.self = w;
    w.top = w;
    expect(isTopLevelWindow(w)).toBe(true);
  });
  it('framed window → false', () => {
    const top = {};
    const w: any = { top };
    w.self = w;
    expect(isTopLevelWindow(w)).toBe(false);
  });
  it('a cross-origin top that throws on access → false (framed)', () => {
    const w: any = {};
    w.self = w;
    Object.defineProperty(w, 'top', { get() { throw new Error('SecurityError'); } });
    expect(isTopLevelWindow(w)).toBe(false);
  });
  it('no window → false', () => {
    expect(isTopLevelWindow(undefined)).toBe(false);
  });
});

describe('cloudConnectPrompt', () => {
  it('never claims a sign-in happened, and says the account gets control', () => {
    for (const bound of [false, true]) {
      const p = cloudConnectPrompt(bound);
      expect(p.text).not.toMatch(/that just signed in/i);
      expect(p.text).toMatch(/control this device/i);
      expect(p.text).toMatch(/only continue if you just clicked sign in/i);
    }
  });
  it('warns loudly when it would REPLACE the account the device is already bound to', () => {
    const p = cloudConnectPrompt(true);
    expect(p.warn).toBe(true);
    expect(p.confirmLabel).toBe('Replace account');
    expect(p.text).toMatch(/already connected/i);
    expect(cloudConnectPrompt(false).warn).toBe(false);
    expect(cloudConnectPrompt(false).confirmLabel).toBe('Connect');
  });
});
