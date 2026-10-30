import {
  BODY_LIABILITY_FACTORS,
  DISCOUNTS,
  INSTALLMENT_FEE_PER_MONTH,
  POINTS,
  POLICY_FEE,
  USAGE_FACTORS,
  VALUE_BAND_FACTORS,
  ageFactor,
  inexperienceFactor,
  mileageFactor,
  pointsFactor,
  stateConfig,
  vehicleAgeFactor,
  type StateConfig,
} from "./rateTable";
import type { Assessment, Coverage, CoverageLine, Factor, RatingDriver, RatingInput, RatingResult, RatingVehicle, TopFactor } from "./types";

const round2 = (n: number) => Math.round(n * 100) / 100;

export function driverPoints(d: RatingDriver): number {
  return d.minorViolations3y * POINTS.minor + d.majorViolations3y * POINTS.major + d.atFaultAccidents3y * POINTS.atFault;
}

/** MI rates on driver age OR experience, not both (MCL 500.2111(2)(a)(i)); elsewhere both apply. */
function experience(cfg: StateConfig, d: RatingDriver): number {
  return cfg.experienceFactor === false ? 1 : inexperienceFactor(d.age, d.yearsLicensed);
}

/** Ranks drivers for vehicle assignment using only the factors the state allows. */
function driverRisk(cfg: StateConfig, d: RatingDriver): number {
  return ageFactor(d.age) * experience(cfg, d) * pointsFactor(driverPoints(d));
}

function vehicleValue(v: RatingVehicle, effectiveYear: number): number {
  return VALUE_BAND_FACTORS[v.valueBand] * vehicleAgeFactor(effectiveYear - v.modelYear);
}

/**
 * Carrier-standard assignment: highest-risk driver rates on the highest-value vehicle.
 * Returns, for each vehicle index (original order), the driver it is rated with.
 */
export function assignDrivers(input: RatingInput): RatingDriver[] {
  const cfg = stateConfig(input.state);
  const drivers = [...input.drivers].sort((a, b) => driverRisk(cfg, b) - driverRisk(cfg, a));
  const vehicleOrder = input.vehicles
    .map((v, i) => ({ i, value: vehicleValue(v, input.effectiveYear) }))
    .sort((a, b) => b.value - a.value || a.i - b.i);
  const assigned: RatingDriver[] = new Array(input.vehicles.length);
  vehicleOrder.forEach(({ i }, rank) => {
    assigned[i] = drivers[Math.min(rank, drivers.length - 1)]!;
  });
  return assigned;
}

function line(cfg: StateConfig, vehicle: number, coverage: Coverage, factors: Factor[]): CoverageLine {
  const base = cfg.baseRates[coverage]!;
  const premium = round2(factors.reduce((acc, f) => acc * f.value, base));
  return { vehicle, coverage, base, factors, premium };
}

