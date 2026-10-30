import type { MergedRecord } from "./merge";

export type ReferReason =
  | "LICENSE_NOT_VALID"
  | "DUI_WITHIN_3Y"
  | "THREE_PLUS_AT_FAULT"
  | "RIDESHARE_OR_COMMERCIAL"
  | "VEHICLE_TOO_OLD"
  | "TOO_MANY_UNITS";

export type Eligibility = { status: "OK" } | { status: "REFER"; reasons: ReferReason[] };

export interface EligibilityVehicle { modelYear: number; rideshareOrCommercial: boolean }

export const MAX_DRIVERS = 4;
export const MAX_VEHICLES = 4;

export function checkEligibility(drivers: MergedRecord[], vehicles: EligibilityVehicle[], effectiveYear: number): Eligibility {
  const reasons = new Set<ReferReason>();
  for (const d of drivers) {
    if (d.licenseStatus !== "VALID") reasons.add("LICENSE_NOT_VALID");
    if (d.dui3y) reasons.add("DUI_WITHIN_3Y");
    if (d.atFaultAccidents3y >= 3) reasons.add("THREE_PLUS_AT_FAULT");
  }
  for (const v of vehicles) {
    if (v.rideshareOrCommercial) reasons.add("RIDESHARE_OR_COMMERCIAL");
    if (effectiveYear - v.modelYear > 30) reasons.add("VEHICLE_TOO_OLD");
  }
  if (drivers.length > MAX_DRIVERS || vehicles.length > MAX_VEHICLES) reasons.add("TOO_MANY_UNITS");
  return reasons.size === 0 ? { status: "OK" } : { status: "REFER", reasons: [...reasons].sort() };
}
