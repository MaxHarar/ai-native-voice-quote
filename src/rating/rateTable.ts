import type { BodyClass, Coverage, PackageId, PipMedical, State, Territory, TortOption, Usage, ValueBand } from "./types";

// SYNTHETIC DEMO RATES. Structurally modeled on ISO-style NJ, PA and MI personal auto
// algorithms; the numbers are plausible, not any carrier's filed rates. The statutory
// facts (limits, defaults, fees, allowed factors) are real and cited in docs/STATUTES.md.

export interface TerritoryFactor {
  liability: number;
  physical: number;
  label: string;
}

export interface PackageSpec {
  label: string;
  spoken: string;
  limits: Partial<Record<Coverage, string | null>>;
  ilf: Partial<Record<Coverage, number | null>>; // null = coverage not included
  /** Said once when this package is chosen (e.g. a limit that needs a signed state form). */
  note?: string;
}

/** How long violations count, and whether an undatable self-report can be rated. */
export interface MeritRules {
  /** Years a minor violation (a civil infraction) counts toward the surcharge. */
  minorViolationYears: number;
  /** Rate minor violations only from dated record entries. A caller's "N tickets in 3 years" can't be dated. */
  minorFromRecordOnly: boolean;
}
export const DEFAULT_MERIT: MeritRules = { minorViolationYears: 3, minorFromRecordOnly: false };

/** How a coverage line is rated. Same mechanics in every state; the numbers live in the config. */
export type CoverageKind = "liability" | "first_party" | "um" | "comp" | "coll";

export interface StateConfig {
  state: State;
  name: string;
  rateTableVersion: string;
  /** Rating order of coverages on each vehicle, with how each is rated. */
  coverages: { code: Coverage; kind: CoverageKind; name: string }[];
  /** Six-month base premium per vehicle, at "recommended" limits, territory 4, adult clean driver. */
  baseRates: Partial<Record<Coverage, number>>;
  zip3Territory: Record<string, Territory>;
  territoryFactors: Record<Territory, TerritoryFactor>;
  packages: Record<PackageId, PackageSpec>;
  /** PA tort election factors by coverage (absent for NJ). */
  tort?: Record<TortOption, Partial<Record<Coverage, number>>>;
  /** PA: UM/UIM multiplier when stacked across 2+ vehicles (absent for NJ). */
  umStackingFactor?: number;
  /** MI: municipalities group into territories; the ZIP only decides the state (MCL 500.2111(4)(f) bars rating by postal zone). */
  municipalityRating?: { zip3Range: [string, string]; territories: Record<string, Territory>; fallback: Territory };
  /** Default true. MI rates on driver age OR experience, not both (MCL 500.2111(2)(a)(i)). */
  experienceFactor?: boolean;
  /** MI: reduced rates for drivers 65+ who drive under 3,000 miles a year (MCL 500.2111(6)). */
  seniorLowMileage?: { minAge: number; maxMiles: number; factor: number };
  merit?: MeritRules;
  /** MI PIP medical choice (MCL 500.3107c, 3107d, 3109a). */
  pipMedical?: Record<PipMedical, { factor: number; label: string; spoken: string }>;
  /** MI catastrophic claims assessment, dollars per car-year, and the period those amounts cover. */
  mcca?: { unlimited: number; other: number; from: string; through: string };
  /** MI: the highest annual per-person deductible that still counts as qualified health coverage (MCL 500.3107d(7)(b)(i), indexed each July 1). */
  qhcMaxDeductible?: number;
  /** One sentence the agent reads to describe the three packages. */
  packagesSentence: string;
  /** Summary-page label for the lawsuit option in states without a tort election (empty when the quote carries one). */
  lawsuitNote: string;
}

