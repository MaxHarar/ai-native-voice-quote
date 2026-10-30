// NHTSA vPIC VIN decode. Free, unauthenticated, occasionally slow — so it lives behind a
// hard timeout and a cache, and a failure never blocks the quote (we fall back to stated YMM).

export interface DecodedVin {
  year: number;
  make: string;
  model: string;
  bodyClass: string;
}

export interface VinCache {
  get(vin: string): DecodedVin | null;
  set(vin: string, decoded: DecodedVin): void;
}

const VPIC_URL = process.env.VPIC_URL ?? "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues";
export const VPIC_TIMEOUT_MS = Number(process.env.VPIC_TIMEOUT_MS ?? 1500);

export type DecodeOutcome = { decoded: DecodedVin; source: "cache" | "vpic" } | { decoded: null; source: "timeout" | "error" | "not_found" };

export async function decodeVin(vin: string, cache: VinCache, fetchImpl: typeof fetch = fetch): Promise<DecodeOutcome> {
  const hit = cache.get(vin);
  if (hit) return { decoded: hit, source: "cache" };
  try {
    const res = await fetchImpl(`${VPIC_URL}/${vin}?format=json`, { signal: AbortSignal.timeout(VPIC_TIMEOUT_MS) });
    if (!res.ok) return { decoded: null, source: "error" };
    const json = (await res.json()) as { Results?: Record<string, string>[] };
    const r = json.Results?.[0];
    const year = Number(r?.ModelYear);
    if (!r || !r.Make || !year) return { decoded: null, source: "not_found" };
    const decoded: DecodedVin = { year, make: r.Make.toUpperCase(), model: r.Model ?? "", bodyClass: r.BodyClass ?? "" };
    cache.set(vin, decoded);
    return { decoded, source: "vpic" };
  } catch (e) {
    return { decoded: null, source: (e as Error).name === "TimeoutError" ? "timeout" : "error" };
  }
}

// ── Year/make/model check when there's no VIN ──
// vPIC lists every model a make sold in a model year. A spoken model that isn't on the list ("535" for a
// 2015 BMW) gets the closest listed names ("535i", "535d") for the agent to confirm. Never blocks a save.

const MAKE_ALIASES: Record<string, string> = { mercedes: "mercedes-benz", benz: "mercedes-benz", chevy: "chevrolet", vw: "volkswagen", landrover: "land rover", mini: "mini" };
export const normalizeModelName = (s: string) => s.toLowerCase().replace(/-?class\b/g, "").replace(/[^a-z0-9]/g, "");

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

export type ModelMatch = { status: "match"; model: string } | { status: "close"; likely: string[] } | { status: "unknown" };

export function matchModel(spoken: string, models: string[]): ModelMatch {
  const n = normalizeModelName(spoken);
  if (!n) return { status: "unknown" };
  const exact = models.find((m) => normalizeModelName(m) === n);
  if (exact) return { status: "match", model: exact };
  const scored = models
    .map((m) => {
      const k = normalizeModelName(m);
      // "535" → "535i"; "GLE 350" → "GLE-Class" (but never a one-letter name like "G-Class").
      const prefix = k.startsWith(n) || (k.length >= 2 && n.startsWith(k)) ? Math.abs(k.length - n.length) * 0.1 : Infinity;
      const dist = editDistance(n, k);
      return { m, score: Math.min(prefix, dist <= (n.length >= 5 ? 2 : 1) ? dist : Infinity) };
    })
    .filter((x) => x.score !== Infinity && normalizeModelName(x.m).length > 0)
    .sort((a, b) => a.score - b.score || a.m.localeCompare(b.m));
  const likely = [...new Set(scored.map((x) => x.m))].slice(0, 3);
  return likely.length ? { status: "close", likely } : { status: "unknown" };
}

const MODELS_URL = process.env.VPIC_MODELS_URL ?? "https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make";
const modelCache = new Map<string, { at: number; models: string[] }>();
const MODEL_CACHE_MS = 24 * 3600_000;
// The model list call is slower than VIN decode on a cold cache (live probe 2026-10-15: first calls missed 1.5 s).
export const VPIC_MODELS_TIMEOUT_MS = Number(process.env.VPIC_MODELS_TIMEOUT_MS ?? 3000);

/** Models vPIC lists for a make and year, or null when vPIC is slow, down, or doesn't know the make. */
export async function modelsForMakeYear(make: string, year: number, fetchImpl: typeof fetch = fetch): Promise<string[] | null> {
  const m = make.trim().toLowerCase();
  const slug = MAKE_ALIASES[m.replace(/[^a-z]/g, "")] ?? m;
  const key = `${slug}|${year}`;
  const hit = modelCache.get(key);
  if (hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.models;
  try {
    const res = await fetchImpl(`${MODELS_URL}/${encodeURIComponent(slug)}/modelyear/${year}?format=json`, { signal: AbortSignal.timeout(VPIC_MODELS_TIMEOUT_MS) });
    if (!res.ok) return null;
    const json = (await res.json()) as { Results?: { Model_Name?: string }[] };
    const models = [...new Set((json.Results ?? []).map((r) => r.Model_Name?.trim()).filter((x): x is string => Boolean(x)))];
    if (!models.length) return null;
    modelCache.set(key, { at: Date.now(), models });
    return models;
  } catch {
    return null;
  }
}
