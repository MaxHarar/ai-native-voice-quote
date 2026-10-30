// Rating inputs are deliberately driving-record-first. There is no credit,
// occupation, education, income, or gender field — and there must never be.

export type State = "NJ" | "PA" | "MI";
export type Territory = 1 | 2 | 3 | 4 | 5;
/** Pennsylvania tort election (75 Pa.C.S. § 1705). No election is presumed full tort. */
export type TortOption = "limited" | "full";
export type PackageId = "minimum" | "recommended" | "premium";
export type Usage = "pleasure" | "commute" | "business";
export type BodyClass = "sedan" | "suv" | "truck" | "van" | "sports" | "other";
export type ValueBand = "economy" | "standard" | "premium" | "luxury";
/**
 * PIP = personal injury protection (NJ, MI); MED = PA first-party medical benefits;
 * PPI = MI property protection insurance; LPD = MI limited property damage ("mini-tort").
 */
export type Coverage = "BI" | "PD" | "PIP" | "MED" | "PPI" | "LPD" | "UM" | "COMP" | "COLL";
/**
 * Michigan PIP medical (allowable expense) election. No effective selection means unlimited (MCL 500.3107c(4)).
 * - unlimited / 500k / 250k: open to anyone (3107c(1)(b)-(d)).
 * - 250k_excluded: $250,000 with every household member excluded because each has qualified health coverage;
 *   the PIP medical premium is reduced 100% (3109a(2)(a)).
 * - 50k: the applicant is enrolled in Medicaid and the household is otherwise covered (3107c(1)(a)).
 * - opt_out: the applicant has Medicare Parts A and B, and the household has qualified health coverage or other PIP (3107d).
 */
export type PipMedical = "unlimited" | "500k" | "250k" | "250k_excluded" | "50k" | "opt_out";

export interface RatingDriver {
  age: number;
  yearsLicensed: number;
  minorViolations3y: number;
  majorViolations3y: number;
  atFaultAccidents3y: number;
}

export interface RatingVehicle {
  modelYear: number;
  bodyClass: BodyClass;
  valueBand: ValueBand;
  usage: Usage;
  annualMiles: number;
  antiTheft: boolean;
}

export interface RatingInput {
  state: State;
  territory: Territory;
  drivers: RatingDriver[];
  vehicles: RatingVehicle[];
  package: PackageId;
  priorInsuranceMonths: number;
  payInFull: boolean;
  /** PA only; ignored for NJ (whose standard policy defaults to limitation on lawsuit). */
  tortOption?: TortOption;
  /** PA only: UM/UIM stacking across vehicles. Stacked is the PA default absent a signed waiver (§ 1738). */
  umStacked?: boolean;
  /** MI only: PIP medical limit. Absent means unlimited, the statutory default (MCL 500.3107c(4)). */
  pipMedical?: PipMedical;
  /** Policy effective year, used for vehicle age. Passed in so rating stays pure. */
  effectiveYear: number;
}

export interface Factor {
  name: string;
  value: number;
}

export interface CoverageLine {
  vehicle: number;
  coverage: Coverage;
  base: number;
  factors: Factor[];
  premium: number;
}

export interface TopFactor {
  name: string;
  /** Multiplier relative to a neutral 1.00; >1 raises price. */
  impact: number;
  direction: "raises" | "lowers";
}

/** A pass-through charge billed with the premium but never discounted (e.g. the MI catastrophic claims assessment). */
export interface Assessment {
  name: string;
  perVehicle: number;
  vehicles: number;
  amount: number;
}

export interface RatingResult {
  rateTableVersion: string;
  lines: CoverageLine[];
  policyDiscounts: Factor[];
  subtotal: number;
  policyFee: number;
  /** Empty outside Michigan. Included in sixMonthPremium. */
  assessments: Assessment[];
  sixMonthPremium: number;
  installmentFee: number;
  monthlyPayment: number | null;
  points: number[];
  topFactors: TopFactor[];
}