const NJ: StateConfig = {
  state: "NJ",
  name: "New Jersey",
  rateTableVersion: "DEMO-NJ-2026.10",
  coverages: [
    { code: "BI", kind: "liability", name: "Bodily injury liability" },
    { code: "PD", kind: "liability", name: "Property damage liability" },
    { code: "PIP", kind: "first_party", name: "Personal injury protection" },
    { code: "UM", kind: "um", name: "Uninsured / underinsured motorist" },
    { code: "COMP", kind: "comp", name: "Comprehensive" },
    { code: "COLL", kind: "coll", name: "Collision" },
  ],
  baseRates: { BI: 248, PD: 118, PIP: 262, UM: 46, COMP: 72, COLL: 214 },
  /** ZIP3 → territory for NJ (070–089). 1 = dense urban, 5 = rural. */
  zip3Territory: {
    "070": 1, "071": 1, "072": 1, "073": 1,
    "074": 2, "075": 2, "076": 2,
    "077": 3, "078": 4, "079": 3,
    "080": 2, "081": 1, "082": 4, "083": 5, "084": 2,
    "085": 3, "086": 2, "087": 3, "088": 2, "089": 2,
  },
  territoryFactors: {
    1: { liability: 1.55, physical: 1.35, label: "urban territory" },
    2: { liability: 1.28, physical: 1.18, label: "metro territory" },
    3: { liability: 1.1, physical: 1.05, label: "suburban territory" },
    4: { liability: 1.0, physical: 1.0, label: "standard territory" },
    5: { liability: 0.88, physical: 0.92, label: "rural territory" },
  },
  // NJ minimum BI rose to 35/70 for 2026 policies.
  packages: {
    minimum: {
      label: "State Minimum",
      spoken: "state minimum: 35/70 liability, $15,000 PIP, no physical damage coverage",
      limits: { BI: "35/70", PD: "25", PIP: "15,000", UM: "35/70", COMP: null, COLL: null },
      ilf: { BI: 0.8, PD: 0.92, PIP: 0.55, UM: 0.8, COMP: null, COLL: null },
    },
    recommended: {
      label: "Recommended",
      spoken: "recommended: 100/300 liability, $250,000 PIP, $500 comprehensive and collision deductibles",
      limits: { BI: "100/300", PD: "100", PIP: "250,000", UM: "100/300", COMP: "$500 ded", COLL: "$500 ded" },
      ilf: { BI: 1.0, PD: 1.0, PIP: 1.0, UM: 1.0, COMP: 1.0, COLL: 1.0 },
    },
    premium: {
      label: "Premium",
      spoken: "premium: 250/500 liability, $250,000 PIP, $250 deductibles",
      limits: { BI: "250/500", PD: "250", PIP: "250,000", UM: "250/500", COMP: "$250 ded", COLL: "$250 ded" },
      ilf: { BI: 1.22, PD: 1.06, PIP: 1.0, UM: 1.22, COMP: 1.15, COLL: 1.15 },
    },
  },
  packagesSentence:
    "We have three packages: state minimum; recommended, with 100/300 liability and 500-dollar deductibles; or premium, with higher limits and 250-dollar deductibles.",
  lawsuitNote: "Limitation on lawsuit (NJ standard default)",
};

