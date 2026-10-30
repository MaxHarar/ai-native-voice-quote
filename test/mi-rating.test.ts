// Michigan rating against the statutes. Pure functions only: no server, no database, no network.
//
// Each test names the Michigan Compiled Laws provision it proves. Citations come from the verified
// list in the Michigan build contract; the MCL 500.2111 sub-paragraph letters were also checked
// against the legislature's published text. A failure here means the rating code or its rate table
// is out of step with the statute. Fix the code; do not loosen the test.

import { describe, expect, test } from "bun:test";
import { assignDrivers, rate } from "../src/rating/engine";
import {
  DEFAULT_MERIT,
  RATE_TABLE_VERSIONS,
  STATE_CONFIGS,
  normalizeMunicipality,
  stateConfig,
  territoryForMunicipality,
  territoryForZip,
} from "../src/rating/rateTable";
import type { Coverage, PackageId, PipMedical, RatingDriver, RatingInput, RatingResult, RatingVehicle, State, Territory } from "../src/rating/types";
import type { ClueClaim, DriverReports, Violation } from "../src/reports/vendor";
import { mergeRecord, type MergedRecord, type SelfReported } from "../src/underwriting/merge";
import { SERVED_STATES, checkZip } from "../src/verify/zip";

// ---------------------------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------------------------

const adult: RatingDriver = { age: 38, yearsLicensed: 20, minorViolations3y: 0, majorViolations3y: 0, atFaultAccidents3y: 0 };
const sedan: RatingVehicle = { modelYear: 2021, bodyClass: "sedan", valueBand: "standard", usage: "commute", annualMiles: 12000, antiTheft: false };
const economyCar: RatingVehicle = { ...sedan, modelYear: 2015, valueBand: "economy" };

const mi: RatingInput = { state: "MI", territory: 3, drivers: [adult], vehicles: [sedan], package: "recommended", priorInsuranceMonths: 24, payInFull: false, effectiveYear: 2026 };
const nj: RatingInput = { ...mi, state: "NJ" };
const pa: RatingInput = { ...mi, state: "PA", tortOption: "full", umStacked: true };

const PACKAGE_IDS: readonly PackageId[] = ["minimum", "recommended", "premium"];
const PIP_LEVELS: readonly PipMedical[] = ["unlimited", "500k", "250k", "250k_excluded", "50k", "opt_out"];

const MI_MERIT = (() => {
  const merit = stateConfig("MI").merit;
  if (!merit) throw new Error("the Michigan rate table has no merit rules");
  return merit;
})();

const round2 = (n: number) => Math.round(n * 100) / 100;

function lineOf(r: RatingResult, coverage: Coverage, vehicle = 1) {
  const l = r.lines.find((x) => x.vehicle === vehicle && x.coverage === coverage);
  if (!l) throw new Error(`no ${coverage} line on vehicle ${vehicle}; the result has ${r.lines.map((x) => `${x.vehicle}:${x.coverage}`).join(", ")}`);
  return l;
}
const coveragesOf = (r: RatingResult, vehicle = 1) => r.lines.filter((l) => l.vehicle === vehicle).map((l) => l.coverage);
const factorNames = (r: RatingResult) => r.lines.flatMap((l) => l.factors.map((f) => f.name));
const withDriver = (base: RatingInput, d: RatingDriver): RatingInput => ({ ...base, drivers: [d] });
const assessedTotal = (r: RatingResult) => r.assessments.reduce((s, a) => s + a.amount, 0);

