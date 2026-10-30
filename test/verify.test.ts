import { describe, expect, test } from "bun:test";
import { checkDob, checkLicense, checkYearsLicensed } from "../src/verify/identity";
import { checkVin, computeCheckDigit, isValidVin, normalizeVin } from "../src/verify/vin";
import { decodeVin, type DecodedVin, type VinCache } from "../src/verify/vpic";
import { checkZip } from "../src/verify/zip";

const memCache = (): VinCache => {
  const m = new Map<string, DecodedVin>();
  return { get: (v) => m.get(v) ?? null, set: (v, d) => void m.set(v, d) };
};

describe("VIN (ISO 3779)", () => {
  test("ISC-8: accepts real VINs, rejects bad check digits", () => {
    expect(isValidVin("1HGCM82633A004352")).toBe(true);
    expect(isValidVin("1M8GDM9AXKP042788")).toBe(true); // check digit X
    expect(isValidVin("11111111111111111")).toBe(true);
    expect(isValidVin("1HGCM82643A004352")).toBe(false);
    expect(isValidVin("1HGCM82633A00435")).toBe(false);
  });

  test("normalizes spoken artifacts: spaces, dashes, O→0, I→1", () => {
    expect(normalizeVin("1hg-cm8 2633a OO4352")).toBe("1HGCM82633A004352");
  });

  test("known blind spot: H↔8 share a transliteration value, so the check digit cannot see that swap", () => {
    expect(isValidVin("18GCM82633A004352")).toBe(true); // why the vPIC decode is the second net (VIN_NOT_FOUND)
  });

  test("misheard character → check-digit failure with the right correction suggested", () => {
    const heard = "1HGCN82633A004352"; // M heard as N
    const r = checkVin(heard);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("CHECK_DIGIT");
      expect(r.suggestions).toContain("1HGCM82633A004352");
    }
    expect(computeCheckDigit("1HGCM82633A004352")).toBe("3");
  });

  test("ISC-10: decode timeout falls back without throwing", async () => {
    const slow = (() => new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("t"), { name: "TimeoutError" })), 5))) as unknown as typeof fetch;
    expect((await decodeVin("1HGCM82633A004352", memCache(), slow)).source).toBe("timeout");
  });

  test("decode uses the cache on the second call", async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response(JSON.stringify({ Results: [{ ModelYear: "2003", Make: "HONDA", Model: "Accord", BodyClass: "Coupe" }] }));
    }) as unknown as typeof fetch;
    const cache = memCache();
    expect((await decodeVin("1HGCM82633A004352", cache, fake)).source).toBe("vpic");
    expect((await decodeVin("1HGCM82633A004352", cache, fake)).source).toBe("cache");
    expect(calls).toBe(1);
  });
});

describe("identity", () => {
  const asOf = new Date("2026-10-14T12:00:00Z");

  test("ISC-11: NJ license is 1 letter + 14 digits; other states have their own formats", () => {
    expect(checkLicense("NJ", "S1000 00000 00001", "Smith").ok).toBe(true);
    expect(checkLicense("NJ", "S100000000000", "Smith").ok).toBe(false);
    expect(checkLicense("PA", "12345678", "Smith").ok).toBe(true);
    expect(checkLicense("PA", "1234567", "Smith").ok).toBe(false);
  });

  test("ISC-13 (identity): NJ license initial must match last name → VERIFY_MISMATCH warning", () => {
    const r = checkLicense("NJ", "D20000000000002", "Smith");
    expect(r.ok && r.warnings[0]).toContain("VERIFY_MISMATCH");
  });

  test("ISC-12: DOB rejects underage, >100, future, impossible dates", () => {
    expect(checkDob("1988-03-02", asOf).ok).toBe(true);
    expect(checkDob("2012-01-01", asOf).ok).toBe(false);
    expect(checkDob("1900-01-01", asOf).ok).toBe(false);
    expect(checkDob("2027-01-01", asOf).ok).toBe(false);
    expect(checkDob("1990-02-30", asOf).ok).toBe(false);
  });

  test("years licensed cannot exceed age - 15", () => {
    expect(checkYearsLicensed(20, 38).ok).toBe(true);
    expect(checkYearsLicensed(30, 38).ok).toBe(false);
  });
});

describe("ZIP → territory", () => {
  test("ISC-6: NJ ZIP maps to a territory; non-NJ is OUT_OF_STATE", () => {
    expect(checkZip("08540")).toEqual({ ok: true, zip: "08540", state: "NJ", territory: 3 });
    expect(checkZip("07102")).toMatchObject({ ok: true, territory: 1 });
    expect(checkZip("19123")).toMatchObject({ ok: true, state: "PA", territory: 1 }); // Philadelphia
    expect(checkZip("18947")).toMatchObject({ ok: true, state: "PA", territory: 3 }); // Bucks County
    expect(checkZip("15213")).toMatchObject({ ok: true, state: "PA", territory: 2 }); // Pittsburgh
    expect(checkZip("16801")).toMatchObject({ ok: true, state: "PA", territory: 5 }); // State College
    expect(checkZip("10001")).toMatchObject({ ok: false, error: "OUT_OF_STATE", state: "NY" });
    expect(checkZip("19801")).toMatchObject({ ok: false, error: "OUT_OF_STATE", state: "DE" });
    expect(checkZip("085")).toMatchObject({ ok: false, error: "INVALID_ZIP" });
  });
});
