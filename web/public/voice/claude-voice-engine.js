// claude-voice-engine.js — browser-side audio engine for claude.ai bidirectional
// voice (v2). Ported from lm-mobile's client voice engine:
//   ~/lm-mobile/agent/app/src/main/assets/voice-engine.js
// which does exactly what claude.ai's own web client does:
//   getUserMedia({echoCancellation,noiseSuppression,autoGainControl}) -> WebRTC AEC3
//   capture @48k -> resample 48k->16k -> WebCodecs AudioEncoder opus (voip,20ms)
//   downlink pcm_16000 -> AudioContext buffer-source -> speakers (AEC3 references it)
//   continuous stream, NO client gate / NO client VAD.
//
// Adapted for lm-assist's Core-relay architecture (see the bidirectional-voice-v2
// design doc): the source's WebSocket + JSON relay protocol is stripped out — the
// voice hook (useClaudeVoice, Task 8) owns the socket and drives this engine
// through plain callbacks instead:
//   - onFrame(opusBytes)  <- this engine emits one Uint8Array per encoded Opus packet
//   - playPcm(pcmFrame)   -> the hook feeds this engine one downlink PCM frame at a time
// No Android/WebView bits carried over (the source had none in this file itself —
// the native bridge lived in claude-ws-relay.js, not here).
//
// Capture/resample uses MediaStreamTrackProcessor (WebCodecs insertable streams),
// exactly as the source does. Its resample() runs per whole AudioData frame with
// no state carried across calls (i1 always clamps to inN-1), so it has none of the
// unbounded-tail failure mode a streaming AudioWorklet resampler has to guard
// against (see mic-worklet.js's 96kHz tail fix) — no worklet is used here.

const SR_IN = 48000;
const SR_OUT = 16000;

function supported() {
  return typeof AudioEncoder !== 'undefined' &&
         typeof MediaStreamTrackProcessor !== 'undefined' &&
         !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
         !!(window.AudioContext || window.webkitAudioContext);
}

// One AudioData frame -> resampled AudioData frame, 48k -> 16k linear interpolation.
// Stateless per call — see the file header for why this needs no tail fix.
function resample(ad) {
  const ratio = ad.sampleRate / SR_OUT;
  const inN = ad.numberOfFrames;
  const outN = Math.floor(inN / ratio);
  const inB = new Float32Array(inN);
  ad.copyTo(inB, { planeIndex: 0, format: 'f32-planar' });
  const outB = new Float32Array(outN);
  for (let i = 0; i < outN; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, inN - 1);
    const f = x - i0;
    outB[i] = inB[i0] * (1 - f) + inB[i1] * f;
  }
  const out = new AudioData({
    format: 'f32-planar',
    sampleRate: SR_OUT,
    numberOfFrames: outN,
    numberOfChannels: 1,
    timestamp: ad.timestamp,
    data: outB,
  });
  ad.close();
  return out;
}

/**
 * Create one voice-engine instance. `start()` opens the mic (AEC3 constraints),
 * captures @48k, resamples to 16k, and streams WebCodecs-encoded Opus packets to
 * `onFrame`. `playPcm()` enqueues one downlink PCM frame (16-bit LE mono @16k)
 * for gapless playback through the same AudioContext, whose destination doubles
 * as the AEC reference so the server's speech doesn't re-enter the uplink.
 * `stop()` tears everything down. `start`/`stop` are safe to call repeatedly on
 * one instance — each `stop()` fully resets state for the next `start()`.
 */