// Small seeded generator so the property tests are reproducible.
type Rng = () => number;
function seeded(seed: number): Rng {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[int(rng, 0, xs.length - 1)]!;

/** A random household with no state attached; callers choose the state and PIP election. */
function household(rng: Rng): Omit<RatingInput, "state"> {
  return {
    territory: pick(rng, [1, 2, 3, 4, 5] as const),
    drivers: Array.from({ length: int(rng, 1, 3) }, () => {
      const age = int(rng, 16, 90);
      return { age, yearsLicensed: int(rng, 0, age - 16), minorViolations3y: int(rng, 0, 3), majorViolations3y: int(rng, 0, 1), atFaultAccidents3y: int(rng, 0, 2) };
    }),
    vehicles: Array.from({ length: int(rng, 1, 3) }, () => ({
      modelYear: int(rng, 2000, 2027),
      bodyClass: pick(rng, ["sedan", "suv", "truck", "van", "sports", "other"] as const),
      valueBand: pick(rng, ["economy", "standard", "premium", "luxury"] as const),
      usage: pick(rng, ["pleasure", "commute", "business"] as const),
      annualMiles: pick(rng, [500, 2500, 2999, 3000, 7499, 7500, 12000, 15000, 15001, 25000] as const),
      antiTheft: rng() < 0.5,
    })),
    package: pick(rng, PACKAGE_IDS),
    priorInsuranceMonths: pick(rng, [0, 3, 6, 24, 60] as const),
    payInFull: rng() < 0.5,
    effectiveYear: 2026,
  };
}
const inState = (h: Omit<RatingInput, "state">, state: State, pipMedical?: PipMedical): RatingInput => ({ ...h, state, ...(pipMedical ? { pipMedical } : {}) });

const HOUSEHOLDS = 300;

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------
// ZIP: the state, never the price
// ---------------------------------------------------------------------------------------------

describe("ZIP code decides the state, never the price (MCL 500.2111(4)(f))", () => {
  test("Michigan ZIPs resolve to MI with no territory", () => {
    expect(territoryForZip("48226")).toEqual({ state: "MI", territory: null }); // Detroit
    expect(territoryForZip("49503")).toEqual({ state: "MI", territory: null }); // Grand Rapids
  });

  test("the Michigan range is ZIP3 480 through 499 and nothing outside it", () => {
    expect(territoryForZip("48000")).toEqual({ state: "MI", territory: null });
    expect(territoryForZip("49999")).toEqual({ state: "MI", territory: null });
    expect(territoryForZip("47999")).toBeNull();
    expect(territoryForZip("50000")).toBeNull();
  });

  test("New Jersey and Pennsylvania ZIPs still resolve to a rating territory", () => {
    expect(territoryForZip("08540")).toEqual({ state: "NJ", territory: 3 });
    expect(territoryForZip("07102")).toEqual({ state: "NJ", territory: 1 });
    expect(territoryForZip("19123")).toEqual({ state: "PA", territory: 1 }); // Philadelphia
    expect(territoryForZip("18947")).toEqual({ state: "PA", territory: 3 }); // Bucks County
    expect(territoryForZip("15213")).toEqual({ state: "PA", territory: 2 }); // Pittsburgh
    expect(territoryForZip("16801")).toEqual({ state: "PA", territory: 5 }); // State College
  });

  test("checkZip accepts a Michigan ZIP and reports no territory", () => {
    expect(checkZip("48226")).toEqual({ ok: true, zip: "48226", state: "MI", territory: null });
    expect(checkZip("49503")).toEqual({ ok: true, zip: "49503", state: "MI", territory: null });
    expect(checkZip("48226-1234")).toEqual({ ok: true, zip: "48226", state: "MI", territory: null });
  });

  test("every Michigan ZIP3 passes checkZip as in state", () => {
    for (let z = 480; z <= 499; z++) expect(checkZip(`${z}01`)).toMatchObject({ ok: true, state: "MI", territory: null });
  });

  test("Ohio is out of state, and the hint now names Michigan among the states served", () => {
    expect(checkZip("43215")).toMatchObject({
      ok: false,
      error: "OUT_OF_STATE",
      state: "OH",
      hint: expect.stringContaining("New Jersey, Pennsylvania, or Michigan"),
    });
    expect(SERVED_STATES).toBe("New Jersey, Pennsylvania, or Michigan");
  });

  test("Indiana and ZIPs just outside Michigan's range are out of state", () => {
    expect(checkZip("46204")).toMatchObject({ ok: false, error: "OUT_OF_STATE", state: "IN" });
    expect(checkZip("47999")).toMatchObject({ ok: false, error: "OUT_OF_STATE" });
    expect(checkZip("50000")).toMatchObject({ ok: false, error: "OUT_OF_STATE" });
  });

  test("a short ZIP is still invalid", () => {
    expect(checkZip("482")).toMatchObject({ ok: false, error: "INVALID_ZIP" });
  });
});

// ---------------------------------------------------------------------------------------------
// Garaging city: the only territory source in Michigan
// ---------------------------------------------------------------------------------------------

describe("Michigan rates by city or township, not postal zone (MCL 500.2111(4)(f), (5))", () => {
  test("no ZIP3 from 480 to 499 maps to a territory", () => {
    for (let z = 480; z <= 499; z++) {
      for (const tail of ["00", "01", "50", "99"]) expect(territoryForZip(`${z}${tail}`)).toEqual({ state: "MI", territory: null });
    }
  });

  test("the Michigan rate table has no ZIP3 territories, and no other state claims a Michigan ZIP3", () => {
    expect(STATE_CONFIGS.MI.zip3Territory).toEqual({});
    expect(STATE_CONFIGS.MI.municipalityRating?.zip3Range).toEqual(["480", "499"]);
    for (let z = 480; z <= 499; z++) {
      expect(STATE_CONFIGS.NJ.zip3Territory[String(z)]).toBeUndefined();
      expect(STATE_CONFIGS.PA.zip3Territory[String(z)]).toBeUndefined();
    }
  });

  test("the city separates risks that a ZIP cannot: Detroit and Marquette differ, every Michigan ZIP is alike", () => {
    expect(territoryForMunicipality("MI", "Detroit").territory).toBe(1);
    expect(territoryForMunicipality("MI", "Marquette").territory).toBe(5);
    expect(new Set(["48226", "49855", "49503", "48104"].map((z) => JSON.stringify(territoryForZip(z)))).size).toBe(1);
  });

  // [what the caller says, normalized name, territory]
  const CITY_CASES: [raw: string, normalized: string, territory: Territory][] = [
    ["Detroit", "detroit", 1],
    ["City of Detroit", "detroit", 1],
    ["detroit, MI", "detroit", 1],
    ["Clinton Twp", "clinton township", 3],
    ["Charter Township of Clinton", "clinton township", 3],
    ["Saint Clair Shores", "st clair shores", 3],
    ["St. Clair Shores", "st clair shores", 3],
    ["Sault Ste. Marie", "sault ste marie", 5],
    ["Redford Charter Township", "redford township", 2],
    // Names full of the letter "s", with state words and articles around them. These are the cases a
    // broken whitespace pattern mangles, so they pin the normalizer's real behavior.
    ["the City of St. Clair Shores, MI", "st clair shores", 3],
    ["Sterling Heights", "sterling heights", 3],
    ["Southfield", "southfield", 2],
    ["Village of Grosse Pointe Shores, Michigan", "grosse pointe shores", 3],
    ["Township of Redford", "redford township", 2],
    ["Livonia Twp", "livonia township", 3],
    ["  DETROIT  ", "detroit", 1],
  ];
  for (const [raw, normalized, territory] of CITY_CASES) {
    test(`${JSON.stringify(raw)} normalizes to "${normalized}" and rates in territory ${territory}`, () => {
      expect(normalizeMunicipality(raw)).toBe(normalized);
      expect(territoryForMunicipality("MI", raw)).toEqual({ territory, municipality: normalized, listed: true });
    });
  }

  test("an unlisted city rates in the standard fallback territory and says it was not listed", () => {
    expect(territoryForMunicipality("MI", "Kalkaska")).toEqual({ territory: 4, municipality: "kalkaska", listed: false });
    expect(STATE_CONFIGS.MI.municipalityRating?.fallback).toBe(4);
  });

  test("New Jersey and Pennsylvania are not municipality-rated", () => {
    expect(() => territoryForMunicipality("NJ", "Newark")).toThrow();
    expect(() => territoryForMunicipality("PA", "Pittsburgh")).toThrow();
  });

  test("every listed municipality is reachable: its key is already in normalized form", () => {
    const territories = STATE_CONFIGS.MI.municipalityRating?.territories ?? {};
    expect(Object.keys(territories).length).toBeGreaterThan(50);
    expect(Object.keys(territories).filter((name) => normalizeMunicipality(name) !== name)).toEqual([]);
    expect(Object.values(territories).filter((t) => ![1, 2, 3, 4, 5].includes(t))).toEqual([]);
    for (const [name, territory] of Object.entries(territories)) {
      expect(territoryForMunicipality("MI", name)).toEqual({ territory, municipality: name, listed: true });
    }
  });

  test("Detroit is the most expensive Michigan territory and the northern and rural territory the cheapest", () => {
    const prices = ([1, 2, 3, 4, 5] as const).map((t) => rate({ ...mi, territory: t }).sixMonthPremium);
    for (let i = 1; i < prices.length; i++) expect(prices[i - 1]!).toBeGreaterThan(prices[i]!);
  });
});

// ---------------------------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------------------------

describe("Michigan packages (MCL 500.3009, 500.3121, 500.3135(3)(e))", () => {
  const pk = STATE_CONFIGS.MI.packages;

  test("property protection insurance (up to $1,000,000, required, MCL 500.3121) is in every package", () => {
    for (const id of PACKAGE_IDS) {
      expect(pk[id].limits.PPI).toBe("1,000,000");
      expect(typeof pk[id].ilf.PPI).toBe("number");
      expect(coveragesOf(rate({ ...mi, package: id }))).toContain("PPI");
    }
  });

  test("mini-tort (limited property damage, $3,000, MCL 500.3135(3)(e)) is absent from the minimum and present above it", () => {
    expect(pk.minimum.ilf.LPD).toBeNull();
    expect(pk.minimum.limits.LPD).toBeNull();
    expect(coveragesOf(rate({ ...mi, package: "minimum" }))).not.toContain("LPD");
    for (const id of ["recommended", "premium"] as const) {
      expect(pk[id].limits.LPD).toBe("3,000");
      expect(typeof pk[id].ilf.LPD).toBe("number");
      expect(coveragesOf(rate({ ...mi, package: id }))).toContain("LPD");
    }
  });

  test("the minimum has no uninsured motorist, comprehensive or collision", () => {
    for (const cov of ["UM", "COMP", "COLL"] as const) {
      expect(pk.minimum.ilf[cov]).toBeNull();
      expect(coveragesOf(rate({ ...mi, package: "minimum" }))).not.toContain(cov);
    }
    for (const id of ["recommended", "premium"] as const) {
      for (const cov of ["UM", "COMP", "COLL"] as const) expect(coveragesOf(rate({ ...mi, package: id }))).toContain(cov);
    }
  });

  test("bodily injury limits: 50/100 floor, 250/500 statutory default, 500/500 above", () => {
    expect(pk.minimum.limits.BI).toBe("50/100");
    expect(pk.recommended.limits.BI).toBe("250/500");
    expect(pk.premium.limits.BI).toBe("500/500");
    expect(pk.recommended.limits.UM).toBe("250/500");
    expect(pk.premium.limits.UM).toBe("500/500");
  });

  test("property damage liability minimum is $10,000", () => {
    expect(pk.minimum.limits.PD).toBe("10");
  });

  test("no package sits below the statutory floors, and limits never fall as the package rises", () => {
    const bi = PACKAGE_IDS.map((id) => (pk[id].limits.BI ?? "").split("/").map(Number));
    const pd = PACKAGE_IDS.map((id) => Number(pk[id].limits.PD));
    for (const parts of bi) {
      expect(parts[0]!).toBeGreaterThanOrEqual(50);
      expect(parts[1]!).toBeGreaterThanOrEqual(100);
    }
    for (const n of pd) expect(n).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < PACKAGE_IDS.length; i++) {
      expect(bi[i]![0]!).toBeGreaterThanOrEqual(bi[i - 1]![0]!);
      expect(bi[i]![1]!).toBeGreaterThanOrEqual(bi[i - 1]![1]!);
      expect(pd[i]!).toBeGreaterThanOrEqual(pd[i - 1]!);
    }
  });

  test("liability below the 250/500 default needs a signed selection form, so only the minimum carries that note", () => {
    expect(pk.minimum.note).toMatch(/signed .*selection form/i);
    expect(pk.recommended.note).toBeUndefined();
    expect(pk.premium.note).toBeUndefined();
  });

  test("PIP is elected, not packaged: every package shows the election and prices PIP identically", () => {
    for (const id of PACKAGE_IDS) expect(pk[id].limits.PIP).toBe("elected");
    expect(new Set(PACKAGE_IDS.map((id) => pk[id].ilf.PIP)).size).toBe(1);
    const pip = PACKAGE_IDS.map((id) => lineOf(rate({ ...mi, package: id }), "PIP").premium);
    expect(new Set(pip).size).toBe(1);
  });

  test("line sets follow the packages", () => {
    expect(coveragesOf(rate({ ...mi, package: "minimum" }))).toEqual(["BI", "PD", "PPI", "PIP"]);
    expect(coveragesOf(rate({ ...mi, package: "recommended" }))).toEqual(["BI", "PD", "PPI", "LPD", "PIP", "UM", "COMP", "COLL"]);
    expect(coveragesOf(rate({ ...mi, package: "premium" }))).toEqual(["BI", "PD", "PPI", "LPD", "PIP", "UM", "COMP", "COLL"]);
  });

  test("higher liability limits never lower the liability premium", () => {
    const liability = (id: PackageId) =>
      rate({ ...mi, package: id }).lines.filter((l) => ["BI", "PD", "PPI"].includes(l.coverage)).reduce((s, l) => s + l.premium, 0);
    expect(liability("recommended")).toBeGreaterThanOrEqual(liability("minimum"));
    expect(liability("premium")).toBeGreaterThanOrEqual(liability("recommended"));
  });

  test("version stamp, and the lawsuit note states the tort threshold (MCL 500.3135(1))", () => {
    expect(rate(mi).rateTableVersion).toBe("DEMO-MI-2026.10");
    expect(RATE_TABLE_VERSIONS.MI).toBe("DEMO-MI-2026.10");
    for (const threshold of ["death", "serious impairment of body function", "permanent serious disfigurement"]) {
      expect(STATE_CONFIGS.MI.lawsuitNote).toContain(threshold);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Age OR experience
// ---------------------------------------------------------------------------------------------

describe("driver age or driving experience, never both (MCL 500.2111(2)(a)(i))", () => {
  const newlyLicensed: RatingDriver = { ...adult, age: 30, yearsLicensed: 1 };
  const veteran: RatingDriver = { ...adult, age: 30, yearsLicensed: 10 };

  test("Michigan lines carry a driver-age factor and no driving-experience factor", () => {
    const r = rate(withDriver(mi, newlyLicensed));
    const driverLines = r.lines.filter((l) => ["BI", "PD", "PPI", "LPD", "PIP", "COLL"].includes(l.coverage));
    expect(driverLines.length).toBeGreaterThan(0);
    for (const l of driverLines) expect(l.factors.map((f) => f.name)).toContain("driver age");
    expect(factorNames(r)).not.toContain("driving experience");
  });

  test("New Jersey and Pennsylvania lines still carry driving experience alongside age", () => {
    for (const base of [nj, pa]) {
      const r = rate(withDriver(base, newlyLicensed));
      const driverLines = r.lines.filter((l) => ["BI", "PD", "PIP", "MED", "COLL"].includes(l.coverage));
      expect(driverLines.length).toBeGreaterThan(0);
      for (const l of driverLines) expect(l.factors.map((f) => f.name)).toEqual(expect.arrayContaining(["driver age", "driving experience"]));
    }
  });

  test("a 30-year-old licensed 1 year prices the same as one licensed 10 years in Michigan, but higher in NJ and PA", () => {
    const a = rate(withDriver(mi, newlyLicensed));
    const b = rate(withDriver(mi, veteran));
    expect(a.sixMonthPremium).toBe(b.sixMonthPremium);
    expect(a.lines.map((l) => l.premium)).toEqual(b.lines.map((l) => l.premium));
    for (const base of [nj, pa]) {
      expect(rate(withDriver(base, newlyLicensed)).sixMonthPremium).toBeGreaterThan(rate(withDriver(base, veteran)).sixMonthPremium);
    }
  });

  test("the price explanation never blames limited experience in Michigan, and does in New Jersey", () => {
    const names = (input: RatingInput) => rate(input).topFactors.map((f) => f.name);
    expect(names(withDriver(mi, newlyLicensed))).not.toContain("limited driving experience");
    expect(names(withDriver(nj, newlyLicensed))).toContain("limited driving experience");
  });

  test("driver ranking ignores experience in Michigan too, so experience cannot move a car's driver", () => {
    // A is 30 and licensed 1 year; B is 25 and licensed 10 years. With experience A outranks B (1.2 vs 1.12);
    // on age alone B (1.12) outranks A (1.0). The more valuable car is rated with the higher-risk driver.
    const a: RatingDriver = { ...adult, age: 30, yearsLicensed: 1 };
    const b: RatingDriver = { ...adult, age: 25, yearsLicensed: 10 };
    const dear: RatingVehicle = { ...sedan, modelYear: 2026, bodyClass: "suv", valueBand: "luxury" };
    const two = (base: RatingInput): RatingInput => ({ ...base, drivers: [a, b], vehicles: [economyCar, dear] });
    expect(assignDrivers(two(nj))[1]).toBe(a);
    expect(assignDrivers(two(mi))[1]).toBe(b);
  });

  test(`property: across ${HOUSEHOLDS} households, years licensed moves no Michigan price component but does move NJ and PA`, () => {
    const rng = seeded(20261015);
    let njMoved = 0;
    let paMoved = 0;
    for (let i = 0; i < HOUSEHOLDS; i++) {
      const h = household(rng);
      // Flip every driver across the three-year experience line.
      const flipped = { ...h, drivers: h.drivers.map((d) => ({ ...d, yearsLicensed: d.yearsLicensed < 3 ? 10 : 1 })) };
      expect(JSON.stringify(rate(inState(flipped, "MI")))).toBe(JSON.stringify(rate(inState(h, "MI"))));
      if (JSON.stringify(rate(inState(flipped, "NJ"))) !== JSON.stringify(rate(inState(h, "NJ")))) njMoved++;
      if (JSON.stringify(rate(inState(flipped, "PA"))) !== JSON.stringify(rate(inState(h, "PA")))) paMoved++;
    }
    // Power check: the harness really can see an experience effect where one exists.
    expect(njMoved).toBeGreaterThan(HOUSEHOLDS / 2);
    expect(paMoved).toBeGreaterThan(HOUSEHOLDS / 2);
  });
});

// ---------------------------------------------------------------------------------------------
// Senior reduction
// ---------------------------------------------------------------------------------------------

describe("reduced rates for drivers 65 and over who drive under 3,000 miles (MCL 500.2111(6))", () => {
  const SENIOR = "senior low-mileage discount";
  const driving = (age: number, annualMiles: number, base: RatingInput = mi): RatingInput => ({
    ...base,
    drivers: [{ ...adult, age }],
    vehicles: [{ ...sedan, annualMiles }],
  });
  const seniorFactors = (l: { factors: { name: string; value: number }[] }) => l.factors.filter((f) => f.name === SENIOR);

  test("the rule is configured as 65, 3,000 miles, 0.9", () => {
    expect(stateConfig("MI").seniorLowMileage).toEqual({ minAge: 65, maxMiles: 3000, factor: 0.9 });
  });

  test("a 70-year-old driving 2,500 miles gets a 0.9 factor on every line of that vehicle, in every package", () => {
    for (const id of PACKAGE_IDS) {
      const r = rate({ ...driving(70, 2500), package: id });
      expect(r.lines.length).toBeGreaterThan(0);
      for (const l of r.lines) expect(seniorFactors(l)).toEqual([{ name: SENIOR, value: 0.9 }]);
    }
  });

  test("the factor takes ten percent off each line, and nothing else changes", () => {
    const reduced = rate(driving(70, 2500));
    const full = rate(driving(70, 3000)); // same mileage band (under 7,500), no senior reduction
    expect(reduced.lines.length).toBe(full.lines.length);
    for (const l of reduced.lines) expect(l.premium).toBeCloseTo(lineOf(full, l.coverage).premium * 0.9, 1);
    expect(reduced.sixMonthPremium).toBeLessThan(full.sixMonthPremium);
  });

  test("exactly 3,000 miles is not under 3,000 miles, so it gets no reduction; 2,999 does", () => {
    expect(factorNames(rate(driving(70, 3000)))).not.toContain(SENIOR);
    expect(factorNames(rate(driving(70, 3001)))).not.toContain(SENIOR);
    expect(factorNames(rate(driving(70, 2999)))).toContain(SENIOR);
  });

  test("the price explanation can name the reduction, and only when it applies", () => {
    const names = (input: RatingInput) => rate(input).topFactors.map((f) => f.name);
    // A lone 70-year-old in the base territory: the reduction is among the biggest movers on the quote.
    expect(names(driving(70, 2500))).toContain(SENIOR);
    expect(names(driving(70, 3000))).not.toContain(SENIOR);
    expect(names(driving(64, 2500))).not.toContain(SENIOR);
    expect(names(driving(70, 2500, nj))).not.toContain(SENIOR);
  });

  test("age 64 gets none; age 65 does", () => {
    expect(factorNames(rate(driving(64, 2500)))).not.toContain(SENIOR);
    expect(factorNames(rate(driving(65, 2500)))).toContain(SENIOR);
  });

  test("a New Jersey or Pennsylvania 70-year-old gets none", () => {
    for (const base of [nj, pa]) expect(factorNames(rate(driving(70, 2500, base)))).not.toContain(SENIOR);
    expect(stateConfig("NJ").seniorLowMileage).toBeUndefined();
    expect(stateConfig("PA").seniorLowMileage).toBeUndefined();
  });

  test("the reduction follows the driver a car is rated with, not just the household", () => {
    // A 70-year-old and a 40-year-old, two cars both driven 2,500 miles. The 40-year-old is the higher-risk
    // driver (1.0 vs 0.98) and takes the more valuable car, so only the other car is rated with the senior.
    const parked = { ...sedan, annualMiles: 2500 };
    const luxury: RatingVehicle = { ...parked, modelYear: 2026, bodyClass: "suv", valueBand: "luxury" };
    const r = rate({ ...mi, drivers: [{ ...adult, age: 70 }, { ...adult, age: 40 }], vehicles: [parked, luxury] });
    for (const l of r.lines.filter((x) => x.vehicle === 1)) expect(seniorFactors(l)).toHaveLength(1);
    for (const l of r.lines.filter((x) => x.vehicle === 2)) expect(seniorFactors(l)).toHaveLength(0);
  });

  test(`property: across ${HOUSEHOLDS} households the reduction appears on a vehicle's lines exactly when its driver is 65+ and it is driven under 3,000 miles`, () => {
    const rng = seeded(65);
    let reductions = 0;
    for (let i = 0; i < HOUSEHOLDS; i++) {
      const h = household(rng);
      const input = inState(h, "MI");
      const assigned = assignDrivers(input);
      const r = rate(input);
      input.vehicles.forEach((v, vi) => {
        const expected = assigned[vi]!.age >= 65 && v.annualMiles < 3000;
        if (expected) reductions++;
        for (const l of r.lines.filter((x) => x.vehicle === vi + 1)) expect(seniorFactors(l).length).toBe(expected ? 1 : 0);
      });
      for (const state of ["NJ", "PA"] as const) expect(factorNames(rate(inState(h, state)))).not.toContain(SENIOR);
    }
    expect(reductions).toBeGreaterThan(5); // power check
  });
});

// ---------------------------------------------------------------------------------------------
// PIP medical election
// ---------------------------------------------------------------------------------------------

describe("PIP medical election (MCL 500.3107c, 500.3107d, 500.3109a)", () => {
  const FACTORS: Record<PipMedical, number> = { unlimited: 1, "500k": 0.86, "250k": 0.78, "250k_excluded": 0.3, "50k": 0.5, opt_out: 0.3 };
  const pipIn = (level?: PipMedical): RatingInput => (level ? { ...mi, pipMedical: level } : mi);

  test("every election has a configured factor, and the factors are as designed", () => {
    const table = stateConfig("MI").pipMedical;
    expect(Object.keys(table ?? {}).sort()).toEqual([...PIP_LEVELS].sort());
    for (const level of PIP_LEVELS) expect(table?.[level].factor).toBe(FACTORS[level]);
  });

  test("each election prices the PIP line at its factor relative to unlimited", () => {
    const unlimited = lineOf(rate(pipIn("unlimited")), "PIP");
    for (const level of PIP_LEVELS) {
      const l = lineOf(rate(pipIn(level)), "PIP");
      expect(l.premium / unlimited.premium).toBeCloseTo(FACTORS[level], 3);
      expect(l.factors.filter((f) => f.name.startsWith("PIP medical:")).map((f) => f.value)).toEqual([FACTORS[level]]);
    }
  });

  test("a more generous election never costs less: unlimited > 500k > 250k > 50k > opt-out, and opt-out equals the excluded household", () => {
    const pip = (level: PipMedical) => lineOf(rate(pipIn(level)), "PIP").premium;
    expect(pip("unlimited")).toBeGreaterThan(pip("500k"));
    expect(pip("500k")).toBeGreaterThan(pip("250k"));
    expect(pip("250k")).toBeGreaterThan(pip("50k"));
    expect(pip("50k")).toBeGreaterThan(pip("opt_out"));
    expect(pip("opt_out")).toBe(pip("250k_excluded"));
  });

  test("the election moves only the PIP line", () => {
    const unlimited = rate(pipIn("unlimited"));
    for (const level of PIP_LEVELS) {
      for (const l of rate(pipIn(level)).lines) {
        if (l.coverage !== "PIP") expect(l.premium).toBe(lineOf(unlimited, l.coverage).premium);
      }
    }
  });

  test("no effective selection means unlimited (MCL 500.3107c(4))", () => {
    expect(rate(pipIn())).toEqual(rate(pipIn("unlimited")));
    expect(factorNames(rate(pipIn()))).toContain("PIP medical: Unlimited");
  });

  test("New Jersey PIP and Pennsylvania first-party medical ignore pipMedical", () => {
    for (const base of [nj, pa]) {
      for (const level of PIP_LEVELS) expect(rate({ ...base, pipMedical: level })).toEqual(rate(base));
      expect(factorNames(rate({ ...base, pipMedical: "opt_out" })).some((n) => n.startsWith("PIP medical"))).toBe(false);
    }
  });

  test("the price explanation surfaces an opt-out as the biggest lever, and says nothing about PIP for unlimited", () => {
    expect(rate(pipIn("opt_out")).topFactors[0]).toEqual({ name: "your PIP medical choice", impact: 0.3, direction: "lowers" });
    expect(rate(pipIn("unlimited")).topFactors.map((f) => f.name)).not.toContain("your PIP medical choice");
  });

  test(`property: across ${HOUSEHOLDS} households the election scales the PIP line and leaves every other line alone`, () => {
    const rng = seeded(3107);
    for (let i = 0; i < HOUSEHOLDS; i++) {
      const h = household(rng);
      const base = rate(inState(h, "MI", "unlimited"));
      for (const level of PIP_LEVELS) {
        const r = rate(inState(h, "MI", level));
        expect(r.lines.length).toBe(base.lines.length);
        r.lines.forEach((l, k) => {
          const ref = base.lines[k]!;
          expect([l.vehicle, l.coverage]).toEqual([ref.vehicle, ref.coverage]);
          if (l.coverage === "PIP") expect(l.premium / ref.premium).toBeCloseTo(FACTORS[level], 3);
          else expect(l.premium).toBe(ref.premium);
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// MCCA
// ---------------------------------------------------------------------------------------------

describe("MCCA assessment: per car-year, half for a six-month term, never discounted (MCL 500.3104(7)(d), (20))", () => {
  const twoCars: RatingInput = { ...mi, vehicles: [sedan, economyCar] };
  const NON_UNLIMITED = ["500k", "250k", "50k", "250k_excluded", "opt_out"] as const;

  test("configured for policies effective 2026-07-01 through 2027-06-30: $84 with unlimited PIP, $19 otherwise", () => {
    expect(stateConfig("MI").mcca).toEqual({ unlimited: 84, other: 19, from: "2026-07-01", through: "2027-06-30" });
  });

  test("unlimited PIP, one vehicle: one assessment of $42 (half of $84)", () => {
    expect(rate(mi).assessments).toEqual([{ name: expect.stringContaining("Catastrophic Claims"), perVehicle: 42, vehicles: 1, amount: 42 }]);
    expect(rate({ ...mi, pipMedical: "unlimited" }).assessments).toEqual(rate(mi).assessments);
  });

  test("two vehicles: $42 each, $84 in all", () => {
    expect(rate(twoCars).assessments).toEqual([{ name: expect.any(String), perVehicle: 42, vehicles: 2, amount: 84 }]);
  });

  test("every other election pays $9.50 per vehicle for the term (half of $19)", () => {
    for (const level of NON_UNLIMITED) {
      expect(rate({ ...mi, pipMedical: level }).assessments).toEqual([{ name: expect.any(String), perVehicle: 9.5, vehicles: 1, amount: 9.5 }]);
      expect(rate({ ...twoCars, pipMedical: level }).assessments).toEqual([{ name: expect.any(String), perVehicle: 9.5, vehicles: 2, amount: 19 }]);
    }
  });

  test("the assessment scales with the number of vehicles", () => {
    for (let n = 1; n <= 4; n++) {
      const vehicles = Array.from({ length: n }, () => sedan);
      expect(rate({ ...mi, vehicles }).assessments[0]).toMatchObject({ vehicles: n, amount: 42 * n });
      expect(rate({ ...mi, vehicles, pipMedical: "opt_out" }).assessments[0]).toMatchObject({ vehicles: n, amount: 9.5 * n });
    }
  });

  test("six-month premium = rounded subtotal after the paid-in-full discount + $25 policy fee + assessment", () => {
    for (const payInFull of [false, true]) {
      for (const input of [mi, twoCars, { ...mi, pipMedical: "opt_out" as const }, { ...twoCars, pipMedical: "250k" as const }]) {
        const r = rate({ ...input, payInFull });
        expect(r.policyFee).toBe(25);
        expect(r.sixMonthPremium).toBe(Math.round(r.subtotal * (payInFull ? 0.92 : 1)) + 25 + assessedTotal(r));
      }
    }
  });

  test("paid-in-full discounts the premium but never the assessment", () => {
    for (const input of [mi, twoCars, { ...twoCars, pipMedical: "opt_out" as const }]) {
      const full = rate({ ...input, payInFull: true });
      const monthly = rate({ ...input, payInFull: false });
      expect(full.assessments).toEqual(monthly.assessments);
      expect(full.subtotal).toBe(monthly.subtotal);
      // The only thing paid-in-full changed is the rounded subtotal, so the gap carries no trace of the assessment.
      expect(monthly.sixMonthPremium - full.sixMonthPremium).toBe(Math.round(monthly.subtotal) - Math.round(monthly.subtotal * 0.92));
    }
  });

  test("the assessment is billed in the six-month premium but sits outside the rated subtotal", () => {
    const r = rate(twoCars);
    const lineSum = r.lines.reduce((s, l) => s + l.premium, 0);
    const discount = r.policyDiscounts.reduce((acc, f) => acc * f.value, 1);
    expect(r.subtotal).toBeCloseTo(lineSum * discount, 1);
    expect(r.sixMonthPremium).toBe(Math.round(r.subtotal) + 25 + 84);
  });

  test("the monthly plan spreads the assessment with the rest", () => {
    const r = rate(twoCars);
    expect(r.monthlyPayment).toBeCloseTo(r.sixMonthPremium / 6 + r.installmentFee, 2);
  });

  test("New Jersey and Pennsylvania carry no assessment", () => {
    for (const base of [nj, pa, { ...nj, vehicles: [sedan, economyCar] }, { ...pa, vehicles: [sedan, economyCar] }]) {
      for (const payInFull of [false, true]) {
        const r = rate({ ...base, payInFull });
        expect(r.assessments).toEqual([]);
        expect(r.sixMonthPremium).toBe(Math.round(r.subtotal * (payInFull ? 0.92 : 1)) + 25);
      }
    }
    expect(stateConfig("NJ").mcca).toBeUndefined();
    expect(stateConfig("PA").mcca).toBeUndefined();
  });

  test(`property: across ${HOUSEHOLDS} households the assessment is per car at the right rate and the premium identity holds`, () => {
    const rng = seeded(3104);
    for (let i = 0; i < HOUSEHOLDS; i++) {
      const h = household(rng);
      const level = pick(rng, [undefined, ...PIP_LEVELS] as const);
      const r = rate(inState(h, "MI", level));
      const perVehicle = !level || level === "unlimited" ? 42 : 9.5;
      expect(r.assessments).toEqual([{ name: expect.any(String), perVehicle, vehicles: h.vehicles.length, amount: perVehicle * h.vehicles.length }]);
      expect(r.sixMonthPremium).toBe(Math.round(r.subtotal * (h.payInFull ? 0.92 : 1)) + 25 + assessedTotal(r));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Merit rating
// ---------------------------------------------------------------------------------------------

describe("merit rating (MCL 500.2111(3))", () => {
  const asOf = new Date("2026-10-14T12:00:00Z");
  const noSelf: SelfReported = { tickets3y: 0, atFaultAccidents3y: 0, dui3y: false };
  const reports = (violations: Violation[] = [], claims: ClueClaim[] = []): DriverReports => ({
    mvr: { status: "VALID", violations, source: "vendor" },
    clue: { claims, source: "vendor" },
    prior: { carrier: null, continuousMonths: null, source: "vendor" },
  });
  const minor = (date: string, description = "speeding 12 over"): Violation => ({ date, kind: "minor", dui: false, description });
  const dui = (date: string): Violation => ({ date, kind: "major", dui: true, description: "driving while intoxicated" });
  const atFault = (date: string): ClueClaim => ({ date, type: "collision", atFault: true, amount: 6200 });

  // asOf is 2026-10-14. 2024-04-14 is 2.5 years back; 2025-10-14 is 1 year back.
  const TWO_AND_A_HALF_YEARS_AGO = "2024-04-14";
  const ONE_YEAR_AGO = "2025-10-14";

  describe("the window: a civil infraction counts only while the Secretary of State carries its points (2 years)", () => {
    test("Michigan merit rules are 2 years, from the record only; the default is 3 years with self-report", () => {
      expect(MI_MERIT).toEqual({ minorViolationYears: 2, minorFromRecordOnly: true });
      expect(DEFAULT_MERIT).toEqual({ minorViolationYears: 3, minorFromRecordOnly: false });
      expect(stateConfig("NJ").merit).toBeUndefined();
      expect(stateConfig("PA").merit).toBeUndefined();
    });

    test("a minor violation 2.5 years back is not counted; one 1 year back is", () => {
      expect(mergeRecord(noSelf, reports([minor(TWO_AND_A_HALF_YEARS_AGO)]), asOf, MI_MERIT).minorViolations3y).toBe(0);
      expect(mergeRecord(noSelf, reports([minor(ONE_YEAR_AGO)]), asOf, MI_MERIT).minorViolations3y).toBe(1);
      expect(mergeRecord(noSelf, reports([minor(ONE_YEAR_AGO), minor(TWO_AND_A_HALF_YEARS_AGO)]), asOf, MI_MERIT).minorViolations3y).toBe(1);
    });

    test("the line sits at two years: one day inside counts, one day outside does not", () => {
      expect(mergeRecord(noSelf, reports([minor("2024-10-15")]), asOf, MI_MERIT).minorViolations3y).toBe(1);
      expect(mergeRecord(noSelf, reports([minor("2024-10-13")]), asOf, MI_MERIT).minorViolations3y).toBe(0);
    });

    test("the default three-year rule still counts the 2.5-year-old violation, so the window is what changed", () => {
      expect(mergeRecord(noSelf, reports([minor(TWO_AND_A_HALF_YEARS_AGO)]), asOf, DEFAULT_MERIT).minorViolations3y).toBe(1);
      expect(mergeRecord(noSelf, reports([minor(TWO_AND_A_HALF_YEARS_AGO)]), asOf).minorViolations3y).toBe(1); // merit omitted = default
    });

    test("a self-reported ticket count can't be dated, so a clean record yields 0 under Michigan rules and 2 under the default", () => {
      const twoTickets = { ...noSelf, tickets3y: 2 };
      expect(mergeRecord(twoTickets, reports(), asOf, MI_MERIT).minorViolations3y).toBe(0);
      expect(mergeRecord(twoTickets, reports(), asOf, DEFAULT_MERIT).minorViolations3y).toBe(2);
      expect(mergeRecord(twoTickets, reports(), asOf).minorViolations3y).toBe(2);
    });

    test("Michigan rates the record, not the self-report, even when the self-report is larger", () => {
      const m = mergeRecord({ ...noSelf, tickets3y: 3 }, reports([minor(ONE_YEAR_AGO)]), asOf, MI_MERIT);
      expect(m.minorViolations3y).toBe(1);
    });

    test("a DUI 2.5 years back still counts under Michigan rules; the window narrows civil infractions only", () => {
      const m = mergeRecord(noSelf, reports([dui(TWO_AND_A_HALF_YEARS_AGO)]), asOf, MI_MERIT);
      expect(m.majorViolations3y).toBe(1);
      expect(m.dui3y).toBe(true);
      expect(m.minorViolations3y).toBe(0);
    });

    test("an at-fault accident 2.5 years back still counts too", () => {
      const m = mergeRecord(noSelf, reports([], [atFault(TWO_AND_A_HALF_YEARS_AGO)]), asOf, MI_MERIT);
      expect(m.atFaultAccidents3y).toBe(1);
    });

    test("a self-reported at-fault accident and DUI are still honored under Michigan rules", () => {
      const m = mergeRecord({ tickets3y: 0, atFaultAccidents3y: 2, dui3y: true }, reports(), asOf, MI_MERIT);
      expect(m).toMatchObject({ atFaultAccidents3y: 2, majorViolations3y: 1, dui3y: true });
    });

    test("end to end: a 2.5-year-old ticket leaves a Michigan quote untouched but surcharges the same record at the default window", () => {
      const driverFrom = (m: MergedRecord): RatingDriver => ({
        ...adult,
        minorViolations3y: m.minorViolations3y,
        majorViolations3y: m.majorViolations3y,
        atFaultAccidents3y: m.atFaultAccidents3y,
      });
      const old = reports([minor(TWO_AND_A_HALF_YEARS_AGO)]);
      const michigan = rate(withDriver(mi, driverFrom(mergeRecord(noSelf, old, asOf, MI_MERIT))));
      const atDefault = rate(withDriver(mi, driverFrom(mergeRecord(noSelf, old, asOf, DEFAULT_MERIT))));
      expect(michigan.points).toEqual([0]);
      expect(michigan.sixMonthPremium).toBe(rate(mi).sixMonthPremium);
      expect(atDefault.points).toEqual([2]);
      expect(atDefault.sixMonthPremium).toBeGreaterThan(michigan.sixMonthPremium);
    });

    // Known defect (reported with its fix): the discrepancy sentence is built from the 3-year list while its
    // count comes from the 2-year window, so it can read "1 ticket" and then list two. Flip to test() once fixed.
    test("the discrepancy sentence lists only the violations it counts", () => {
      const m = mergeRecord(noSelf, reports([minor(ONE_YEAR_AGO, "speeding 12 over"), minor(TWO_AND_A_HALF_YEARS_AGO, "improper passing")]), asOf, MI_MERIT);
      expect(m.minorViolations3y).toBe(1);
      expect(m.discrepancies).toHaveLength(1);
      expect(m.discrepancies[0]).toContain("1 ticket");
      expect(m.discrepancies[0]).toContain("speeding 12 over");
      expect(m.discrepancies[0]).not.toContain("improper passing");
    });
  });

  describe("coverage: surcharges apply to all coverages for automobile insurance, other than comprehensive", () => {
    const ticketed = (extra: Partial<RatingDriver>): RatingResult => rate(withDriver(mi, { ...adult, ...extra }));

    test("a civil infraction surcharges liability, property protection, mini-tort, PIP and collision, and leaves comprehensive alone", () => {
      const clean = rate(mi);
      const hit = ticketed({ minorViolations3y: 1 });
      for (const cov of ["BI", "PD", "PPI", "LPD", "PIP", "COLL"] as const) expect(lineOf(hit, cov).premium).toBeGreaterThan(lineOf(clean, cov).premium);
      expect(lineOf(hit, "COMP").premium).toBe(lineOf(clean, "COMP").premium);
    });

    test("a substantially at-fault accident does the same", () => {
      const clean = rate(mi);
      const hit = ticketed({ atFaultAccidents3y: 1 });
      for (const cov of ["BI", "PD", "PPI", "LPD", "PIP", "COLL"] as const) expect(lineOf(hit, cov).premium).toBeGreaterThan(lineOf(clean, cov).premium);
      expect(lineOf(hit, "COMP").premium).toBe(lineOf(clean, "COMP").premium);
    });

    // The statute: the merit plan "must provide for premium surcharges for all coverages for automobile
    // insurance, other than comprehensive coverage". Uninsured/underinsured motorist is one of those coverages.
    test("uninsured motorist is surcharged too (every coverage except comprehensive)", () => {
      const clean = rate(mi);
      for (const extra of [{ minorViolations3y: 1 }, { atFaultAccidents3y: 1 }, { majorViolations3y: 1 }]) {
        const hit = ticketed(extra);
        const notSurcharged = (["BI", "PD", "PPI", "LPD", "PIP", "UM", "COLL"] as const).filter((cov) => lineOf(hit, cov).premium <= lineOf(clean, cov).premium);
        expect(notSurcharged).toEqual([]);
      }
    });

    test("surcharges never fall as points rise, on every merit-rated line", () => {
      const lines = (minor: number, accidents: number) => ticketed({ minorViolations3y: minor, atFaultAccidents3y: accidents }).lines;
      for (let minor = 0; minor <= 4; minor++) {
        const lo = lines(minor, 0);
        for (const hi of [lines(minor + 1, 0), lines(minor, 1)]) {
          lo.forEach((l, k) => {
            if (l.coverage !== "COMP") expect(hi[k]!.premium).toBeGreaterThanOrEqual(l.premium);
          });
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Closed list of rating factors
// ---------------------------------------------------------------------------------------------

describe("only statutory rating factors appear on a Michigan quote (MCL 500.2111(2), (4), (9))", () => {
  const territoryLabels = Object.values(stateConfig("MI").territoryFactors).map((t) => t.label);

  // Each factor name, with the statutory basis that allows it. Adding a factor to Michigan pricing means
  // adding its basis here on purpose.
  const LINE_FACTORS: (string | RegExp)[] = [
    "limit", //                        (2)(a) amount of insurance
    "deductible", //                   (2)(a) amount of insurance
    ...territoryLabels, //             (5) risks may be grouped by territory
    "driver age", //                   (2)(a)(i) age OR driving experience
    "driving record", //               (3) merit rating
    "body type", //                    (2)(a) vehicle characteristics
    "vehicle usage", //                (2)(a) type of use
    "annual mileage", //               (2)(a) mileage
    "vehicle age", //                  (2)(c) repair or replacement cost
    "vehicle value", //                (2)(c) repair or replacement cost, make and model
    "anti-theft", //                   (2)(c) theft-prevention devices
    /^PIP medical: /, //              (2)(b) coordination of benefits (the caller's PIP election)
    "senior low-mileage discount", //  (6) seniors 65+ under 3,000 miles
  ];
  const POLICY_DISCOUNTS = [
    "multi-car discount", //           (2)(a) number of cars
    "safe driver discount", //         (3) merit rating plan, the no-points side
    "continuous insurance discount", //  (9) additional factor: prior insurance
    "no prior insurance", //           (9) additional factor: prior insurance
    "paid-in-full discount", //        (9) additional factor: paid in full
  ];
  const allowedLine = (name: string) => LINE_FACTORS.some((a) => (typeof a === "string" ? a === name : a.test(name)));

  // MCL 500.2111(4): sex, marital status, home ownership, educational level, occupation, postal zone, credit score.
  const PROHIBITED = /sex|gender|marital|married|home.?owner|owner|educat|occupation|credit|zip|postal/i;

  test("a representative Michigan quote uses only listed factors", () => {
    const r = rate({ ...mi, vehicles: [sedan, economyCar], drivers: [adult, { ...adult, age: 70 }], payInFull: true, pipMedical: "500k" });
    expect(factorNames(r).filter((n) => !allowedLine(n))).toEqual([]);
    expect(r.policyDiscounts.map((d) => d.name).filter((n) => !POLICY_DISCOUNTS.includes(n))).toEqual([]);
  });

  test(`property: across ${HOUSEHOLDS} households no unlisted or prohibited factor appears, and every line's trace reproduces its premium`, () => {
    const rng = seeded(2111);
    for (let i = 0; i < HOUSEHOLDS; i++) {
      const h = household(rng);
      const r = rate(inState(h, "MI", pick(rng, [undefined, ...PIP_LEVELS] as const)));
      expect(r.sixMonthPremium).toBeGreaterThan(0);
      expect(Number.isFinite(r.sixMonthPremium)).toBe(true);
      const names = [...factorNames(r), ...r.policyDiscounts.map((d) => d.name), ...r.topFactors.map((t) => t.name)];
      expect(names.filter((n) => PROHIBITED.test(n))).toEqual([]);
      expect(factorNames(r).filter((n) => !allowedLine(n))).toEqual([]);
      expect(r.policyDiscounts.map((d) => d.name).filter((n) => !POLICY_DISCOUNTS.includes(n))).toEqual([]);
      expect(r.topFactors.map((t) => t.name)).not.toContain("limited driving experience");
      expect(r.topFactors.map((t) => t.name)).not.toContain("limited tort option");
      for (const l of r.lines) {
        expect(l.base).toBe(stateConfig("MI").baseRates[l.coverage]!);
        expect(l.premium).toBe(round2(l.factors.reduce((acc, f) => acc * f.value, l.base)));
      }
    }
  });

  test("no factor in the Michigan rate table is named for a prohibited basis", () => {
    const cfg = stateConfig("MI");
    const tableNames = [...territoryLabels, ...Object.values(cfg.pipMedical ?? {}).map((p) => p.label), ...cfg.coverages.map((c) => c.name)];
    expect(tableNames.filter((n) => PROHIBITED.test(n))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// New Jersey and Pennsylvania are untouched
// ---------------------------------------------------------------------------------------------

describe("New Jersey and Pennsylvania pricing is unchanged by the Michigan work", () => {
  const teen: RatingDriver = { age: 17, yearsLicensed: 1, minorViolations3y: 0, majorViolations3y: 0, atFaultAccidents3y: 0 };

  // Inputs reused from test/rating.test.ts; the expected values are the committed golden snapshots,
  // recorded before the Michigan work began.
  const NJ_GOLDEN: [name: string, input: RatingInput, six: number, monthly: number | null][] = [
    ["clean adult, suburban", nj, 941, 161.83],
    ["young driver, urban", { ...nj, territory: 1, drivers: [{ ...adult, age: 19, yearsLicensed: 2 }] }, 2496, 421],
    ["points-heavy", { ...nj, drivers: [{ ...adult, minorViolations3y: 2, atFaultAccidents3y: 1 }] }, 1756, 297.67],
    [
      "multi-car household",
      {
        ...nj,
        drivers: [adult, { ...adult, age: 41, yearsLicensed: 23 }],
        vehicles: [sedan, { ...sedan, modelYear: 2016, bodyClass: "suv", valueBand: "economy", usage: "pleasure", annualMiles: 6000 }],
        payInFull: true,
      },
      1372,
      null,
    ],
    ["no prior insurance, state minimum", { ...nj, priorInsuranceMonths: 0, package: "minimum", territory: 2 }, 671, 116.83],
    ["high-value vehicle, premium package", { ...nj, vehicles: [{ ...sedan, modelYear: 2026, bodyClass: "suv", valueBand: "luxury", antiTheft: true }], package: "premium" }, 1302, 222],
    [
      "teen added to household",
      { ...nj, drivers: [adult, teen], vehicles: [sedan, { ...sedan, modelYear: 2012, valueBand: "economy", annualMiles: 5000, usage: "pleasure" }] },
      2611,
      440.17,
    ],
  ];

  // Inputs reused from test/pa.test.ts.
  const PA_GOLDEN: [name: string, input: RatingInput, six: number][] = [
    ["Bucks County adult, full tort", pa, 593],
    ["Bucks County adult, limited tort", { ...pa, tortOption: "limited" }, 558],
    ["Philadelphia adult, full tort", { ...pa, territory: 1 }, 916],
    ["Pittsburgh young driver, limited tort", { ...pa, territory: 2, tortOption: "limited", drivers: [{ ...adult, age: 20, yearsLicensed: 3 }] }, 1199],
    ["PA minimum, limited tort, no prior", { ...pa, package: "minimum", tortOption: "limited", priorInsuranceMonths: 0 }, 271],
    ["two cars, stacked UM/UIM", { ...pa, vehicles: [sedan, { ...sedan, modelYear: 2015, valueBand: "economy" }] }, 960],
  ];

  for (const [name, input, six, monthly] of NJ_GOLDEN) {
    test(`NJ golden: ${name}`, () => {
      const r = rate(input);
      expect(r.sixMonthPremium).toBe(six);
      expect(r.monthlyPayment).toBe(monthly);
      expect(r.assessments).toEqual([]);
      expect(r.rateTableVersion).toBe("DEMO-NJ-2026.10");
    });
  }
  for (const [name, input, six] of PA_GOLDEN) {
    test(`PA golden: ${name}`, () => {
      const r = rate(input);
      expect(r.sixMonthPremium).toBe(six);
      expect(r.assessments).toEqual([]);
      expect(r.rateTableVersion).toBe("DEMO-PA-2026.10");
    });
  }

  test("Michigan-only rules are absent from the NJ and PA rate tables", () => {
    for (const state of ["NJ", "PA"] as const) {
      const cfg = stateConfig(state);
      expect(cfg.municipalityRating).toBeUndefined();
      expect(cfg.experienceFactor).toBeUndefined();
      expect(cfg.seniorLowMileage).toBeUndefined();
      expect(cfg.merit).toBeUndefined();
      expect(cfg.pipMedical).toBeUndefined();
      expect(cfg.mcca).toBeUndefined();
      expect(Object.keys(cfg.zip3Territory).length).toBeGreaterThan(0);
    }
  });

  test("New Jersey and Pennsylvania package limits are unchanged (N.J.S.A. 39:6A-3; 75 Pa.C.S. §§ 1702, 1711)", () => {
    expect(stateConfig("NJ").packages.minimum.limits).toMatchObject({ BI: "35/70", PD: "25", PIP: "15,000" });
    expect(stateConfig("PA").packages.minimum.limits).toMatchObject({ BI: "15/30", PD: "5", MED: "5,000" });
  });

  test("NJ and PA still price their own coverages: PIP in NJ, first-party medical in PA, neither has PPI or mini-tort", () => {
    expect(coveragesOf(rate(nj))).toEqual(["BI", "PD", "PIP", "UM", "COMP", "COLL"]);
    expect(coveragesOf(rate(pa))).toEqual(["BI", "PD", "MED", "UM", "COMP", "COLL"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------------------------

describe("Michigan rating is pure", () => {
  test("deterministic across 100 runs", () => {
    const input: RatingInput = { ...mi, vehicles: [sedan, economyCar], drivers: [adult, { ...adult, age: 70 }], pipMedical: "250k" };
    const first = JSON.stringify(rate(input));
    for (let i = 0; i < 100; i++) expect(JSON.stringify(rate(input))).toBe(first);
  });

  test("does not mutate its input", () => {
    const input = deepFreeze<RatingInput>({
      ...mi,
      drivers: [{ ...adult }, { ...adult, age: 70 }],
      vehicles: [{ ...sedan, annualMiles: 2500 }, { ...economyCar }],
      pipMedical: "opt_out",
    });
    expect(() => rate(input)).not.toThrow();
  });
});
