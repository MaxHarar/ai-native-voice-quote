import { describe, expect, test } from "bun:test";
import { resumeNextStep } from "../src/service";

// resume_quote's next_step: where a call back picks up, and the exact instruction the agent gets.
// Every combination of (vehicles saved?, coverage missing?, licenses pending?) is pinned here.

const GREET_PRICE = "Greet them by first name and say in one short sentence that you're re-checking their price.";
const GREET_SUMMARY = "Greet them by first name and summarize what's on file in one sentence.";
const NEVER_AGAIN = "Everything on file is already saved: never ask those questions again.";
const LICENSES = "First ask for each missing license number";
const COVERAGE = "Then continue with the coverage step, using packages_sentence and the tort or PIP choice if required, then set_coverage and get_quote.";
const PRICE = "Then call get_quote.";

describe("resumeNextStep", () => {
  const cases: { vehicles: number; coverageMissing: boolean; licensesPending: boolean; at: string; greet: string; then: string }[] = [];
  for (const vehicles of [0, 1, 3])
    for (const coverageMissing of [false, true])
      for (const licensesPending of [false, true]) {
        const at = vehicles === 0 ? "other_drivers" : coverageMissing ? "coverage" : "price";
        cases.push({
          vehicles, coverageMissing, licensesPending, at,
          greet: at === "price" && !licensesPending ? GREET_PRICE : GREET_SUMMARY,
          then: at === "other_drivers" ? "Then ask whether anyone else in the household drives besides Jordan and Casey, and continue with the vehicles step." : at === "coverage" ? COVERAGE : PRICE,
        });
      }

  for (const c of cases) {
    test(`vehicles=${c.vehicles} coverageMissing=${c.coverageMissing} licensesPending=${c.licensesPending} → ${c.at}`, () => {
      const r = resumeNextStep({ vehicles: c.vehicles, coverageMissing: c.coverageMissing, licensesPending: c.licensesPending, driverNames: ["Jordan", "Casey"] });
      expect(r.resumeAt).toBe(c.at as typeof r.resumeAt);
      // Order: greeting, never-again, (licenses), then the branch step. Nothing else.
      expect(r.text.startsWith(c.greet + " " + NEVER_AGAIN + " ")).toBe(true);
      expect(r.text.endsWith(c.then)).toBe(true);
      expect(r.text.includes(LICENSES)).toBe(c.licensesPending);
      expect(r.text.includes("add_license")).toBe(c.licensesPending);
      if (c.licensesPending) expect(r.text.indexOf(LICENSES)).toBeLessThan(r.text.indexOf(c.then));
      // No double spaces from the empty license sentence.
      expect(r.text).not.toContain("  ");
    });
  }

  test("zero vehicles wins over missing coverage: the household question comes before coverage", () => {
    expect(resumeNextStep({ vehicles: 0, coverageMissing: true, licensesPending: false, driverNames: ["Jordan"] }).resumeAt).toBe("other_drivers");
  });

  test("names the saved drivers in the household question", () => {
    expect(resumeNextStep({ vehicles: 0, coverageMissing: true, licensesPending: false, driverNames: ["Dana"] }).text).toContain("drives besides Dana, and continue");
    expect(resumeNextStep({ vehicles: 0, coverageMissing: true, licensesPending: false, driverNames: ["A", "B", "C"] }).text).toContain("drives besides A and B and C,");
  });
});