const PA: StateConfig = {
  state: "PA",
  name: "Pennsylvania",
  rateTableVersion: "DEMO-PA-2026.10",
  coverages: [
    { code: "BI", kind: "liability", name: "Bodily injury liability" },
    { code: "PD", kind: "liability", name: "Property damage liability" },
    { code: "MED", kind: "first_party", name: "First party medical benefits" },
    { code: "UM", kind: "um", name: "Uninsured / underinsured motorist" },
    { code: "COMP", kind: "comp", name: "Comprehensive" },
    { code: "COLL", kind: "coll", name: "Collision" },
  ],
  baseRates: { BI: 165, PD: 95, MED: 48, UM: 38, COMP: 64, COLL: 188 },
  /** ZIP3 → territory for PA (150–196). Philadelphia is the highest-cost territory. */
  zip3Territory: {
    "150": 4, "151": 4, "152": 2, "153": 4, "154": 4, "155": 5, "156": 4, "157": 5, "158": 5, "159": 5,
    "160": 5, "161": 5, "162": 5, "163": 5, "164": 5, "165": 4, "166": 5, "167": 5, "168": 5, "169": 5,
    "170": 4, "171": 4, "172": 5, "173": 4, "174": 4, "175": 4, "176": 4, "177": 5, "178": 5, "179": 5,
    "180": 3, "181": 3, "182": 5, "183": 5, "184": 4, "185": 4, "186": 4, "187": 4, "188": 5, "189": 3,
    "190": 3, "191": 1, "192": 1, "193": 3, "194": 3, "195": 3, "196": 3,
  },
  territoryFactors: {
    1: { liability: 1.85, physical: 1.45, label: "Philadelphia territory" },
    2: { liability: 1.3, physical: 1.15, label: "metro territory" },
    3: { liability: 1.08, physical: 1.05, label: "suburban territory" },
    4: { liability: 1.0, physical: 1.0, label: "standard territory" },
    5: { liability: 0.85, physical: 0.9, label: "rural territory" },
  },
  // PA minimums: 15/30 BI, $5,000 PD, $5,000 first-party medical (75 Pa.C.S. §§ 1702, 1711).
  packages: {
    minimum: {
      label: "State Minimum",
      spoken: "state minimum: 15/30 liability, $5,000 property damage, $5,000 medical benefits, no physical damage coverage",
      limits: { BI: "15/30", PD: "5", MED: "5,000", UM: "15/30", COMP: null, COLL: null },
      ilf: { BI: 0.7, PD: 0.8, MED: 0.6, UM: 0.7, COMP: null, COLL: null },
    },
    recommended: {
      label: "Recommended",
      spoken: "recommended: 100/300 liability, $25,000 medical benefits, $500 comprehensive and collision deductibles",
      limits: { BI: "100/300", PD: "100", MED: "25,000", UM: "100/300", COMP: "$500 ded", COLL: "$500 ded" },
      ilf: { BI: 1.0, PD: 1.0, MED: 1.0, UM: 1.0, COMP: 1.0, COLL: 1.0 },
    },
    premium: {
      label: "Premium",
      spoken: "premium: 250/500 liability, $100,000 medical benefits, $250 deductibles",
      limits: { BI: "250/500", PD: "250", MED: "100,000", UM: "250/500", COMP: "$250 ded", COLL: "$250 ded" },
      ilf: { BI: 1.2, PD: 1.05, MED: 1.35, UM: 1.2, COMP: 1.15, COLL: 1.15 },
    },
  },
  // Limited tort waives non-economic recovery absent serious injury, so it prices lower on BI and UM/UIM.
  tort: { limited: { BI: 0.8, UM: 0.85 }, full: { BI: 1.0, UM: 1.0 } },
  umStackingFactor: 1.3,
  packagesSentence:
    "We have three packages: state minimum, which is 15/30 liability with 5,000 dollars of medical benefits; recommended, with 100/300 liability, 25,000 dollars of medical benefits and 500-dollar deductibles; or premium, with higher limits and 250-dollar deductibles.",
  lawsuitNote: "",
};

// Michigan municipalities by rating territory (normalized names; see normalizeMunicipality).
// Anything not listed rates in the fallback (standard) territory.
const MI_TERRITORIES: Record<string, Territory> = Object.fromEntries(
  (
    [
      [1, ["detroit", "highland park", "hamtramck"]],
      [2, [
        "dearborn", "dearborn heights", "southfield", "southfield township", "warren", "eastpointe", "inkster", "redford", "redford township",
        "pontiac", "taylor", "westland", "roseville", "harper woods", "oak park", "ferndale", "river rouge", "ecorse", "lincoln park",
        "melvindale", "romulus", "flint", "flint township", "saginaw", "hazel park", "allen park", "wayne", "garden city", "center line",
      ]],
      [3, [
        "livonia", "troy", "sterling heights", "novi", "farmington hills", "farmington", "royal oak", "canton", "canton township",
        "ann arbor", "grand rapids", "lansing", "east lansing", "kalamazoo", "clinton township", "shelby township", "macomb township",
        "rochester hills", "rochester", "wyoming", "kentwood", "bloomfield hills", "bloomfield township", "birmingham", "west bloomfield",
        "west bloomfield township", "st clair shores", "grosse pointe", "grosse pointe park", "grosse pointe woods", "grosse pointe farms",
        "grosse pointe shores", "ypsilanti", "ypsilanti township", "plymouth", "northville", "wixom", "auburn hills", "madison heights",
        "waterford", "waterford township", "commerce township", "white lake", "brighton", "battle creek", "jackson", "muskegon",
        "portage", "bay city", "midland",
      ]],
      [5, [
        "marquette", "escanaba", "sault ste marie", "houghton", "hancock", "iron mountain", "ironwood", "menominee", "ishpeming",
        "negaunee", "munising", "manistique", "gaylord", "alpena", "cheboygan", "petoskey", "cadillac", "ludington", "grayling",
        "houghton lake", "roscommon", "oscoda", "west branch", "harrisville", "mio",
      ]],
    ] as [Territory, string[]][]
  ).flatMap(([t, names]) => names.map((n) => [n, t] as const)),
);

