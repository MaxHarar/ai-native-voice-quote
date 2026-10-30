// Audio pipeline for the audio-level eval runner. All buffers are mono PCM16 little-endian
// (Int16Array); the agent's input format is pcm_16000.
//   clean   : TTS PCM16 16 kHz as synthesized
//   pstn    : band-limit 300-3400 Hz, downsample to 8 kHz, G.711 mu-law round trip, back to 16 kHz
//   noise10 : pink noise mixed at 10 dB SNR (caller side), then the pstn chain
// All DSP is pure TypeScript and deterministic (unit tested). It does not shell out to ffmpeg:
// the Homebrew ffmpeg on the dev machine broke when x265 was upgraded underneath it, and the
// needs here (two biquads, a factor-2 resampler, G.711, pink noise) are small enough to own.

export const RATE = 16000;

export const chunkSamples = (ms: number, rate = RATE) => Math.round((rate * ms) / 1000);

// ---------- G.711 mu-law (ITU-T G.711, 16-bit linear in/out) ----------
const BIAS = 0x84;
const CLIP = 32635;

function encodeSample(sample: number): number {
  let s = sample;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function decodeSample(code: number): number {
  const u = ~code & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -magnitude : magnitude;
}

export function mulawEncode(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = encodeSample(pcm[i]!);
  return out;
}

export function mulawDecode(codes: Uint8Array): Int16Array {
  const out = new Int16Array(codes.length);
  for (let i = 0; i < codes.length; i++) out[i] = decodeSample(codes[i]!);
  return out;
}

// ---------- levels and mixing ----------
export function rms(x: Int16Array): number {
  if (!x.length) return 0;
  let acc = 0;
  for (let i = 0; i < x.length; i++) acc += x[i]! * x[i]!;
  return Math.sqrt(acc / x.length);
}

// RMS over 20 ms frames that are within 40 dB of the loudest frame: the speech level without
// the leading/trailing silence TTS adds, so SNR is defined against active speech.
export function activeRms(x: Int16Array, frame = chunkSamples(20)): number {
  const frames: number[] = [];
  for (let i = 0; i + frame <= x.length; i += frame) frames.push(rms(x.subarray(i, i + frame)));
  const peak = Math.max(0, ...frames);
  if (!peak) return 0;
  const floor = peak / 100;
  const active = frames.filter((f) => f >= floor);
  return Math.sqrt(active.reduce((a, f) => a + f * f, 0) / active.length);
}

export const snrDb = (signalRms: number, noiseRms: number) => 20 * Math.log10(signalRms / noiseRms);

/** Gain to apply to noise so that signal/noise = snr dB. */
export const gainForSnr = (signalRms: number, noiseRms: number, snr: number) => signalRms / (noiseRms * 10 ** (snr / 20));

const clamp16 = (v: number) => (v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v));

/** signal + gain * noise (noise is looped if shorter), clipped to 16 bits. */
export function mixAtGain(signal: Int16Array, noise: Int16Array, gain: number, noiseOffset = 0): Int16Array {
  const out = new Int16Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = clamp16(signal[i]! + gain * noise[(noiseOffset + i) % noise.length]!);
  return out;
}

export const scale = (x: Int16Array, gain: number) => Int16Array.from(x, (v) => clamp16(v * gain));

export function concat(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const toBytes = (x: Int16Array) => new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
export const fromBytes = (b: Uint8Array) => {
  const copy = new Uint8Array(b.byteLength - (b.byteLength % 2));
  copy.set(b.subarray(0, copy.length));
  return new Int16Array(copy.buffer);
};

export function wav(x: Int16Array, rate = RATE): Uint8Array {
  const data = toBytes(x);
  const buf = new ArrayBuffer(44 + data.byteLength);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + data.byteLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, data.byteLength, true);
  new Uint8Array(buf, 44).set(data);
  return new Uint8Array(buf);
}


// ---------- filters and resampling ----------
const toFloat = (x: Int16Array) => Float64Array.from(x);
const toInt16 = (x: Float64Array) => Int16Array.from(x, clamp16);

/** RBJ-cookbook biquad, direct form I. */
function biquadF(x: Float64Array, type: "lowpass" | "highpass", f0: number, q = Math.SQRT1_2, fs = RATE): Float64Array {
  const w0 = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const [b0, b1, b2] = type === "lowpass" ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

export const biquad = (x: Int16Array, type: "lowpass" | "highpass", f0: number) => toInt16(biquadF(toFloat(x), type, f0));

// 4th-order Butterworth as two biquads with the Butterworth pole Qs.
const BUTTER4_Q = [0.5412, 1.3066];
const butter4 = (x: Float64Array, type: "lowpass" | "highpass", f0: number) => BUTTER4_Q.reduce((acc, q) => biquadF(acc, type, f0, q), x);

// Blackman-windowed sinc lowpass at 3500 Hz (fs 16 kHz), 127 taps: anti-alias / anti-image
// filter for the 16 kHz <-> 8 kHz conversion.
const TAPS = 127;
const MID = (TAPS - 1) / 2;
const FIR = (() => {
  const fc = 3500 / RATE;
  const h = Array.from({ length: TAPS }, (_, n) => {
    const k = n - MID;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (TAPS - 1));
    return sinc * w;
  });
  const sum = h.reduce((a, v) => a + v, 0);
  return Float64Array.from(h, (v) => v / sum);
})();

function downsample2F(x: Float64Array): Float64Array {
  const out = new Float64Array(Math.floor(x.length / 2));
  for (let k = 0; k < out.length; k++) {
    let acc = 0;
    const c = 2 * k + MID;
    for (let j = 0; j < TAPS; j++) {
      const i = c - j;
      if (i >= 0 && i < x.length) acc += FIR[j]! * x[i]!;
    }
    out[k] = acc;
  }
  return out;
}

function upsample2F(x: Float64Array): Float64Array {
  const out = new Float64Array(x.length * 2);
  for (let i = 0; i < out.length; i++) {
    let acc = 0;
    // zero-stuffed input z[m] = x[m / 2] for even m; out[i] = 2 * sum_j h[j] z[i - j + MID]
    for (let j = (i + MID) & 1; j < TAPS; j += 2) {
      const m = i - j + MID;
      if (m >= 0 && m < out.length) acc += FIR[j]! * x[m >> 1]!;
    }
    out[i] = 2 * acc;
  }
  return out;
}

export const downsample2 = (x: Int16Array) => toInt16(downsample2F(toFloat(x)));
export const upsample2 = (x: Int16Array) => toInt16(upsample2F(toFloat(x)));

/** 16 kHz PCM through a telephone channel and back: 300-3400 Hz, 8 kHz, G.711 mu-law, 16 kHz. */
export function pstnChain(x: Int16Array): Int16Array {
  if (!x.length) return x;
  const band = butter4(butter4(toFloat(x), "highpass", 300), "lowpass", 3400);
  const line = mulawDecode(mulawEncode(toInt16(downsample2F(band))));
  const wide = toInt16(upsample2F(toFloat(line)));
  const out = new Int16Array(x.length); // keep clip timing identical to the input
  out.set(wide.subarray(0, x.length));
  return out;
}

// ---------- noise ----------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic pink noise (Paul Kellet's refined filter over seeded white noise). */
export function pinkNoise(samples: number, seed = 7, amplitude = 0.3): Int16Array {
  const rand = mulberry32(seed);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    const w = rand() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    out[i] = clamp16(pink * 0.11 * amplitude * 32767);
  }
  return out;
}
