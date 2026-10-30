// Caller voice: ElevenLabs TTS at pcm_16000, cached on disk by hash of (voice, model, text) so
// reruns cost no credits. Cache lives in evals/audio/.cache/ (gitignored).

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fromBytes } from "./audio";

export const CACHE_DIR = new URL("./.cache/", import.meta.url).pathname;
export const DEFAULT_VOICE = "iP95p4xoKVk53GoZ742B"; // premade "Chris", American male
export const DEFAULT_TTS_MODEL = "eleven_multilingual_v2";

export interface TtsOptions {
  key: string;
  voice: string;
  model: string;
}

export const ttsCacheKey = (voice: string, model: string, text: string) => createHash("sha256").update(`${voice}\n${model}\n${text}`).digest("hex").slice(0, 32);

export async function synth(text: string, o: TtsOptions): Promise<{ pcm: Int16Array; cached: boolean }> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = Bun.file(`${CACHE_DIR}${ttsCacheKey(o.voice, o.model, text)}.pcm`);
  if (await file.exists()) return { pcm: fromBytes(new Uint8Array(await file.arrayBuffer())), cached: true };
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${o.voice}?output_format=pcm_16000`, {
    method: "POST",
    headers: { "xi-api-key": o.key, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: o.model }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength < 3200) throw new Error(`TTS returned ${bytes.byteLength} bytes for a line; expected PCM audio`);
  await Bun.write(file, bytes);
  return { pcm: fromBytes(bytes), cached: false };
}
