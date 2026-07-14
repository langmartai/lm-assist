'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { speak, cancelSpeech, speechSupported } from '@/lib/speech';

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error';

/** One push-to-talk voice turn: mic → Core /voice/stt/ws relay → transcript → sendMessage →
 *  spoken reply. `start()` opens the mic + relay (state 'listening', live `interim`); `stop()`
 *  finalizes, sends the transcript via `sendMessage` (which returns the reply text), and speaks
 *  the reply. Fully self-cleaning. `sendMessage` returns the assistant reply so we can speak it. */
export function useVoiceConversation(opts: { wsUrl: string; sendMessage: (text: string) => Promise<string | undefined> }) {
  const { wsUrl, sendMessage } = opts;
  const [state, setStateRaw] = useState<VoiceState>('idle');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  const stateRef = useRef<VoiceState>('idle');
  const setState = (s: VoiceState) => { stateRef.current = s; setStateRaw(s); };

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const finalsRef = useRef<string[]>([]);
  const interimRef = useRef('');
  const finalizeWaitRef = useRef<(() => void) | null>(null);
  const startingRef = useRef(false);       // true while start() awaits mic permission / setup
  const pendingAbortRef = useRef(false);    // release happened before start finished → abort on open

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

  const closeWs = useCallback(() => {
    try { wsRef.current?.close(); } catch { /* noop */ }
    wsRef.current = null;
  }, []);

  const fail = useCallback((msg: string) => {
    startingRef.current = false; pendingAbortRef.current = false; // else a handshake failure wedges start()/stop()
    setError(msg);
    setState('error');
    teardownAudio();
    closeWs();
  }, [teardownAudio, closeWs]);

  // Release the mic / AudioContext / sockets / speech if the component unmounts mid-turn
  // (chat closed or switched). Uses refs (always current) so no stale-closure risk.
  useEffect(() => () => {
    try { if (nodeRef.current) nodeRef.current.port.onmessage = null; nodeRef.current?.disconnect(); } catch { /* noop */ }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    try { void ctxRef.current?.close(); } catch { /* noop */ }
    try { wsRef.current?.close(); } catch { /* noop */ }
    cancelSpeech();
  }, []);

  const start = useCallback(async () => {
    if (!supported) { setError('Voice input is not supported in this browser.'); setState('error'); return; }
    if (stateRef.current === 'listening' || stateRef.current === 'transcribing' || startingRef.current) return;
    startingRef.current = true; pendingAbortRef.current = false;
    cancelSpeech(); // barge over any reply currently being spoken
    setError(null); setInterim(''); interimRef.current = ''; finalsRef.current = [];
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
          if (m.final) {
            if (m.text) finalsRef.current.push(m.text);
            interimRef.current = ''; setInterim('');
            finalizeWaitRef.current?.();
          } else {
            interimRef.current = m.text || ''; setInterim(m.text || '');
          }
        } else if (m.type === 'error') {
          fail(m.message || 'voice error');
        }
      };
      // Only treat an error as fatal while we're actively starting/listening — a late error on a
      // socket we already closed (after stop) must not clobber a good 'thinking'/'speaking'/'idle' turn.
      ws.onerror = () => { if (startingRef.current || stateRef.current === 'listening') fail('voice connection error'); };
      // If the relay drops mid-finalize, resolve the finalize wait early instead of blocking 2.5s.
      ws.onclose = () => { finalizeWaitRef.current?.(); };
      ws.onopen = () => {
        startingRef.current = false;
        // Released before we finished opening → abort cleanly (no capture, no send).
        if (pendingAbortRef.current) { pendingAbortRef.current = false; teardownAudio(); closeWs(); setState('idle'); return; }
        // Chromium only pulls the worklet if the graph reaches the destination; route through a
        // muted gain so we process mic frames without hearing ourselves.
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
  }, [supported, wsUrl, fail]);

  const stop = useCallback(async () => {
    if (startingRef.current) { pendingAbortRef.current = true; return; } // released before start finished
    if (stateRef.current !== 'listening') return;
    setState('transcribing');
    teardownAudio(); // stop the mic; no more frames after this

    const ws = wsRef.current;
    const finalText = await new Promise<string>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return; settled = true;
        finalizeWaitRef.current = null; clearTimeout(to);
        resolve((finalsRef.current.join(' ') || interimRef.current).trim());
      };
      finalizeWaitRef.current = finish;
      const to = setTimeout(finish, 2500); // safety: don't hang if no endpoint arrives
      try { ws?.send('{"type":"finalize"}'); } catch { finish(); }
    });
    closeWs();

    if (!finalText) { setState('idle'); return; }
    setState('thinking');
    try {
      const reply = await sendMessage(finalText);
      if (reply && speechSupported()) { setState('speaking'); speak(reply, () => setState('idle')); }
      else setState('idle');
    } catch (e) {
      fail(e instanceof Error ? e.message : 'failed to send message');
    }
  }, [teardownAudio, closeWs, sendMessage, fail]);

  return { state, interim, error, supported, start, stop };
}
