import { describe, expect, test } from "bun:test";
import { pullReports } from "../src/reports/vendor";
import { isValidApplicationNumber, luhnValid, newApplicationNumber, normalizeApplicationNumber, spokenApplicationNumber } from "../src/underwriting/appNumber";
import { checkEligibility } from "../src/underwriting/eligibility";
import { mergeRecord } from "../src/underwriting/merge";

const asOf = new Date("2026-10-14T12:00:00Z");
const clean = { tickets3y: 0, atFaultAccidents3y: 0, dui3y: false };

describe("simulated reports", () => {
  test("ISC-14: deterministic by license number", () => {
    expect(pullReports("D20000000000002")).toEqual(pullReports("D20000000000002"));
    expect(pullReports("Z99999999999999").mvr.source).toBe("default");
  });

  test("ISC-15: unreported MVR tickets are merged in and flagged", () => {
    const m = mergeRecord(clean, pullReports("D20000000000002"), asOf);
    expect(m.minorViolations3y).toBe(2);
    expect(m.discrepancies.length).toBe(1);
    expect(m.discrepancies[0]).toContain("2 tickets");
  });

  test("self-report wins when it shows more than the reports", () => {
    expect(mergeRecord({ ...clean, tickets3y: 1 }, pullReports("S10000000000001"), asOf).minorViolations3y).toBe(1);
  });

  test("CLUE at-fault claim is merged", () => {
    const m = mergeRecord(clean, pullReports("T50000000000005"), asOf);
    expect(m.atFaultAccidents3y).toBe(1);
    expect(m.discrepancies[0]).toContain("at-fault");
  });
});

describe("eligibility", () => {
  test("ISC-16: suspended license → REFER", () => {
    const m = mergeRecord(clean, pullReports("K40000000000004"), asOf);
    expect(checkEligibility([m], [{ modelYear: 2020, rideshareOrCommercial: false }], 2026)).toEqual({ status: "REFER", reasons: ["LICENSE_NOT_VALID"] });
  });

  test("ISC-18: DUI, 3 at-fault, rideshare, 30+ yr vehicle, too many units → REFER with reasons", () => {
    const dui = mergeRecord(clean, pullReports("R30000000000003"), asOf);
    expect(checkEligibility([dui], [{ modelYear: 2020, rideshareOrCommercial: false }], 2026)).toMatchObject({ reasons: ["DUI_WITHIN_3Y"] });
    const accidents = mergeRecord({ ...clean, atFaultAccidents3y: 3 }, pullReports("S10000000000001"), asOf);
    expect(checkEligibility([accidents], [{ modelYear: 2020, rideshareOrCommercial: false }], 2026)).toMatchObject({ reasons: ["THREE_PLUS_AT_FAULT"] });
    const ok = mergeRecord(clean, pullReports("S10000000000001"), asOf);
    expect(checkEligibility([ok], [{ modelYear: 2020, rideshareOrCommercial: true }], 2026)).toMatchObject({ reasons: ["RIDESHARE_OR_COMMERCIAL"] });
    expect(checkEligibility([ok], [{ modelYear: 1990, rideshareOrCommercial: false }], 2026)).toMatchObject({ reasons: ["VEHICLE_TOO_OLD"] });
    expect(checkEligibility([ok, ok, ok, ok, ok], [{ modelYear: 2020, rideshareOrCommercial: false }], 2026)).toMatchObject({ reasons: ["TOO_MANY_UNITS"] });
    expect(checkEligibility([ok], [{ modelYear: 2020, rideshareOrCommercial: false }], 2026)).toEqual({ status: "OK" });
  });
});

describe("application numbers", () => {
  test("ISC-21: Luhn check digit, prefix, spoken form", () => {
    for (let i = 0; i < 500; i++) {
      const n = newApplicationNumber();
      expect(n).toMatch(/^ANA-\d{7}$/);
      expect(luhnValid(n.slice(4))).toBe(true);
      expect(isValidApplicationNumber(n)).toBe(true);
    }
    expect(spokenApplicationNumber("ANA-4829173")).toBe("4 8 2, 9 1 7, 3");
    expect(normalizeApplicationNumber("4 8 2 9 1 7 3")).toBe(luhnValid("4829173") ? "ANA-4829173" : null);
  });

  test("a single misheard digit is caught", () => {
    const n = newApplicationNumber().slice(4);
    const flipped = n.slice(0, 2) + String((Number(n[2]) + 1) % 10) + n.slice(3);
    expect(luhnValid(flipped)).toBe(false);
  });
});
