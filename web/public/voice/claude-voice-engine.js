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
//   - clearPlayback()     -> the hook calls this on a server-side barge-in
//                            (server_interrupt) to silence queued assistant audio
//                            without stopping mic capture
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
 * RMS of one AudioData frame, 0..1 — measured on the samples we are ABOUT TO ENCODE, so it
 * reflects exactly what claude.ai receives.
 *
 * Deliberately NOT an AnalyserNode: that reads through the AudioContext, which starts
 * suspended under autoplay policy and would report a flat zero for a perfectly good mic. This
 * path touches no AudioContext at all.
 *
 * Why this exists: `up>0` in the relay log only proves frames FLOWED. Opus encodes silence just
 * as happily as speech, so a muted or wrong-input mic produces a full-rate stream of nothing,
 * claude.ai transcribes nothing, and the session dies with downMsg=2 and no reply — visually
 * identical to a server fault. This is the number that tells those two apart.
 */
function frameLevel(ad) {
  try {
    const n = ad.numberOfFrames;
    if (!n) return 0;
    const buf = new Float32Array(n);
    ad.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
    let sum = 0;
    for (let i = 0; i < n; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / n);
  } catch (e) {
    return 0;
  }
}

/**
 * Create one voice-engine instance. `start()` opens the mic (AEC3 constraints),
 * captures @48k, resamples to 16k, and streams WebCodecs-encoded Opus packets to
 * `onFrame`. `playPcm()` enqueues one downlink PCM frame (16-bit LE mono @16k)
 * for gapless playback through the same AudioContext, whose destination doubles
 * as the AEC reference so the server's speech doesn't re-enter the uplink.
 * `clearPlayback()` immediately drops all queued downlink audio and resets the
 * play head to now, WITHOUT touching the mic, encoder, or AudioContext — for a
 * server-side barge-in (`server_interrupt`); idempotent, safe to call with
 * nothing queued. `stop()` tears everything down. `start`/`stop` are safe to
 * call repeatedly on one instance — each `stop()` fully resets state for the
 * next `start()`.
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
  let level = 0;          // RMS of the most recent encoded frame
  let peak = 0;           // loudest frame seen since start() — survives a pause in speech
  let framesSeen = 0;

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
        level = frameLevel(frame);
        if (level > peak) peak = level;
        framesSeen++;
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
    level = 0; peak = 0; framesSeen = 0;
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
      // Do NOT `await ac.resume()`: start() runs on the async `{ready}` frame, well past the
      // click's activation window, so a suspended-by-autoplay context's resume() promise never
      // settles without a fresh gesture — the await HANGS start() at 'starting' and capture
      // never begins (the prod up=0 bug). Capture (getUserMedia -> MediaStreamTrackProcessor ->
      // AudioEncoder -> onFrame) does NOT touch the AudioContext at all; only playback does. So
      // kick a best-effort resume (sticky page activation from the user's click usually lands
      // it) and proceed to capture regardless; playPcm re-attempts the resume when downlink
      // audio actually arrives, so playback recovers the moment the context can run.
      if (ac.state === 'suspended') ac.resume().catch(function () {});
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
      // Downlink audio just arrived — if the context is still suspended (start()'s
      // non-blocking resume didn't land), re-attempt it now so the assistant is audible. By
      // this point the user has interacted with the page (opened voice mode), so the sticky
      // activation lets the resume succeed; buffers scheduled while suspended play once it runs.
      if (ac.state === 'suspended') ac.resume().catch(function () {});
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

  // Barge-in: silence whatever assistant audio is already queued, without
  // touching capture. Reuses stopPlayback() (already idempotent — a no-op loop
  // over an empty `sources` array) and re-bases the play head on the LIVE
  // AudioContext clock rather than 0, since — unlike stop()'s teardown, where a
  // fresh AudioContext starts its own clock at the next start() — the context
  // stays open and running here.
  function clearPlayback() {
    stopPlayback();
    if (ac) playHead = ac.currentTime;
  }

  function stop() {
    stopLocal();
    setState('stopped');
  }

  /** Live mic input: `level` = most recent frame's RMS, `peak` = loudest since start(),
   *  `frames` = how many have been encoded. A moving level with a flat peak-near-zero means the
   *  mic is open but capturing silence — the single most common "voice is broken" cause, and
   *  otherwise invisible from either side of the relay. */
  function micInput() {
    return { level: level, peak: peak, frames: framesSeen };
  }

  return { start, playPcm, clearPlayback, stop, micInput };
}