export function createClaudeVoiceEngine() {
  let ac = null;
  let micStream = null;
  let enc = null;
  let reader = null;
  let running = false;
  let sources = [];
  let playHead = 0;
  let onFrame = null;
  let onState = null;

  function setState(s) {
    try { if (onState) onState(s); } catch (e) { /* noop */ }
  }

  async function readLoop() {
    try {
      while (running && reader) {
        const r = await reader.read();
        if (r.done) break;
        let frame = r.value;
        if (frame.sampleRate !== SR_OUT) frame = resample(frame);
        try { if (enc && enc.state === 'configured') enc.encode(frame); } catch (e) { /* noop */ }
        frame.close();
      }
    } catch (e) { /* noop — reader.cancel() from stop() lands here */ }
  }

  // Setup only (encoder construction + configure + track processor). Left
  // UNguarded here (unlike the source's whole-body swallow) so a setup failure
  // propagates to start()'s try/catch and reaches onState('error'); the
  // per-chunk `output` callback below still swallows on its own, matching the
  // source's steady-state resilience (a rare mid-stream delivery hiccup drops
  // one frame instead of killing the pipeline).
  function startEncoder() {
    enc = new AudioEncoder({
      output: (chunk) => {
        try {
          const b = new ArrayBuffer(chunk.byteLength);
          chunk.copyTo(b);
          if (onFrame) onFrame(new Uint8Array(b));
        } catch (e) { /* noop */ }
      },
      error: () => {},
    });
    const base = { codec: 'opus', sampleRate: SR_OUT, numberOfChannels: 1, bitrate: 24000 };
    try {
      enc.configure({ ...base, opus: { application: 'voip', signal: 'voice', frameDuration: 20000 } });
    } catch (e) {
      enc.configure(base);
    }
    const track = micStream.getAudioTracks()[0];
    const proc = new MediaStreamTrackProcessor({ track });
    reader = proc.readable.getReader();
    readLoop();
  }

  function stopPlayback() {
    for (const src of sources) {
      try { src.stop(); } catch (e) { /* noop */ }
    }
    sources = [];
    playHead = 0;
  }

  function stopLocal() {
    running = false;
    try { if (reader) reader.cancel(); } catch (e) { /* noop */ }
    reader = null;
    try { if (enc && enc.state !== 'closed') enc.close(); } catch (e) { /* noop */ }
    enc = null;
    stopPlayback();
    try { if (micStream) micStream.getTracks().forEach((t) => t.stop()); } catch (e) { /* noop */ }
    micStream = null;
    try { if (ac) ac.close(); } catch (e) { /* noop */ }
    ac = null;
  }

  async function start(opts) {
    if (running) return; // idempotent — already capturing, keep the existing session

    opts = opts || {};
    onFrame = opts.onFrame || null;
    onState = opts.onState || null;

    if (!supported()) {
      setState('error');
      throw new Error('this browser lacks WebCodecs/getUserMedia (use Chrome/Edge)');
    }

    setState('starting');

    try {
      ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR_IN });
      if (ac.state === 'suspended') await ac.resume();
    } catch (e) {
      setState('error');
      throw new Error('audiocontext: ' + e);
    }

    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: { ideal: SR_IN },
        },
      });
    } catch (e) {
      setState('error');
      throw new Error('mic permission: ' + (e && e.name ? e.name : e));
    }

    running = true;
    try {
      startEncoder();
    } catch (e) {
      running = false;
      setState('error');
      throw new Error('encoder setup: ' + e);
    }
    setState('capturing');
  }

  function playPcm(pcm) {
    try {
      const i16 = pcm instanceof Int16Array ? pcm : new Int16Array(pcm);
      const n = i16.length;
      if (!n || !ac) return;
      const buf = ac.createBuffer(1, n, SR_OUT);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < n; i++) ch[i] = i16[i] / 32768;
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(ac.destination);
      const now = ac.currentTime;
      const at = Math.max(now, playHead);
      src.start(at);
      playHead = at + buf.duration;
      sources.push(src);
      src.onended = () => {
        const k = sources.indexOf(src);
        if (k >= 0) sources.splice(k, 1);
      };
      if (sources.length > 600) sources.splice(0, 300);
    } catch (e) { /* noop */ }
  }

  function stop() {
    stopLocal();
    setState('stopped');
  }

  return { start, playPcm, stop };
}
