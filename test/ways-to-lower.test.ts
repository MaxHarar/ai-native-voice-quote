import { describe, expect, test } from "bun:test";
import { openDb, Repo } from "../src/db";
import { rate } from "../src/rating/engine";
import { stateConfig } from "../src/rating/rateTable";
import type { RatingInput } from "../src/rating/types";
import { SlidingWindowLimiter } from "../src/security/rateLimit";
import { createApp } from "../src/server/app";
import { cheaperOptions, QuoteService } from "../src/service";

// ways_to_lower: when the caller balks at the price, the agent offers real, re-rated alternatives the
// caller controls on this call (a smaller package, paying in full; never limited tort), biggest saving first.

type Way = { option: string; six_month_premium: number; saves: number };

const base = (over: Partial<RatingInput> = {}): RatingInput => ({
  state: "NJ",
  territory: 3,
  drivers: [{ age: 35, yearsLicensed: 15, minorViolations3y: 0, majorViolations3y: 0, atFaultAccidents3y: 0 }],
  vehicles: [{ modelYear: 2020, bodyClass: "sedan", valueBand: "standard", usage: "commute", annualMiles: 12000, antiTheft: false }],
  package: "premium",
  priorInsuranceMonths: 24,
  payInFull: false,
  effectiveYear: 2026,
  ...over,
});

const ways = (input: RatingInput) => cheaperOptions(input, rate(input).sixMonthPremium, stateConfig(input.state));

/** Every option is the real re-rated price of exactly that change, and the saving is the difference. */
function expectRepriced(input: RatingInput, out: Way[], changes: Record<string, Partial<RatingInput>>) {
  const premium = rate(input).sixMonthPremium;
  expect(out.map((w) => w.option).sort()).toEqual(Object.keys(changes).sort());
  for (const w of out) {
    const p = rate({ ...input, ...changes[w.option] }).sixMonthPremium;
    expect(w.six_month_premium).toBe(p);
    expect(w.saves).toBe(Math.round((premium - p) * 100) / 100);
    expect(w.saves).toBeGreaterThan(0);
  }
  expect([...out].sort((a, b) => b.saves - a.saves)).toEqual(out);
}

describe("cheaperOptions", () => {
  test("New Jersey premium package, monthly: both smaller packages and pay-in-full, never a tort option", () => {
    const nj = stateConfig("NJ");
    const input = base();
    const out = ways(input);
    expectRepriced(input, out, {
      [`switch to the ${nj.packages.minimum.label} package`]: { package: "minimum" },
      [`switch to the ${nj.packages.recommended.label} package`]: { package: "recommended" },
      "pay the six months in full": { payInFull: true },
    });
    // The smaller of the two packages saves more, so it comes first among the package options.
    const pk = out.filter((w) => w.option.includes("package"));
    expect(pk[0]!.option).toContain(nj.packages.minimum.label);
    // Even if a tort option leaks into a New Jersey input, New Jersey has no tort election to offer.
    expect(ways(base({ tortOption: "full" })).some((w) => w.option.includes("tort"))).toBe(false);
  });

  test("Pennsylvania never offers limited tort as a saving, whichever tort is chosen (review 2026-10-16)", () => {
    // Pitched as a money saver it skipped the statutory trade-off disclosure and edged into tort advice.
    const pa = base({ state: "PA", package: "recommended", tortOption: "full", umStacked: true });
    expectRepriced(pa, ways(pa), {
      [`switch to the ${stateConfig("PA").packages.minimum.label} package`]: { package: "minimum" },
      "pay the six months in full": { payInFull: true },
    });
    const limited = { ...pa, tortOption: "limited" as const };
    expect(ways(limited).some((w) => w.option.includes("tort"))).toBe(false);
  });

  test("already paying in full: no pay-in-full option; the minimum package paid in full: nothing to offer", () => {
    expect(ways(base({ payInFull: true })).map((w) => w.option)).not.toContain("pay the six months in full");
    expect(ways(base({ package: "minimum", payInFull: true }))).toEqual([]);
  });

  test("Michigan: package and pay-in-full only, with the PIP election held fixed", () => {
    const mi = base({ state: "MI", territory: 1, package: "premium", pipMedical: "500k" });
    const out = ways(mi);
    expectRepriced(mi, out, {
      [`switch to the ${stateConfig("MI").packages.minimum.label} package`]: { package: "minimum" },
      [`switch to the ${stateConfig("MI").packages.recommended.label} package`]: { package: "recommended" },
      "pay the six months in full": { payInFull: true },
    });
  });
});

// ── Through the tool surface ─────────────────────────────────────────────────────────────────

const SECRET = "test-secret-test-secret-123456";

