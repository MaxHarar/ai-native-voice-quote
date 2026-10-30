// Channel conditions applied to synthesized caller audio before it is streamed.
//   clean    16 kHz PCM as synthesized; digital silence between lines
//   pstn     telephone channel (300-3400 Hz, 8 kHz, G.711 mu-law round trip, back to 16 kHz)
//   noiseN   pink noise at N dB SNR against active speech, mixed caller-side, then pstn.
//            The noise keeps running between lines (a "bed"), like a real room or street.

import { activeRms, concat, gainForSnr, mixAtGain, pinkNoise, pstnChain, RATE, rms, scale, snrDb } from "./audio";

export interface Prepared {
  condition: string;
  /** Processed clip per input clip, same order. */
  clips: Int16Array[];
  /** What streams between lines; null = digital silence. */
  bed: Int16Array | null;
  info: { snr_target_db?: number; snr_measured_db?: number; snr_caller_side_db?: number; noise?: string };
}

export function parseCondition(c: string): { pstn: boolean; snr: number | null } {
  if (c === "clean") return { pstn: false, snr: null };
  if (c === "pstn") return { pstn: true, snr: null };
  const m = /^noise(\d+)$/.exec(c);
  if (m) return { pstn: true, snr: Number(m[1]) };
  throw new Error(`unknown condition "${c}" (use clean, pstn, or noiseN such as noise10)`);
}

const NOISE_SECONDS = 120;
const NOISE_SEED = 7;

export function prepare(condition: string, raw: Int16Array[]): Prepared {
  const { pstn, snr } = parseCondition(condition);
  if (!pstn) return { condition, clips: raw, bed: null, info: {} };
  if (snr === null) return { condition, clips: raw.map(pstnChain), bed: null, info: {} };

  const bedRaw = pinkNoise(RATE * NOISE_SECONDS, NOISE_SEED);
  // One noise level per script, calibrated so the SNR the AGENT RECEIVES (after the telephone
  // band strips the noise's sub-300 Hz energy) is the target: pooled active-speech level of all
  // lines vs noise level, both measured after the pstn chain. Noise is still mixed caller-side.
  const speechRx = activeRms(pstnChain(concat(raw)));
  const gain = gainForSnr(speechRx, rms(pstnChain(bedRaw)), snr);
  let offset = 0;
  const clips = raw.map((clip) => {
    const mixed = mixAtGain(clip, bedRaw, gain, offset);
    offset += clip.length;
    return pstnChain(mixed);
  });
  const scaled = scale(bedRaw, gain);
  const bed = pstnChain(scaled);
  return {
    condition,
    clips,
    bed,
    info: {
      snr_target_db: snr,
      snr_measured_db: Number(snrDb(speechRx, rms(bed)).toFixed(2)),
      snr_caller_side_db: Number(snrDb(activeRms(concat(raw)), rms(scaled)).toFixed(2)),
      noise: `pink (seeded ${NOISE_SEED}), mixed caller-side, continuous between lines; SNR measured at the agent's input`,
    },
  };
}