const MI: StateConfig = {
  state: "MI",
  name: "Michigan",
  rateTableVersion: "DEMO-MI-2026.10",
  coverages: [
    { code: "BI", kind: "liability", name: "Bodily injury liability" },
    { code: "PD", kind: "liability", name: "Property damage liability" },
    { code: "PPI", kind: "liability", name: "Property protection insurance" },
    { code: "LPD", kind: "liability", name: "Limited property damage (mini-tort)" },
    { code: "PIP", kind: "first_party", name: "Personal injury protection" },
    { code: "UM", kind: "um", name: "Uninsured / underinsured motorist" },
    { code: "COMP", kind: "comp", name: "Comprehensive" },
    { code: "COLL", kind: "coll", name: "Collision" },
  ],
  baseRates: { BI: 190, PD: 14, PPI: 22, LPD: 9, PIP: 330, UM: 32, COMP: 72, COLL: 245 },
  // Michigan is not rated by ZIP: see municipalityRating.
  zip3Territory: {},
  territoryFactors: {
    1: { liability: 1.95, physical: 1.5, label: "Detroit territory" },
    2: { liability: 1.4, physical: 1.2, label: "inner metro territory" },
    3: { liability: 1.1, physical: 1.05, label: "suburban territory" },
    4: { liability: 1.0, physical: 1.0, label: "standard territory" },
    5: { liability: 0.85, physical: 0.9, label: "northern and rural territory" },
  },
  // Default BI is 250/500; a signed form can lower it to a 50/100 floor. PD liability is $10,000 minimum (MCL 500.3009).
  // PPI pays up to $1,000,000 per accident (MCL 500.3121) and is in every package. Mini-tort covers up to $3,000 (MCL 500.3135(3)(e)).
  // PIP is not a package choice: the caller elects its medical limit (pipMedical).
  packages: {
    minimum: {
      label: "State Minimum",
      spoken: "state minimum: 50/100 liability, $10,000 property damage, the required $1 million property protection, no physical damage coverage",
      limits: { BI: "50/100", PD: "10", PPI: "1,000,000", LPD: null, PIP: "elected", UM: null, COMP: null, COLL: null },
      ilf: { BI: 0.72, PD: 0.85, PPI: 1.0, LPD: null, PIP: 1.0, UM: null, COMP: null, COLL: null },
      note: "Liability below 250/500 needs a signed Michigan selection form; the specialist sends it with the application.",
    },
    recommended: {
      label: "Recommended",
      spoken: "recommended: 250/500 liability, $1 million property protection, $3,000 mini-tort, $500 comprehensive and collision deductibles",
      limits: { BI: "250/500", PD: "25", PPI: "1,000,000", LPD: "3,000", PIP: "elected", UM: "250/500", COMP: "$500 ded", COLL: "$500 ded" },
      ilf: { BI: 1.0, PD: 1.0, PPI: 1.0, LPD: 1.0, PIP: 1.0, UM: 1.0, COMP: 1.0, COLL: 1.0 },
    },
    premium: {
      label: "Premium",
      spoken: "premium: 500/500 liability, $1 million property protection, $3,000 mini-tort, $250 deductibles",
      limits: { BI: "500/500", PD: "100", PPI: "1,000,000", LPD: "3,000", PIP: "elected", UM: "500/500", COMP: "$250 ded", COLL: "$250 ded" },
      ilf: { BI: 1.25, PD: 1.2, PPI: 1.0, LPD: 1.0, PIP: 1.0, UM: 1.25, COMP: 1.15, COLL: 1.15 },
    },
  },
  municipalityRating: { zip3Range: ["480", "499"], territories: MI_TERRITORIES, fallback: 4 },
  experienceFactor: false,
  seniorLowMileage: { minAge: 65, maxMiles: 3000, factor: 0.9 },
  // A civil infraction can't be merit rated longer than the Secretary of State keeps its points (MCL 500.2111(3)(b)): 2 years from conviction.
  merit: { minorViolationYears: 2, minorFromRecordOnly: true },
  // Factors scale the whole PIP line. Excluding or opting out removes the medical part only; wage loss,
  // replacement services and survivor's benefits stay, which is the remaining 0.30.
  pipMedical: {
    unlimited: { factor: 1.0, label: "Unlimited", spoken: "unlimited PIP medical" },
    "500k": { factor: 0.86, label: "$500,000", spoken: "$500,000 PIP medical" },
    "250k": { factor: 0.78, label: "$250,000", spoken: "$250,000 PIP medical" },
    "250k_excluded": { factor: 0.3, label: "$250,000, household excluded (qualified health coverage)", spoken: "$250,000 PIP medical with your household excluded" },
    "50k": { factor: 0.5, label: "$50,000 (Medicaid)", spoken: "$50,000 PIP medical" },
    opt_out: { factor: 0.3, label: "Opted out of PIP medical (Medicare Parts A and B)", spoken: "no PIP medical" },
  },
  // MCCA assessment for policies effective July 1, 2026 to June 30, 2027: $84 per vehicle with unlimited PIP, $19 otherwise.
  mcca: { unlimited: 84, other: 19, from: "2026-07-01", through: "2027-06-30" },
  // DIFS Bulletin 2026-08-INS: unchanged at $6,579 for July 1, 2026 to June 30, 2027. Review with the MCCA amounts every July 1.
  qhcMaxDeductible: 6579,
  packagesSentence:
    "We have three packages: state minimum, which is 50/100 liability, the lowest Michigan allows with a signed form; recommended, with 250/500 liability, mini-tort coverage and 500-dollar deductibles; or premium, with 500/500 liability and 250-dollar deductibles.",
  lawsuitNote: "Michigan no-fault: a lawsuit for noneconomic loss requires death, serious impairment of body function, or permanent serious disfigurement (MCL 500.3135(1))",
};

