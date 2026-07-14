// AudioWorkletProcessor: downsample mic input to 16 kHz mono, convert to Int16 LE.
// Posts ArrayBuffer chunks (Int16 PCM @ 16 kHz) to the main thread.
//
// Approach: linear interpolation resampling. Maintains a fractional read
// position across process() calls so the output rate stays exactly 16 kHz.

class MicDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inSampleRate = sampleRate;        // AudioWorklet global
    this.outSampleRate = 16000;
    this.step = this.inSampleRate / this.outSampleRate; // input samples per output sample
    this.readPos = 0;
    this.tail = new Float32Array(0);       // unread samples carried across blocks
    this.frameBuf = [];                    // accumulated Int16 output samples
    this.targetFrame = 1280;               // 80 ms @ 16 kHz; matches Claude Code CLI chunk size
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    // Concatenate tail + new block
    const merged = new Float32Array(this.tail.length + channel.length);
    merged.set(this.tail, 0);
    merged.set(channel, this.tail.length);

    let i = this.readPos;
    while (i + 1 < merged.length) {
      const i0 = Math.floor(i);
      const frac = i - i0;
      const s = merged[i0] * (1 - frac) + merged[i0 + 1] * frac;
      const clipped = s < -1 ? -1 : s > 1 ? 1 : s;
      const i16 = clipped < 0 ? Math.round(clipped * 0x8000) : Math.round(clipped * 0x7FFF);
      this.frameBuf.push(i16);
      i += this.step;
    }

    // Keep one sample of context so the next block can interpolate from index 0
    const keepFrom = Math.floor(i) - 1;
    if (keepFrom > 0 && keepFrom < merged.length) {
      this.tail = merged.slice(keepFrom);
      this.readPos = i - keepFrom;
    } else {
      this.tail = merged;
      this.readPos = i;
    }

    // Flush full 80 ms frames
    while (this.frameBuf.length >= this.targetFrame) {
      const chunk = this.frameBuf.splice(0, this.targetFrame);
      const buf = new ArrayBuffer(chunk.length * 2);
      const view = new DataView(buf);
      for (let j = 0; j < chunk.length; j++) view.setInt16(j * 2, chunk[j], true);
      this.port.postMessage(buf, [buf]);
    }
    return true;
  }
}

registerProcessor('mic-downsampler', MicDownsampler);
