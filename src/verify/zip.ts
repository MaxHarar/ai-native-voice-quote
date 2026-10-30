import { STATE_CONFIGS, territoryForZip } from "../rating/rateTable";
import type { State, Territory } from "../rating/types";

/** territory is null in municipality-rated states (Michigan): the garaging city decides it, never the ZIP. */
export type ZipCheck =
  | { ok: true; zip: string; state: State; territory: Territory | null }
  | { ok: false; error: "INVALID_ZIP" | "OUT_OF_STATE"; hint: string; state?: string };

const OTHER_STATES: [RegExp, string][] = [
  [/^19[7-9]/, "DE"],
  [/^1[0-4]/, "NY"],
  [/^0[6]/, "CT"],
  [/^2[0-1]/, "MD"],
  [/^4[3-5]/, "OH"],
  [/^4[67]/, "IN"],
];

/** "New Jersey, Pennsylvania, or Michigan" — derived from the configs so it can't drift. */
export const SERVED_STATES = (() => {
  const names = Object.values(STATE_CONFIGS).map((c) => c.name);
  return names.length <= 2 ? names.join(" or ") : `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
})();

export function checkZip(raw: string): ZipCheck {
  const zip = raw.replace(/\D/g, "").slice(0, 5);
  if (zip.length !== 5) return { ok: false, error: "INVALID_ZIP", hint: "Ask for the five-digit ZIP code where the car is parked overnight." };
  const hit = territoryForZip(zip);
  if (hit) return { ok: true, zip, ...hit };
  const state = OTHER_STATES.find(([re]) => re.test(zip))?.[1];
  return {
    ok: false,
    error: "OUT_OF_STATE",
    state,
    hint: `This line only quotes cars garaged in ${SERVED_STATES}. Offer to transfer the caller to a licensed agent.`,
  };
}
