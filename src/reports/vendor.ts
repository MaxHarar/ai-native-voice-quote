// SIMULATED report vendor (stand-in for MVR via state DMV, CLUE via LexisNexis, and a prior-carrier
// verification). Deterministic: the same license number always returns the same reports, so evals
// can assert on outcomes. Unknown licenses return a clean record flagged source:"default".

export type ViolationKind = "minor" | "major";
export interface Violation { date: string; kind: ViolationKind; dui: boolean; description: string }
export interface MvrReport { status: "VALID" | "SUSPENDED" | "REVOKED"; violations: Violation[]; source: "vendor" | "default" }
export interface ClueClaim { date: string; type: string; atFault: boolean; amount: number }
export interface ClueReport { claims: ClueClaim[]; source: "vendor" | "default" }
export interface PriorReport { carrier: string | null; continuousMonths: number | null; source: "vendor" | "default" }
export interface DriverReports { mvr: MvrReport; clue: ClueReport; prior: PriorReport }

const SEEDED: Record<string, Omit<DriverReports, "mvr" | "clue" | "prior"> & {
  mvr: Omit<MvrReport, "source">; clue: Omit<ClueReport, "source">; prior: Omit<PriorReport, "source">;
}> = {
  // Sarah Smith — clean record, long continuous coverage.
  S10000000000001: { mvr: { status: "VALID", violations: [] }, clue: { claims: [] }, prior: { carrier: "Garden State Mutual", continuousMonths: 36 } },
  // Daniel Diaz — two tickets on the MVR that callers tend to "forget".
  D20000000000002: {
    mvr: {
      status: "VALID",
      violations: [
        { date: "2025-11-04", kind: "minor", dui: false, description: "speeding 14 over" },
        { date: "2026-03-18", kind: "minor", dui: false, description: "improper passing" },
      ],
    },
    clue: { claims: [] },
    prior: { carrier: "Shoreline Auto", continuousMonths: 14 },
  },
  // Riley Reed — DUI inside 3 years: refer to a human.
  R30000000000003: {
    mvr: { status: "VALID", violations: [{ date: "2025-02-09", kind: "major", dui: true, description: "driving while intoxicated" }] },
    clue: { claims: [] },
    prior: { carrier: "Pinelands Insurance", continuousMonths: 8 },
  },
  // Kevin Kim — suspended license: refer.
  K40000000000004: { mvr: { status: "SUSPENDED", violations: [] }, clue: { claims: [] }, prior: { carrier: null, continuousMonths: 0 } },
  // Taylor Tran — one at-fault claim in CLUE.
  T50000000000005: {
    mvr: { status: "VALID", violations: [] },
    clue: { claims: [{ date: "2025-06-21", type: "collision", atFault: true, amount: 8400 }] },
    prior: { carrier: "Garden State Mutual", continuousMonths: 24 },
  },
};

export function pullReports(licenseNumber: string): DriverReports {
  const seeded = SEEDED[licenseNumber];
  if (!seeded) {
    return {
      mvr: { status: "VALID", violations: [], source: "default" },
      clue: { claims: [], source: "default" },
      prior: { carrier: null, continuousMonths: null, source: "default" },
    };
  }
  return {
    mvr: { ...seeded.mvr, source: "vendor" },
    clue: { ...seeded.clue, source: "vendor" },
    prior: { ...seeded.prior, source: "vendor" },
  };
}

export const SEEDED_LICENSES = Object.keys(SEEDED);
