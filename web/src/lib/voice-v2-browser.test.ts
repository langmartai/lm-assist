import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { voiceV2BrowserSupported, voiceV2BrowserSupport } from './voice-v2-browser';

/**
 * The predicate duplicates `supported()` from the engine asset (a public static file that is
 * never bundled, so it cannot be imported). These tests are the anti-drift guard — the same
 * shape `voice-url.test.ts` puts on the core↔web URL contract.
 */

const ENGINE = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'public', 'voice', 'claude-voice-engine.js'),
  'utf-8',
);

const g = globalThis as unknown as Record<string, unknown>;

/** Install a fake browser env with the given capabilities present. */
function withCaps(caps: { encoder?: boolean; processor?: boolean; getUserMedia?: boolean; audioContext?: boolean; secure?: boolean }) {
  g.window = g;
  g.isSecureContext = caps.secure !== false;
  if (caps.encoder) g.AudioEncoder = function () {};
  if (caps.processor) g.MediaStreamTrackProcessor = function () {};
  g.navigator = caps.getUserMedia ? { mediaDevices: { getUserMedia: () => {} } } : { mediaDevices: undefined };
  if (caps.audioContext) g.AudioContext = function () {};
}

afterEach(() => {
  for (const k of ['window', 'AudioEncoder', 'MediaStreamTrackProcessor', 'navigator', 'AudioContext', 'webkitAudioContext', 'isSecureContext']) {
    delete g[k];
  }
});

describe('voiceV2BrowserSupported', () => {
  it('is true only when every capability the engine needs is present', () => {
    withCaps({ encoder: true, processor: true, getUserMedia: true, audioContext: true });
    expect(voiceV2BrowserSupported()).toBe(true);
  });

  it('is false on Safari/Firefox — no WebCodecs AudioEncoder', () => {
    withCaps({ processor: true, getUserMedia: true, audioContext: true });
    expect(voiceV2BrowserSupported()).toBe(false);
  });

  it('is false without MediaStreamTrackProcessor (insertable streams) — the other Safari/Firefox gap', () => {
    withCaps({ encoder: true, getUserMedia: true, audioContext: true });
    expect(voiceV2BrowserSupported()).toBe(false);
  });

  it('is false on an insecure origin, where navigator.mediaDevices does not exist', () => {
    withCaps({ encoder: true, processor: true, audioContext: true });
    expect(voiceV2BrowserSupported()).toBe(false);
  });

  it('is false with no AudioContext (playback impossible)', () => {
    withCaps({ encoder: true, processor: true, getUserMedia: true });
    expect(voiceV2BrowserSupported()).toBe(false);
  });

  it('is false during SSR, where there is no window at all', () => {
    expect(voiceV2BrowserSupported()).toBe(false);
  });

  // The two failures that both hid the control, and why they must NOT share a message: one is
  // fixed by accepting a certificate, the other by changing browser. Reporting a flat
  // "unsupported" would send someone to reinstall a browser over a cert problem.
  it('blames the CERTIFICATE, not the browser, when the origin is not a secure context', () => {
    withCaps({ encoder: true, processor: true, audioContext: true, secure: false });
    const r = voiceV2BrowserSupport();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/secure context/i);
    expect(r.reason).toMatch(/certificate/i);
    expect(r.reason).not.toMatch(/WebCodecs/i);
  });

  it('blames WebCodecs (Chrome/Edge) on Safari/Firefox, where the mic API DOES exist', () => {
    withCaps({ processor: true, getUserMedia: true, audioContext: true, secure: true });
    const r = voiceV2BrowserSupport();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/WebCodecs/i);
    expect(r.reason).not.toMatch(/certificate/i);
  });

  it('reports no reason when supported', () => {
    withCaps({ encoder: true, processor: true, getUserMedia: true, audioContext: true });
    expect(voiceV2BrowserSupport()).toEqual({ ok: true, reason: '' });
  });

  it('checks exactly the capabilities the engine asset checks (anti-drift)', () => {
    // Pull the engine's own supported() body off disk and compare the capability names, so a
    // change to one side without the other fails here instead of in production.
    const body = ENGINE.match(/function supported\(\)\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(body, 'engine asset must still define supported()').toBeTruthy();
    for (const cap of ['AudioEncoder', 'MediaStreamTrackProcessor', 'getUserMedia', 'AudioContext']) {
      expect(body).toContain(cap);
    }
    const ours = fs.readFileSync(path.resolve(__dirname, 'voice-v2-browser.ts'), 'utf-8');
    for (const cap of ['AudioEncoder', 'MediaStreamTrackProcessor', 'getUserMedia', 'AudioContext']) {
      expect(ours, `predicate must check ${cap}, like the engine does`).toContain(cap);
    }
  });
});
