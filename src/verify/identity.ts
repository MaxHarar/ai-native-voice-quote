// Ingestion-time validators for driver identity fields. Each returns a speakable hint on failure.

export type Check<T> = { ok: true; value: T; warnings: string[] } | { ok: false; error: string; hint: string };

/** Driver license formats by state (subset; others fall back to a permissive pattern). */
const LICENSE_FORMATS: Record<string, { re: RegExp; spoken: string }> = {
  NJ: { re: /^[A-Z]\d{14}$/, spoken: "one letter followed by fourteen digits" },
  PA: { re: /^\d{8}$/, spoken: "eight digits" },
  NY: { re: /^(\d{9}|[A-Z]\d{7}|[A-Z]\d{18}|\d{8}|\d{16}|[A-Z]{8})$/, spoken: "usually nine digits" },
  DE: { re: /^\d{1,7}$/, spoken: "up to seven digits" },
  MI: { re: /^[A-Z]\d{12}$/, spoken: "one letter followed by twelve digits" },
};

export function normalizeLicense(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** "T50000000000005" → "T, 5 0 0 0, 0 0 0 0, 0 0 0 0, 0 5" so the agent can compare against what the caller said. */
export function spokenLicense(lic: string): string {
  const m = lic.match(/^([A-Z]*)(\d*)$/);
  if (!m) return lic.split("").join(" ");
  const groups = (m[2] ?? "").match(/.{1,4}/g) ?? [];
  return [m[1], ...groups.map((g) => g.split("").join(" "))].filter(Boolean).join(", ");
}

export function checkLicense(state: string, raw: string, lastName: string): Check<string> {
  const st = state.toUpperCase().trim();
  const lic = normalizeLicense(raw);
  const fmt = LICENSE_FORMATS[st];
  if (fmt && !fmt.re.test(lic)) {
    const digits = lic.replace(/\D/g, "").length;
    return {
      ok: false,
      error: "INVALID_LICENSE",
      hint: `${st} license numbers are ${fmt.spoken}. I received "${spokenLicense(lic)}" (${digits} digits). If that differs from what the caller said, fix your transcription and save again; otherwise ask them to read it again in small groups.`,
    };
  }
  if (!fmt && !/^[A-Z0-9]{4,20}$/.test(lic)) {
    return { ok: false, error: "INVALID_LICENSE", hint: "That license number doesn't look right. Ask the caller to read it again." };
  }
  const warnings: string[] = [];
  // NJ license numbers begin with the first letter of the holder's last name.
  if (st === "NJ" && lastName && lic[0] !== lastName.trim().toUpperCase()[0]) {
    warnings.push("VERIFY_MISMATCH: New Jersey license numbers start with the first letter of the last name, and this one doesn't. Confirm the last name and the first letter of the license.");
  }
  return { ok: true, value: lic, warnings };
}

export function ageOn(dob: string, asOf: Date): number {
  const d = new Date(dob + "T00:00:00Z");
  let age = asOf.getUTCFullYear() - d.getUTCFullYear();
  const m = asOf.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && asOf.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

export function checkDob(dob: string, asOf: Date): Check<{ dob: string; age: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return { ok: false, error: "INVALID_DOB", hint: "Ask for the date of birth as month, day, and year." };
  const d = new Date(dob + "T00:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dob) {
    return { ok: false, error: "INVALID_DOB", hint: "That date doesn't exist. Ask for the date of birth again." };
  }
  if (d > asOf) return { ok: false, error: "INVALID_DOB", hint: "That date is in the future. Ask for the date of birth again." };
  const age = ageOn(dob, asOf);
  if (age < 16) return { ok: false, error: "UNDERAGE", hint: "Drivers must be at least 16. Confirm the date of birth." };
  if (age > 100) return { ok: false, error: "INVALID_DOB", hint: "Confirm the year of birth." };
  return { ok: true, value: { dob, age }, warnings: [] };
}

export function checkYearsLicensed(years: number, age: number): Check<number> {
  if (!Number.isFinite(years) || years < 0) return { ok: false, error: "INVALID_YEARS_LICENSED", hint: "Ask how many years they've been licensed." };
  if (years > age - 15) return { ok: false, error: "INVALID_YEARS_LICENSED", hint: `That's more years licensed than possible at age ${age}. Confirm the number of years licensed.` };
  return { ok: true, value: years, warnings: [] };
}
