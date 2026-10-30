import { describe, expect, test } from "bun:test";
import { openDb, Repo } from "../src/db";
import { SlidingWindowLimiter } from "../src/security/rateLimit";
import { createApp } from "../src/server/app";
import { QuoteService } from "../src/service";

// Michigan at the tool boundary. Statute references are in docs/STATUTES.md.

const SECRET = "test-secret-test-secret-123456";
const NOW = "2026-10-15T15:00:00Z";

function build(now = NOW) {
  const repo = new Repo(openDb(":memory:"));
  const service = new QuoteService({ repo, now: () => new Date(now), decode: async () => ({ decoded: null, source: "timeout" }), licenseKey: "k" });
  const app = createApp({ repo, service, toolSecret: SECRET, initiationSecret: "initiation-secret-initiation-secret", limiter: new SlidingWindowLimiter(), fetchMeta: async () => null, fetchTranscript: async () => null, log: () => {} });
  const tool = async (name: string, body: Record<string, unknown>) =>
    (await (await app.request(`/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": SECRET }, body: JSON.stringify(body) })).json()) as Record<string, any>;
  return { repo, tool };
}

type Tool = ReturnType<typeof build>["tool"];

const driver = (C: object, over: Record<string, unknown> = {}) => ({
  ...C, driver_index: 1, first_name: "Dana", last_name: "Brooks", date_of_birth: "1988-04-12", license_state: "MI",
  license_number: "B 123 456 789 012", years_licensed: 15, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false, ...over,
});

async function miQuote(t: Tool, id: string, opts: { zip?: string; city?: string; pip?: string; confirmed?: boolean; driver?: Record<string, unknown>; miles?: number } = {}) {
  const C = { conversation_id: id };
  const start = await t("start_quote", { ...C, caller_name: "Dana Brooks", zip: opts.zip ?? "48226", prior_insurance_months: 24, garaging_city: opts.city ?? "Detroit" });
  const d = await t("save_driver", driver(C, opts.driver));
  const v = await t("save_vehicle", { ...C, vehicle_index: 1, year: 2020, make: "Ford", model: "Escape", usage: "commute", annual_miles: opts.miles ?? 12000 });
  const cov = await t("set_coverage", { ...C, package: "recommended", pay_in_full: false, pip_medical: opts.pip ?? "unlimited", ...(opts.confirmed ? { pip_confirmed: true } : {}) });
  return { C, start, d, v, cov };
}

describe("Michigan territory comes from the garaging city, never the ZIP (MCL 500.2111(4)(f))", () => {
  test("a Michigan ZIP without a city asks for the city and saves nothing", async () => {
    for (const city of [undefined, "", "  "]) {
      const { tool, repo } = build();
      const r = await tool("start_quote", { conversation_id: "c1", caller_name: "Dana Brooks", zip: "48226", prior_insurance_months: 24, ...(city === undefined ? {} : { garaging_city: city }) });
      expect(r).toMatchObject({ ok: false, error: "CITY_REQUIRED", state: "Michigan" });
      expect(r.hint).toContain("city or township");
      expect(repo.getQuote("c1")).toBeNull();
    }
  });

  test("with a city the quote starts in Michigan, flags the PIP choice, and stores the city and territory", async () => {
    const { tool, repo } = build();
    const r = await tool("start_quote", { conversation_id: "c2", caller_name: "Dana Brooks", zip: "48226", prior_insurance_months: 24, garaging_city: "City of Detroit" });
    expect(r).toMatchObject({ ok: true, state: "Michigan", pip_choice_required: true, tort_choice_required: false });
    expect(r.packages_sentence).toContain("50/100");
    const q = repo.getQuote("c2")!;
    expect(q).toMatchObject({ state: "MI", territory: 1, garaging_city: "City of Detroit" });
  });

  test("same city, different ZIPs: identical price; same ZIP, different cities: different price", async () => {
    const { tool } = build();
    await miQuote(tool, "z1", { zip: "48152", city: "Livonia" });
    await miQuote(tool, "z2", { zip: "49503", city: "Livonia" });
    await miQuote(tool, "z3", { zip: "48152", city: "Detroit" });
    const a = await tool("get_quote", { conversation_id: "z1" });
    const b = await tool("get_quote", { conversation_id: "z2" });
    const c = await tool("get_quote", { conversation_id: "z3" });
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(a.six_month_premium).toBe(b.six_month_premium);
    expect(c.six_month_premium).toBeGreaterThan(a.six_month_premium);
  });

  test("NJ and PA still rate by ZIP and ignore a stray garaging_city", async () => {
    const { tool, repo } = build();
    const r = await tool("start_quote", { conversation_id: "nj", caller_name: "Sam Ortiz", zip: "07030", prior_insurance_months: 12, garaging_city: "Detroit" });
    expect(r).toMatchObject({ ok: true, state: "New Jersey", pip_choice_required: false });
    expect(repo.getQuote("nj")!.garaging_city).toBeNull();
  });

  test("out-of-state callers hear all three states", async () => {
    const { tool } = build();
    const r = await tool("start_quote", { conversation_id: "oh", caller_name: "Pat Lee", zip: "43215", prior_insurance_months: 0 });
    expect(r).toMatchObject({ ok: false, error: "OUT_OF_STATE", state: "OH" });
    expect(r.hint).toContain("New Jersey, Pennsylvania, or Michigan");
  });
});

describe("Michigan PIP medical election (MCL 500.3107c, 3107d, 3109a)", () => {
  test("a choice is required, and the default to offer when they won't choose is unlimited", async () => {
    const { tool } = build();
    const C = { conversation_id: "p0" };
    await tool("start_quote", { ...C, caller_name: "Dana Brooks", zip: "48226", prior_insurance_months: 24, garaging_city: "Detroit" });
    const r = await tool("set_coverage", { ...C, package: "recommended", pay_in_full: false });
    expect(r).toMatchObject({ ok: false, error: "PIP_CHOICE_REQUIRED" });
    expect(r.hint).toContain("unlimited, the Michigan default");
    expect(r.hint).toContain("never recommend");
  });

  test("standard levels record directly with no confirmation", async () => {
    for (const [level, label] of [["unlimited", "Unlimited"], ["500k", "$500,000"], ["250k", "$250,000"]] as const) {
      const { tool, repo } = build();
      const { cov } = await miQuote(tool, "p1", { pip: level });
      expect(cov).toMatchObject({ ok: true, pip_medical: label });
      expect(repo.getQuote("p1")).toMatchObject({ pip_medical: level, pip_confirmed_at: null });
    }
  });

  test("opt-out, exclusions and $50,000 need confirmed eligibility and a read disclosure before anything is saved", async () => {
    const expectations = {
      opt_out: { eligibility: "Medicare Parts A and B", disclosure: ["proof", "30 days"] },
      "250k_excluded": { eligibility: "other than Medicare", disclosure: ["30 days"] },
      "50k": { eligibility: "Medicaid", disclosure: ["up to 50,000 dollars per person"] },
    } as const;
    for (const [level, want] of Object.entries(expectations)) {
      const { tool, repo } = build();
      const { cov } = await miQuote(tool, "p2", { pip: level });
      expect(cov).toMatchObject({ ok: false, error: "PIP_ELIGIBILITY_CHECK" });
      expect(cov.eligibility).toContain(want.eligibility);
      for (const phrase of want.disclosure) expect(cov.disclosure).toContain(phrase);
      expect(typeof cov.if_not_eligible).toBe("string");
      expect(repo.getQuote("p2")).toMatchObject({ package: null, pip_medical: null });

      const ok = await tool("set_coverage", { conversation_id: "p2", package: "recommended", pay_in_full: false, pip_medical: level, pip_confirmed: true });
      expect(ok.ok).toBe(true);
      expect(repo.getQuote("p2")).toMatchObject({ package: "recommended", pip_medical: level, pip_confirmed_at: new Date(NOW).toISOString() });
    }
  });

  test("opt-out guidance points people with an ordinary health plan to $250,000 with exclusions", async () => {
    const { tool } = build();
    const { cov } = await miQuote(tool, "p3", { pip: "opt_out" });
    expect(cov.if_not_eligible).toContain("250,000 dollars with exclusions");
    // The qualified-health-coverage deductible cap is indexed; the agent hears the current figure (DIFS Bulletin 2026-08-INS).
    expect(cov.if_not_eligible).toContain("6,579 dollars or less");
  });

  test("the minimum package carries the selection-form note for liability under 250/500", async () => {
    const { tool } = build();
    const C = { conversation_id: "p4" };
    await tool("start_quote", { ...C, caller_name: "Dana Brooks", zip: "48226", prior_insurance_months: 24, garaging_city: "Detroit" });
    const r = await tool("set_coverage", { ...C, package: "minimum", pay_in_full: true, pip_medical: "250k" });
    expect(r).toMatchObject({ ok: true, package: "State Minimum" });
    expect(r.note).toContain("selection form");
  });

  test("get_quote won't price a Michigan quote without a PIP choice on file", async () => {
    const { tool, repo } = build();
    const { C } = await miQuote(tool, "p5");
    repo.setCoverage(C.conversation_id, "recommended", false, null, null);
    const r = await tool("get_quote", C);
    expect(r).toMatchObject({ ok: false, error: "MISSING_INFO" });
    expect(r.hint).toContain("the PIP medical choice");
  });
});

describe("Michigan estimate (license pending) carries the same PIP and MCCA fields as the full quote (review 2026-10-16)", () => {
  test("pip_medical and mcca_fee_included are on the estimate", async () => {
    const { tool } = build();
    const { C } = await miQuote(tool, "e1", { driver: { license_number: "" } });
    const r = await tool("get_quote", C);
    expect(r).toMatchObject({ ok: true, estimate: true, mcca_fee_included: 42, pip_medical: "unlimited PIP medical" });
  });
});

describe("Michigan pricing", () => {
  test("the MCCA assessment is half the car-year amount per vehicle and is in the six-month price", async () => {
    const { tool, repo } = build();
    await miQuote(tool, "m1", { pip: "unlimited" });
    await miQuote(tool, "m2", { pip: "opt_out", confirmed: true });
    const unlimited = await tool("get_quote", { conversation_id: "m1" });
    const optOut = await tool("get_quote", { conversation_id: "m2" });
    expect(unlimited).toMatchObject({ ok: true, mcca_fee_included: 42, pip_medical: "unlimited PIP medical" });
    expect(optOut).toMatchObject({ ok: true, mcca_fee_included: 9.5, pip_medical: "no PIP medical" });
    expect(optOut.six_month_premium).toBeLessThan(unlimited.six_month_premium);
    const rated = JSON.parse(repo.getQuote("m1")!.rating_json!);
    expect(rated.result.assessments).toEqual([{ name: "Michigan Catastrophic Claims Association assessment", perVehicle: 42, vehicles: 1, amount: 42 }]);
    expect(rated.input.pipMedical).toBe("unlimited");
  });

  test("Michigan rating uses age, not years licensed, and gives seniors under 3,000 miles a reduction", async () => {
    const { tool, repo } = build();
    await miQuote(tool, "s1", { driver: { date_of_birth: "1954-02-02", years_licensed: 50 }, miles: 2500 });
    expect((await tool("get_quote", { conversation_id: "s1" })).ok).toBe(true);
    const lines = JSON.parse(repo.getQuote("s1")!.rating_json!).result.lines as { factors: { name: string }[] }[];
    expect(lines.every((l) => !l.factors.some((f) => f.name === "driving experience"))).toBe(true);
    expect(lines.every((l) => l.factors.some((f) => f.name === "senior low-mileage discount"))).toBe(true);
  });

  test("undatable self-reported tickets aren't merit rated in Michigan (points last 2 years; MCL 500.2111(3))", async () => {
    const { tool } = build();
    await miQuote(tool, "t0", { driver: { tickets_3y: 0 } });
    await miQuote(tool, "t2", { driver: { tickets_3y: 2 } });
    const clean = await tool("get_quote", { conversation_id: "t0" });
    const selfReported = await tool("get_quote", { conversation_id: "t2" });
    expect(selfReported.six_month_premium).toBe(clean.six_month_premium);
  });

  test("outside the loaded MCCA period, Michigan refuses to price and hands off", async () => {
    for (const now of ["2026-06-30T12:00:00Z", "2027-07-01T12:00:00Z"]) {
      const { tool } = build(now);
      await miQuote(tool, "r1");
      const r = await tool("get_quote", { conversation_id: "r1" });
      expect(r).toMatchObject({ ok: false, error: "RATES_UNAVAILABLE" });
    }
  });

  test("the close mentions Michigan's selection form, plus proof of coverage after an opt-out", async () => {
    for (const [pip, proof] of [["250k", false], ["opt_out", true]] as const) {
      const { tool } = build();
      const { C } = await miQuote(tool, `a-${pip}`, { pip, confirmed: proof });
      const q = await tool("get_quote", C);
      const app = await tool("submit_application", { ...C, quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Dana", last_name: "Brooks" });
      expect(app.ok).toBe(true);
      expect(app.next_step).toContain("Michigan's PIP selection form");
      expect(app.next_step.includes("proof of coverage")).toBe(proof);
    }
  });
});

describe("returning callers keep their Michigan details", () => {
  test("resumeInto copies the garaging city and the confirmed PIP election", async () => {
    const { tool, repo } = build();
    await miQuote(tool, "old", { city: "Southfield", pip: "250k_excluded", confirmed: true });
    repo.createResumeToken({ token: "TOKEN1", from_quote_id: "old", conversation_id: "new", caller_hash: "h", expires_at: "2099-01-01T00:00:00.000Z" });
    repo.resumeInto("TOKEN1", "old", "new", "live");
    expect(repo.getQuote("new")).toMatchObject({ state: "MI", garaging_city: "Southfield", territory: 2, pip_medical: "250k_excluded", pip_confirmed_at: new Date(NOW).toISOString() });
  });
});