export function rate(input: RatingInput): RatingResult {
  if (input.drivers.length === 0) throw new Error("rate: at least one driver required");
  if (input.vehicles.length === 0) throw new Error("rate: at least one vehicle required");

  const cfg = stateConfig(input.state);
  const pkg = cfg.packages[input.package];
  const terr = cfg.territoryFactors[input.territory];
  const assigned = assignDrivers(input);
  const lines: CoverageLine[] = [];
  // PA tort election: no election is presumed full tort (75 Pa.C.S. § 1705(a)(3)).
  const tort = cfg.tort ? cfg.tort[input.tortOption ?? "full"] : null;
  const tortFactor = (cov: Coverage): Factor[] => (tort && tort[cov] !== undefined ? [{ name: `${input.tortOption ?? "full"} tort`, value: tort[cov]! }] : []);
  const stacking: Factor[] =
    cfg.umStackingFactor && (input.umStacked ?? true) && input.vehicles.length >= 2 ? [{ name: "UM/UIM stacking", value: cfg.umStackingFactor }] : [];
  // MI PIP medical election; no election is unlimited (MCL 500.3107c(4)).
  const pipLevel = input.pipMedical ?? "unlimited";
  const pip: Factor[] = cfg.pipMedical ? [{ name: `PIP medical: ${cfg.pipMedical[pipLevel].label}`, value: cfg.pipMedical[pipLevel].factor }] : [];

  input.vehicles.forEach((v, vi) => {
    const d = assigned[vi]!;
    const pts = driverPoints(d);
    const driverFactors: Factor[] = [
      { name: "driver age", value: ageFactor(d.age) },
      ...(cfg.experienceFactor === false ? [] : [{ name: "driving experience", value: experience(cfg, d) }]),
      { name: "driving record", value: pointsFactor(pts) },
    ];
    const useFactors: Factor[] = [
      { name: "vehicle usage", value: USAGE_FACTORS[v.usage] },
      { name: "annual mileage", value: mileageFactor(v.annualMiles) },
    ];
    // MI: reduced rates for drivers 65+ who drive under 3,000 miles a year, on every coverage (MCL 500.2111(6)).
    const senior = cfg.seniorLowMileage;
    const seniorDiscount: Factor[] =
      senior && d.age >= senior.minAge && v.annualMiles < senior.maxMiles ? [{ name: "senior low-mileage discount", value: senior.factor }] : [];
    // MI: merit surcharges apply to every coverage except comprehensive, uninsured motorist included (MCL 500.2111(3)).
    // Gated on the state's merit rules so NJ and PA pricing is untouched.
    const umMerit: Factor[] = cfg.merit ? [{ name: "driving record", value: pointsFactor(pts) }] : [];
    const vehAge = input.effectiveYear - v.modelYear;

    for (const { code, kind } of cfg.coverages) {
      const ilf = pkg.ilf[code];
      if (ilf === null || ilf === undefined) continue; // coverage not in this package
      const territory: Factor = { name: terr.label, value: kind === "comp" || kind === "coll" ? terr.physical : terr.liability };
      switch (kind) {
        case "liability":
          lines.push(line(cfg, vi + 1, code, [{ name: "limit", value: ilf }, territory, ...driverFactors, { name: "body type", value: BODY_LIABILITY_FACTORS[v.bodyClass] }, ...useFactors, ...tortFactor(code), ...seniorDiscount]));
          break;
        case "first_party":
          lines.push(line(cfg, vi + 1, code, [{ name: "limit", value: ilf }, territory, ...driverFactors, ...useFactors, ...(code === "PIP" ? pip : []), ...seniorDiscount]));
          break;
        case "um":
          lines.push(line(cfg, vi + 1, code, [{ name: "limit", value: ilf }, territory, ...tortFactor(code), ...stacking, ...umMerit, ...seniorDiscount]));
          break;
        case "comp":
          lines.push(
            line(cfg, vi + 1, code, [
              { name: "deductible", value: ilf },
              territory,
              { name: "vehicle age", value: vehicleAgeFactor(vehAge) },
              { name: "vehicle value", value: VALUE_BAND_FACTORS[v.valueBand] },
              { name: "anti-theft", value: v.antiTheft ? DISCOUNTS.antiTheftComp : 1 },
              ...seniorDiscount,
            ]),
          );
          break;
        case "coll":
          lines.push(
            line(cfg, vi + 1, code, [
              { name: "deductible", value: ilf },
              territory,
              { name: "vehicle age", value: vehicleAgeFactor(vehAge) },
              { name: "vehicle value", value: VALUE_BAND_FACTORS[v.valueBand] },
              ...driverFactors,
              ...useFactors,
              ...seniorDiscount,
            ]),
          );
          break;
      }
    }
  });

  const points = input.drivers.map(driverPoints);
  const policyDiscounts: Factor[] = [];
  if (input.vehicles.length >= 2) policyDiscounts.push({ name: "multi-car discount", value: DISCOUNTS.multiCar });
  if (points.every((p) => p === 0)) policyDiscounts.push({ name: "safe driver discount", value: DISCOUNTS.safeDriver });
  if (input.priorInsuranceMonths >= 6) policyDiscounts.push({ name: "continuous insurance discount", value: DISCOUNTS.continuousPrior });
  else if (input.priorInsuranceMonths === 0) policyDiscounts.push({ name: "no prior insurance", value: DISCOUNTS.noPriorSurcharge });

  const lineSum = lines.reduce((s, l) => s + l.premium, 0);
  const subtotal = round2(policyDiscounts.reduce((acc, f) => acc * f.value, lineSum));
  // MCCA: charged per car-year (MCL 500.3104(7)(d)) and passed through at the car's share (3104(20)), so a
  // six-month term carries half. Never discounted.
  const assessments: Assessment[] = [];
  if (cfg.mcca) {
    const perVehicle = round2((pipLevel === "unlimited" ? cfg.mcca.unlimited : cfg.mcca.other) / 2);
    assessments.push({ name: "Michigan Catastrophic Claims Association assessment", perVehicle, vehicles: input.vehicles.length, amount: round2(perVehicle * input.vehicles.length) });
  }
  const assessed = assessments.reduce((s, a) => s + a.amount, 0);
  const sixMonthPremium = round2(Math.round(subtotal * (input.payInFull ? DISCOUNTS.payInFull : 1)) + POLICY_FEE + assessed);
  const installmentFee = input.payInFull ? 0 : INSTALLMENT_FEE_PER_MONTH;
  const monthlyPayment = input.payInFull ? null : round2(sixMonthPremium / 6 + installmentFee);

  return {
    rateTableVersion: cfg.rateTableVersion,
    lines,
    policyDiscounts: input.payInFull ? [...policyDiscounts, { name: "paid-in-full discount", value: DISCOUNTS.payInFull }] : policyDiscounts,
    subtotal,
    policyFee: POLICY_FEE,
    assessments,
    sixMonthPremium,
    installmentFee,
    monthlyPayment,
    points,
    topFactors: topFactors(input, assigned),
  };
}

