import { describe, expect, test } from "bun:test";
import { rate } from "../src/rating/engine";
import { stateConfig, valueBandFor } from "../src/rating/rateTable";
import type { PackageId, RatingDriver, RatingInput, RatingVehicle } from "../src/rating/types";

const adult: RatingDriver = { age: 38, yearsLicensed: 20, minorViolations3y: 0, majorViolations3y: 0, atFaultAccidents3y: 0 };
const sedan: RatingVehicle = { modelYear: 2021, bodyClass: "sedan", valueBand: "standard", usage: "commute", annualMiles: 12000, antiTheft: false };
const base: RatingInput = { state: "NJ", territory: 3, drivers: [adult], vehicles: [sedan], package: "recommended", priorInsuranceMonths: 24, payInFull: false, effectiveYear: 2026 };

export const PERSONAS: Record<string, RatingInput> = {
  "clean adult, suburban": base,
  "young driver, urban": { ...base, territory: 1, drivers: [{ age: 19, yearsLicensed: 2, minorViolations3y: 0, majorViolations3y: 0, atFaultAccidents3y: 0 }] },
  "points-heavy": { ...base, drivers: [{ ...adult, minorViolations3y: 2, atFaultAccidents3y: 1 }] },
  "multi-car household": {
    ...base,
    drivers: [adult, { age: 41, yearsLicensed: 23, minorViolations3y: 0, majorViolations3y: 0, atFaultAccidents3y: 0 }],
    vehicles: [sedan, { ...sedan, modelYear: 2016, bodyClass: "suv", valueBand: "economy", usage: "pleasure", annualMiles: 6000 }],
    payInFull: true,
  },
  "no prior insurance, state minimum": { ...base, priorInsuranceMonths: 0, package: "minimum", territory: 2 },
  "high-value vehicle, premium package": { ...base, vehicles: [{ ...sedan, modelYear: 2026, bodyClass: "suv", valueBand: "luxury", antiTheft: true }], package: "premium" },
  "teen added to household": {
    ...base,
    drivers: [adult, { age: 17, yearsLicensed: 1, minorViolations3y: 0, majorViolations3y: 0, atFaultAccidents3y: 0 }],
    vehicles: [sedan, { ...sedan, modelYear: 2012, valueBand: "economy", annualMiles: 5000, usage: "pleasure" }],
  },
};

describe("rating engine", () => {
  test("ISC-1: pure and deterministic across 100 runs", () => {
    for (const input of Object.values(PERSONAS)) {
      const first = JSON.stringify(rate(input));
      for (let i = 0; i < 100; i++) expect(JSON.stringify(rate(input))).toBe(first);
    }
  });

  test("ISC-2: golden premiums for every persona", () => {
    const golden = Object.fromEntries(Object.entries(PERSONAS).map(([k, v]) => [k, { six: rate(v).sixMonthPremium, monthly: rate(v).monthlyPayment }]));
    expect(golden).toMatchSnapshot();
  });

  test("ISC-3: version stamp and per-coverage factor trace", () => {
    const r = rate(base);
    expect(r.rateTableVersion).toBe("DEMO-NJ-2026.10");
    expect(r.lines.map((l) => l.coverage).sort()).toEqual(["BI", "COLL", "COMP", "PD", "PIP", "UM"]);
    for (const l of r.lines) {
      expect(l.factors.length).toBeGreaterThan(0);
      const recomputed = Math.round(l.factors.reduce((a, f) => a * f.value, l.base) * 100) / 100;
      expect(l.premium).toBe(recomputed);
    }
  });

  test("ISC-4: premium is monotone non-decreasing in driving-record points", () => {
    let prev = 0;
    for (let minor = 0; minor <= 4; minor++) {
      for (let acc = 0; acc <= 2; acc++) {
        const p = rate({ ...base, drivers: [{ ...adult, minorViolations3y: minor, atFaultAccidents3y: acc }] }).sixMonthPremium;
        if (acc === 0 && minor > 0) expect(p).toBeGreaterThanOrEqual(prev);
        if (acc === 0) prev = p;
        expect(p).toBeGreaterThanOrEqual(rate({ ...base, drivers: [{ ...adult, minorViolations3y: minor, atFaultAccidents3y: Math.max(0, acc - 1) }] }).sixMonthPremium);
      }
    }
  });

  test("ISC-5: higher liability limits never lower the liability premium", () => {
    const liability = (pkg: PackageId) =>
      rate({ ...base, package: pkg }).lines.filter((l) => ["BI", "PD", "UM"].includes(l.coverage)).reduce((s, l) => s + l.premium, 0);
    expect(liability("recommended")).toBeGreaterThanOrEqual(liability("minimum"));
    expect(liability("premium")).toBeGreaterThanOrEqual(liability("recommended"));
    expect(stateConfig("NJ").packages.minimum.ilf.COMP).toBeNull();
  });

  test("monthly plan costs more than pay-in-full in total", () => {
    const monthly = rate({ ...base, payInFull: false });
    const pif = rate({ ...base, payInFull: true });
    expect(monthly.monthlyPayment! * 6).toBeGreaterThan(pif.sixMonthPremium);
    expect(pif.monthlyPayment).toBeNull();
  });

  test("highest-risk driver is rated on the highest-value vehicle", () => {
    const r = rate(PERSONAS["teen added to household"]!);
    const v1Age = r.lines.find((l) => l.vehicle === 1 && l.coverage === "BI")!.factors.find((f) => f.name === "driver age")!.value;
    expect(v1Age).toBe(2.6);
  });

  test("top factors name what moved the price", () => {
    expect(rate(PERSONAS["young driver, urban"]!).topFactors[0]!.name).toBe("young driver");
    expect(rate(PERSONAS["no prior insurance, state minimum"]!).topFactors.map((f) => f.name)).toContain("no prior insurance");
  });

  test("value band: luxury makes, aging into economy", () => {
    expect(valueBandFor("BMW", 2)).toBe("luxury");
    expect(valueBandFor("Honda", 8)).toBe("economy");
    expect(valueBandFor("Honda", 1)).toBe("standard");
  });
});