function build() {
  const repo = new Repo(openDb(":memory:"));
  const service = new QuoteService({ repo, now: () => new Date("2026-10-15T15:00:00Z"), decode: async () => ({ decoded: null, source: "timeout" }), licenseKey: "k" });
  const app = createApp({ repo, service, toolSecret: SECRET, limiter: new SlidingWindowLimiter(), fetchMeta: async () => null, fetchTranscript: async () => null, log: () => {} });
  const tool = async (name: string, body: Record<string, unknown>) =>
    (await (await app.request(`/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": SECRET }, body: JSON.stringify(body) })).json()) as Record<string, any>;
  return { repo, tool };
}

/** Coverage as the caller chose it, plus what each ways_to_lower option changes. */
type Coverage = { package: string; pay_in_full: boolean; tort_option?: string; pip_medical?: string };
function apply(option: string, cov: Coverage, labels: Record<string, string>): Coverage {
  if (option === "choose limited tort") return { ...cov, tort_option: "limited" };
  if (option === "pay the six months in full") return { ...cov, pay_in_full: true };
  const id = Object.entries(labels).find(([, label]) => option === `switch to the ${label} package`)?.[0];
  if (!id) throw new Error(`unexpected option ${option}`);
  return { ...cov, package: id };
}

async function repriceEach(tool: ReturnType<typeof build>["tool"], C: { conversation_id: string }, cov: Coverage, labels: Record<string, string>, expectedCount: number) {
  expect((await tool("set_coverage", { ...C, ...cov })).ok).toBe(true);
  const q = await tool("get_quote", C);
  const offered = q.ways_to_lower as Way[];
  expect(offered.length).toBe(expectedCount);
  for (const w of offered) {
    expect((await tool("set_coverage", { ...C, ...apply(w.option, cov, labels) })).ok).toBe(true);
    const alt = await tool("get_quote", C);
    expect({ option: w.option, price: alt.six_month_premium }).toEqual({ option: w.option, price: w.six_month_premium });
  }
  return { q, offered };
}

const labelsFor = (s: "NJ" | "PA" | "MI") => Object.fromEntries(Object.entries(stateConfig(s).packages).map(([id, p]) => [id, p.label]));

describe("ways_to_lower on get_quote", () => {
  test("Pennsylvania, premium, full tort, monthly: every alternative re-prices to exactly the quoted figure", async () => {
    const { tool } = build();
    const C = { conversation_id: "conv_pa" };
    await tool("start_quote", { ...C, caller_name: "Sam Whitaker", zip: "18938", prior_insurance_months: 24 });
    await tool("save_driver", { ...C, driver_index: 1, first_name: "Sam", last_name: "Whitaker", date_of_birth: "2003-05-05", license_state: "PA", license_number: "4821 0937", years_licensed: 5, tickets_3y: 1, at_fault_accidents_3y: 0, dui_3y: false });
    await tool("save_vehicle", { ...C, vehicle_index: 1, year: 2019, make: "Mercedes-Benz", model: "GLC", usage: "pleasure", annual_miles: 12000 });
    const { offered } = await repriceEach(tool, C, { package: "premium", pay_in_full: false, tort_option: "full" }, labelsFor("PA"), 3);
    expect(offered.some((w) => w.option.includes("tort"))).toBe(false);
  });

  test("New Jersey: no tort option is ever offered, and each alternative re-prices exactly", async () => {
    const { tool } = build();
    const C = { conversation_id: "conv_nj" };
    await tool("start_quote", { ...C, caller_name: "Sarah Smith", zip: "08540", prior_insurance_months: 36 });
    await tool("save_driver", { ...C, driver_index: 1, first_name: "Sarah", last_name: "Smith", date_of_birth: "1988-03-02", license_state: "NJ", license_number: "S10000000000001", years_licensed: 20, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false });
    await tool("save_vehicle", { ...C, vehicle_index: 1, year: 2020, make: "Toyota", model: "Camry", usage: "commute", annual_miles: 11000 });
    const { offered } = await repriceEach(tool, C, { package: "premium", pay_in_full: false }, labelsFor("NJ"), 3);
    expect(offered.some((w) => w.option.includes("tort"))).toBe(false);
  });

  test("Michigan: offered alongside the PIP election, and each alternative re-prices exactly", async () => {
    const { tool } = build();
    const C = { conversation_id: "conv_mi" };
    await tool("start_quote", { ...C, caller_name: "Dana Brooks", zip: "48226", prior_insurance_months: 24, garaging_city: "Detroit" });
    await tool("save_driver", { ...C, driver_index: 1, first_name: "Dana", last_name: "Brooks", date_of_birth: "1958-04-12", license_state: "MI", license_number: "B 123 456 789 012", years_licensed: 45, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false });
    await tool("save_vehicle", { ...C, vehicle_index: 1, year: 2018, make: "Ford", model: "Escape", usage: "pleasure", annual_miles: 6000 });
    const { q } = await repriceEach(tool, C, { package: "recommended", pay_in_full: false, pip_medical: "500k" }, labelsFor("MI"), 2);
    expect(q.pip_medical).toBeDefined();
    expect((q.ways_to_lower as Way[]).some((w) => w.option.includes("tort"))).toBe(false);
  });

  test("an estimate carries ways_to_lower too, identical to the same household priced with a clean record", async () => {
    const run = async (license?: string) => {
      const { tool } = build();
      const C = { conversation_id: "conv_est" };
      await tool("start_quote", { ...C, caller_name: "Sam Whitaker", zip: "18938", prior_insurance_months: 24 });
      await tool("save_driver", { ...C, driver_index: 1, first_name: "Sam", last_name: "Whitaker", date_of_birth: "2003-05-05", license_state: "PA", ...(license ? { license_number: license } : {}), years_licensed: 5, tickets_3y: 1, at_fault_accidents_3y: 0, dui_3y: false });
      await tool("save_vehicle", { ...C, vehicle_index: 1, year: 2019, make: "Mercedes-Benz", model: "GLC", usage: "pleasure", annual_miles: 12000 });
      await tool("set_coverage", { ...C, package: "recommended", pay_in_full: false, tort_option: "full" });
      return tool("get_quote", C);
    };
    const est = await run();
    expect(est.estimate).toBe(true);
    expect((est.ways_to_lower as Way[]).length).toBe(2); // minimum package, pay in full (never limited tort)
    expect(est.next_step).toContain("ways_to_lower");
    // 4821 0937 is unseeded: a clean record, so the licensed quote prices on the same self-report.
    expect(est.ways_to_lower).toEqual((await run("4821 0937")).ways_to_lower);
  });
});
