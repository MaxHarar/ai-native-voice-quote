// ISO 3779 / 49 CFR 565 VIN validation with check-digit-driven correction suggestions.
// Phone ASR routinely confuses a handful of characters; when the check digit fails we
// search single-character substitutions from those confusion sets for a valid VIN.

const TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** Characters a phone line / ASR commonly confuses with each other. */
const CONFUSABLE: Record<string, string> = {
  B: "DEPV3G8", D: "BETPV0", E: "BDPTGV3", P: "BDETV", T: "DEBPV", V: "BDEPTZ", G: "JZ7B",
  "8": "HAB", H: "8A", A: "8HJK", J: "AGK", K: "AJ",
  "0": "D", M: "N", N: "M", F: "S", S: "F5X", "5": "S", X: "S6",
  "1": "7L", "7": "1", L: "1", "2": "Z", Z: "2V", "6": "X", "9": "", "3": "BEDG", "4": "", C: "Z3",
  R: "", U: "", W: "", Y: "",
};

export function normalizeVin(raw: string): string {
  // I, O, Q are illegal in VINs; callers saying "oh" almost always mean zero.
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/O/g, "0").replace(/Q/g, "0").replace(/I/g, "1");
}

function charValue(c: string): number | null {
  if (/[0-9]/.test(c)) return Number(c);
  return TRANSLIT[c] ?? null;
}

export function computeCheckDigit(vin: string): string | null {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const v = charValue(vin[i]!);
    if (v === null) return null;
    sum += v * WEIGHTS[i]!;
  }
  const r = sum % 11;
  return r === 10 ? "X" : String(r);
}

export function isValidVin(vin: string): boolean {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
  return computeCheckDigit(vin) === vin[8];
}

export type VinCheck =
  | { ok: true; vin: string }
  | { ok: false; vin: string; reason: "LENGTH" | "CHECK_DIGIT"; suggestions: string[] };

export function checkVin(raw: string): VinCheck {
  const vin = normalizeVin(raw);
  if (vin.length !== 17) return { ok: false, vin, reason: "LENGTH", suggestions: [] };
  if (isValidVin(vin)) return { ok: true, vin };
  const suggestions: string[] = [];
  for (let i = 0; i < 17 && suggestions.length < 3; i++) {
    for (const alt of CONFUSABLE[vin[i]!] ?? "") {
      const candidate = vin.slice(0, i) + alt + vin.slice(i + 1);
      if (isValidVin(candidate) && !suggestions.includes(candidate)) suggestions.push(candidate);
      if (suggestions.length >= 3) break;
    }
  }
  return { ok: false, vin, reason: "CHECK_DIGIT", suggestions };
}

/** "1HGCM82633A004352" → "1 H G C, M 8 2 6, 3 3 A 0, 0 4 3 5 2" for spoken readback. */
export function spokenVin(vin: string): string {
  return [vin.slice(0, 4), vin.slice(4, 8), vin.slice(8, 12), vin.slice(12)].map((g) => g.split("").join(" ")).join(", ");
}
