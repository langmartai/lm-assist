import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { voiceV2BrowserSupported } from './voice-v2-browser';

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
function withCaps(caps: { encoder?: boolean; processor?: boolean; getUserMedia?: boolean; audioContext?: boolean }) {
  g.window = g;
  if (caps.encoder) g.AudioEncoder = function () {};
  if (caps.processor) g.MediaStreamTrackProcessor = function () {};
  g.navigator = caps.getUserMedia ? { mediaDevices: { getUserMedia: () => {} } } : { mediaDevices: undefined };
  if (caps.audioContext) g.AudioContext = function () {};
}

afterEach(() => {
  for (const k of ['window', 'AudioEncoder', 'MediaStreamTrackProcessor', 'navigator', 'AudioContext', 'webkitAudioContext']) {
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