export const STATE_CONFIGS: Record<State, StateConfig> = { NJ, PA, MI };

export function stateConfig(state: State): StateConfig {
  return STATE_CONFIGS[state];
}

export const RATE_TABLE_VERSIONS: Record<State, string> = { NJ: NJ.rateTableVersion, PA: PA.rateTableVersion, MI: MI.rateTableVersion };

/** "the City of St. Clair Shores, MI" → "st clair shores"; "Clinton Twp" → "clinton township". */
export function normalizeMunicipality(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,'’]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(michigan|mi)$/, "")
    .replace(/^(the\s+)?(city|village)\s+of\s+/, "")
    .replace(/^(charter\s+)?township\s+of\s+(.+)$/, "$2 township")
    .replace(/\bcharter\s+township\b/, "township")
    .replace(/\btwp\b/, "township")
    .replace(/\bsaint\b/g, "st")
    .replace(/\bmount\b/g, "mt")
    .replace(/\s+/g, " ")
    .trim();
}

/** Rating territory for a municipality in a municipality-rated state (Michigan). */
export function territoryForMunicipality(state: State, raw: string): { territory: Territory; municipality: string; listed: boolean } {
  const m = stateConfig(state).municipalityRating;
  if (!m) throw new Error(`${state} is not rated by municipality`);
  const name = normalizeMunicipality(raw);
  const hit = m.territories[name] ?? m.territories[name.replace(/ township$/, "")];
  return { territory: hit ?? m.fallback, municipality: name, listed: hit !== undefined };
}

/**
 * Finds the state for a 5-digit ZIP, or null if we don't write there. The territory comes with it in
 * ZIP-rated states (NJ, PA); it's null where territories are municipal (MI), which needs the garaging city.
 */