/**
 * The senior low-mileage discount applies per car, so its household impact is weighted by the share of cars that
 * qualify: 1 - (1 - factor) * qualifying / vehicles. Counting the full factor when one car of two qualified let it
 * outrank a factor that really moved the price more (review 2026-10-16).
 */
function seniorImpactFor(input: RatingInput, assigned: RatingDriver[]): number {
  const senior = stateConfig(input.state).seniorLowMileage;
  if (!senior || !input.vehicles.length) return 1;
  const qualifying = input.vehicles.filter((v, vi) => assigned[vi]!.age >= senior.minAge && v.annualMiles < senior.maxMiles).length;
  return 1 - (1 - senior.factor) * (qualifying / input.vehicles.length);
}
export const seniorDiscountImpact = (input: RatingInput): number => seniorImpactFor(input, assignDrivers(input));

/** The 3 household-level factors that moved the price most, for a one-line spoken explanation. */
function topFactors(input: RatingInput, assigned: RatingDriver[]): TopFactor[] {
  const cfg = stateConfig(input.state);
  const terr = cfg.territoryFactors[input.territory];
  const worst = assigned.reduce((a, b) => (driverRisk(cfg, b) > driverRisk(cfg, a) ? b : a));
  const candidates: { name: string; impact: number }[] = [
    { name: terr.label, impact: terr.liability },
    { name: worst.age < 25 ? "young driver" : worst.age >= 75 ? "senior driver" : "driver age", impact: ageFactor(worst.age) },
    { name: "limited driving experience", impact: experience(cfg, worst) },
    { name: "tickets or accidents on record", impact: pointsFactor(driverPoints(worst)) },
    { name: "multi-car discount", impact: input.vehicles.length >= 2 ? DISCOUNTS.multiCar : 1 },
    { name: "safe driver discount", impact: input.drivers.every((d) => driverPoints(d) === 0) ? DISCOUNTS.safeDriver : 1 },
    {
      name: input.priorInsuranceMonths === 0 ? "no prior insurance" : "continuous insurance discount",
      impact: input.priorInsuranceMonths === 0 ? DISCOUNTS.noPriorSurcharge : input.priorInsuranceMonths >= 6 ? DISCOUNTS.continuousPrior : 1,
    },
    { name: "paid-in-full discount", impact: input.payInFull ? DISCOUNTS.payInFull : 1 },
    { name: "limited tort option", impact: cfg.tort && input.tortOption === "limited" ? (cfg.tort.limited.BI ?? 1) : 1 },
    { name: "your PIP medical choice", impact: cfg.pipMedical ? cfg.pipMedical[input.pipMedical ?? "unlimited"].factor : 1 },
    { name: "senior low-mileage discount", impact: seniorImpactFor(input, assigned) },
  ];
  return candidates
    .filter((c) => Math.abs(Math.log(c.impact)) > 1e-9)
    .sort((a, b) => Math.abs(Math.log(b.impact)) - Math.abs(Math.log(a.impact)) || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((c) => ({ name: c.name, impact: c.impact, direction: c.impact > 1 ? "raises" : "lowers" }));
}
