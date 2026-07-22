'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type DictationState = 'idle' | 'listening' | 'transcribing' | 'error';

/**
 * Reusable voice DICTATION: mic → Core `/voice/stt/ws` relay → live transcript text.
 *
 * Extracted from the proven cowork voice path (see useVoiceConversation) with the three
 * device fixes baked in and the conversation/TTS parts removed:
 *   - the audio capture uses the shared /voice/mic-worklet.js (tail-bounded — works at 96 kHz);
 *   - `text` is the ACCUMULATED transcript (finalized utterances + the live in-progress words),
 *     so it never blanks on a pause — the consumer mirrors it straight into a composer;
 *   - toggle via start()/stop() (the UI uses a single click, no press-and-hold).
 *
 * Self-cleaning on unmount. `supported` is false on insecure origins (mic hidden there).
 */
export function useDictation(opts: { wsUrl: string }) {
  const { wsUrl } = opts;
  const [state, setStateRaw] = useState<DictationState>('idle');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const stateRef = useRef<DictationState>('idle');
  const setState = (s: DictationState) => { stateRef.current = s; setStateRaw(s); };

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const finalsRef = useRef<string[]>([]);
  const startingRef = useRef(false);      // true while start() awaits mic/setup
  const pendingAbortRef = useRef(false);  // stop() before start() finished → abort on open

  const supported =
    typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia &&
    typeof window !== 'undefined' && typeof window.AudioWorklet !== 'undefined';

  const teardownAudio = useCallback(() => {
    try { if (nodeRef.current) nodeRef.current.port.onmessage = null; } catch { /* noop */ }
    try { nodeRef.current?.disconnect(); } catch { /* noop */ }
    nodeRef.current = null;
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    streamRef.current = null;
    try { void ctxRef.current?.close(); } catch { /* noop */ }
    ctxRef.current = null;
  }, []);
  const closeWs = useCallback(() => { try { wsRef.current?.close(); } catch { /* noop */ } wsRef.current = null; }, []);
  const fail = useCallback((msg: string) => {
    startingRef.current = false; pendingAbortRef.current = false;
    setError(msg); setState('error'); teardownAudio(); closeWs();
  }, [teardownAudio, closeWs]);

  // Release mic/AudioContext/socket if the component unmounts mid-turn.
  useEffect(() => () => {
    try { if (nodeRef.current) nodeRef.current.port.onmessage = null; nodeRef.current?.disconnect(); } catch { /* noop */ }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    try { void ctxRef.current?.close(); } catch { /* noop */ }
    try { wsRef.current?.close(); } catch { /* noop */ }
  }, []);

  const start = useCallback(async () => {
    if (!supported) { setError('Voice input is not supported in this browser.'); setState('error'); return; }
    if (stateRef.current === 'listening' || stateRef.current === 'transcribing' || startingRef.current) return;
    startingRef.current = true; pendingAbortRef.current = false;
    setError(null); setText(''); finalsRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      await ctx.audioWorklet.addModule('/voice/mic-worklet.js');
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'mic-downsampler');
      nodeRef.current = node;

      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      node.port.onmessage = (ev: MessageEvent) => {
        const buf = ev.data;
        if (buf instanceof ArrayBuffer && ws.readyState === WebSocket.OPEN) ws.send(buf);
      };
      ws.onmessage = (ev: MessageEvent) => {
        let m: { type?: string; text?: string; final?: boolean; message?: string };
        try { m = JSON.parse(ev.data as string); } catch { return; }
        if (m.type === 'transcript') {
          // Accumulate — never blank on an endpoint, or the dictated text visibly disappears.
          if (m.final) { if (m.text) finalsRef.current.push(m.text); setText(finalsRef.current.join(' ')); }
          else setText([finalsRef.current.join(' '), m.text || ''].filter(Boolean).join(' '));
        } else if (m.type === 'error') {
          fail(m.message || 'voice error');
        }
      };
      ws.onerror = () => { if (startingRef.current || stateRef.current === 'listening') fail('voice connection error'); };
      ws.onopen = async () => {
        startingRef.current = false;
        if (pendingAbortRef.current) { pendingAbortRef.current = false; teardownAudio(); closeWs(); setState('idle'); return; }
        // Resume — the context can be created 'suspended' after the async getUserMedia.
        try { if (ctx.state !== 'running') await ctx.resume(); } catch { /* noop */ }
        // Route mic → worklet → muted gain → destination so Chromium pulls the worklet.
        const silent = ctx.createGain();
        silent.gain.value = 0;
        source.connect(node);
        node.connect(silent);
        silent.connect(ctx.destination);
        setState('listening');
      };
    } catch (e) {
      startingRef.current = false;
      fail(e instanceof Error ? e.message : 'could not start voice');
    }
  }, [supported, wsUrl, fail, teardownAudio, closeWs]);

  const stop = useCallback(async () => {
    if (startingRef.current) { pendingAbortRef.current = true; return; }
    if (stateRef.current !== 'listening') return;
    setState('transcribing');
    teardownAudio(); // stop the mic — no more frames
    // Ask the relay to flush a final endpoint; `text` keeps updating via onmessage meanwhile.
    try { wsRef.current?.send('{"type":"finalize"}'); } catch { /* noop */ }
    await new Promise((r) => setTimeout(r, 700));
    closeWs();
    setState('idle');
  }, [teardownAudio, closeWs]);

  return { state, text, error, supported, start, stop };
}