export function territoryForZip(zip: string): { state: State; territory: Territory | null } | null {
  const zip3 = zip.slice(0, 3);
  for (const cfg of Object.values(STATE_CONFIGS)) {
    const territory = cfg.zip3Territory[zip3];
    if (territory) return { state: cfg.state, territory };
    const m = cfg.municipalityRating;
    if (m && zip3 >= m.zip3Range[0] && zip3 <= m.zip3Range[1]) return { state: cfg.state, territory: null };
  }
  return null;
}

export function ageFactor(age: number): number {
  if (age < 18) return 2.6;
  if (age < 21) return 2.1;
  if (age < 25) return 1.45;
  if (age < 30) return 1.12;
  if (age < 50) return 1.0;
  if (age < 65) return 0.92;
  if (age < 75) return 0.98;
  return 1.15;
}

/** Inexperience surcharge for adults with under 3 years licensed (teen rates already price it in). */
export function inexperienceFactor(age: number, yearsLicensed: number): number {
  return age >= 21 && yearsLicensed < 3 ? 1.2 : 1.0;
}

export const POINTS = { minor: 2, major: 6, atFault: 4 } as const;

/** Monotone non-decreasing in points, capped. */
export function pointsFactor(points: number): number {
  return Math.min(1 + 0.1 * points, 2.5);
}

export function vehicleAgeFactor(age: number): number {
  if (age <= 2) return 1.25;
  if (age <= 5) return 1.1;
  if (age <= 10) return 0.9;
  if (age <= 15) return 0.7;
  return 0.55;
}

export const VALUE_BAND_FACTORS: Record<ValueBand, number> = {
  economy: 0.82,
  standard: 1.0,
  premium: 1.3,
  luxury: 1.62,
};

export const BODY_LIABILITY_FACTORS: Record<BodyClass, number> = {
  sedan: 1.0,
  suv: 1.0,
  truck: 1.03,
  van: 0.95,
  sports: 1.15,
  other: 1.0,
};

export const USAGE_FACTORS: Record<Usage, number> = { pleasure: 0.92, commute: 1.0, business: 1.12 };

export function mileageFactor(miles: number): number {
  if (miles < 7500) return 0.92;
  if (miles <= 15000) return 1.0;
  return 1.08;
}

export const DISCOUNTS = {
  multiCar: 0.9,
  safeDriver: 0.9,
  continuousPrior: 0.95,
  noPriorSurcharge: 1.15,
  antiTheftComp: 0.85,
  payInFull: 0.92,
} as const;

export const POLICY_FEE = 25;
export const INSTALLMENT_FEE_PER_MONTH = 5;

const LUXURY_MAKES = new Set(["BMW", "MERCEDES-BENZ", "AUDI", "LEXUS", "PORSCHE", "TESLA", "LAND ROVER", "JAGUAR", "GENESIS", "CADILLAC", "VOLVO", "MASERATI", "LINCOLN", "INFINITI", "ACURA", "RIVIAN", "LUCID"]);
const ECONOMY_MAKES = new Set(["KIA", "HYUNDAI", "MITSUBISHI", "NISSAN", "CHEVROLET", "FORD", "TOYOTA", "HONDA", "MAZDA", "SUBARU", "VOLKSWAGEN"]);

/** Value band from make and vehicle age — a stand-in for an ISO symbol lookup. */
export function valueBandFor(make: string, vehicleAge: number): ValueBand {
  const m = make.trim().toUpperCase();
  if (LUXURY_MAKES.has(m)) return vehicleAge <= 6 ? "luxury" : "premium";
  if (vehicleAge > 12) return "economy";
  if (ECONOMY_MAKES.has(m)) return vehicleAge <= 3 ? "standard" : "economy";
  return "standard";
}

/** Maps an NHTSA vPIC BodyClass string (or a caller's words) to our body class. */
export function bodyClassFor(raw: string | undefined): BodyClass {
  const s = (raw ?? "").toLowerCase();
  if (/convertible|coupe|roadster|sports/.test(s)) return "sports";
  if (/pickup|truck/.test(s)) return "truck";
  if (/van|minivan/.test(s)) return "van";
  if (/sport utility|suv|crossover|multi-purpose/.test(s)) return "suv";
  if (/sedan|hatchback|wagon|saloon|liftback/.test(s)) return "sedan";
  return "other";
}
