import { DEFAULT_MERIT, type MeritRules } from "../rating/rateTable";
import type { DriverReports } from "../reports/vendor";

export interface SelfReported {
  tickets3y: number;
  atFaultAccidents3y: number;
  dui3y: boolean;
}

export interface MergedRecord {
  /** Minor violations inside the state's merit window (3 years; 2 in Michigan). */
  minorViolations3y: number;
  majorViolations3y: number;
  atFaultAccidents3y: number;
  dui3y: boolean;
  licenseStatus: DriverReports["mvr"]["status"];
  /** Speakable descriptions of what the reports found that the caller didn't mention. */
  discrepancies: string[];
}

const withinYears = (date: string, asOf: Date, years: number) => {
  const d = new Date(date + "T00:00:00Z");
  const cutoff = new Date(asOf);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  return d >= cutoff && d <= asOf;
};
const within3y = (date: string, asOf: Date) => withinYears(date, asOf, 3);

/**
 * Reports are authoritative where they show MORE than the caller said; the caller's
 * self-report stands where it shows more than the reports (e.g., an unreported out-of-state ticket).
 */
export function mergeRecord(self: SelfReported, reports: DriverReports, asOf: Date, merit: MeritRules = DEFAULT_MERIT): MergedRecord {
  const recent = reports.mvr.violations.filter((v) => within3y(v.date, asOf));
  // Civil infractions only count inside the state's merit window (Michigan: while the points stay on record).
  const counted = recent.filter((v) => v.kind !== "minor" || withinYears(v.date, asOf, merit.minorViolationYears));
  const mvrMinor = counted.filter((v) => v.kind === "minor").length;
  const mvrMajor = counted.filter((v) => v.kind === "major").length;
  const mvrDui = recent.some((v) => v.dui);
  const clueAtFault = reports.clue.claims.filter((c) => c.atFault && within3y(c.date, asOf)).length;

  // Self-reported "tickets" are treated as minor violations; a self-reported DUI is a major one.
  const selfMajor = self.dui3y ? 1 : 0;
  const discrepancies: string[] = [];
  const mvrTickets = mvrMinor + mvrMajor - (mvrDui ? 1 : 0);
  if (mvrTickets > self.tickets3y) {
    const extra = counted.filter((v) => !v.dui).map((v) => `${v.description} on ${v.date}`);
    discrepancies.push(`driving record shows ${mvrTickets} ticket${mvrTickets === 1 ? "" : "s"} (${extra.join("; ")}), caller reported ${self.tickets3y}`);
  }
  if (mvrDui && !self.dui3y) discrepancies.push("driving record shows a DUI within 3 years that the caller did not report");
  if (clueAtFault > self.atFaultAccidents3y) {
    discrepancies.push(`claims history shows ${clueAtFault} at-fault accident${clueAtFault === 1 ? "" : "s"}, caller reported ${self.atFaultAccidents3y}`);
  }
  if (reports.mvr.status !== "VALID") discrepancies.push(`license status is ${reports.mvr.status.toLowerCase()}`);

  return {
    // A self-reported count can't be dated, so where the window is shorter than the question it isn't rated.
    minorViolations3y: merit.minorFromRecordOnly ? mvrMinor : Math.max(mvrMinor, self.tickets3y),
    majorViolations3y: Math.max(mvrMajor, selfMajor),
    atFaultAccidents3y: Math.max(clueAtFault, self.atFaultAccidents3y),
    dui3y: mvrDui || self.dui3y,
    licenseStatus: reports.mvr.status,
    discrepancies,
  };
}
