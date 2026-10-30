import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, openDb, Repo } from "../src/db";
import { rate } from "../src/rating/engine";
import { stateConfig } from "../src/rating/rateTable";
import type { RatingInput } from "../src/rating/types";
import { createApp } from "../src/server/app";
import { QuoteService } from "../src/service";

const adult = { age: 38, yearsLicensed: 20, minorViolations3y: 0, majorViolations3y: 0, atFaultAccidents3y: 0 };
const car = { modelYear: 2021, bodyClass: "sedan" as const, valueBand: "standard" as const, usage: "commute" as const, annualMiles: 12000, antiTheft: false };
const pa: RatingInput = { state: "PA", territory: 3, drivers: [adult], vehicles: [car], package: "recommended", priorInsuranceMonths: 24, payInFull: false, tortOption: "full", umStacked: true, effectiveYear: 2026 };

describe("Pennsylvania rating", () => {
  test("golden PA premiums", () => {
    const personas: Record<string, RatingInput> = {
      "Bucks County adult, full tort": pa,
      "Bucks County adult, limited tort": { ...pa, tortOption: "limited" },
      "Philadelphia adult, full tort": { ...pa, territory: 1 },
      "Pittsburgh young driver, limited tort": { ...pa, territory: 2, tortOption: "limited", drivers: [{ ...adult, age: 20, yearsLicensed: 3 }] },
      "PA minimum, limited tort, no prior": { ...pa, package: "minimum", tortOption: "limited", priorInsuranceMonths: 0 },
      "two cars, stacked UM/UIM": { ...pa, vehicles: [car, { ...car, modelYear: 2015, valueBand: "economy" }] },
    };
    const golden = Object.fromEntries(Object.entries(personas).map(([k, v]) => [k, rate(v).sixMonthPremium]));
    expect(golden).toMatchSnapshot();
  });

  test("version stamp, MED instead of PIP, PA minimum has no physical damage", () => {
    const r = rate(pa);
    expect(r.rateTableVersion).toBe("DEMO-PA-2026.10");
    const covs = r.lines.map((l) => l.coverage);
    expect(covs).toContain("MED");
    expect(covs).not.toContain("PIP");
    const min = rate({ ...pa, package: "minimum" }).lines.map((l) => l.coverage);
    expect(min).not.toContain("COMP");
    expect(min).not.toContain("COLL");
    expect(stateConfig("PA").packages.minimum.limits).toMatchObject({ BI: "15/30", PD: "5", MED: "5,000" });
  });

  test("limited tort is cheaper than full tort, and only BI and UM move", () => {
    const full = rate({ ...pa, tortOption: "full" });
    const limited = rate({ ...pa, tortOption: "limited" });
    expect(limited.sixMonthPremium).toBeLessThan(full.sixMonthPremium);
    for (const cov of ["PD", "MED", "COMP", "COLL"]) {
      expect(limited.lines.find((l) => l.coverage === cov)!.premium).toBe(full.lines.find((l) => l.coverage === cov)!.premium);
    }
  });

  test("no tort election is priced as full tort (75 Pa.C.S. § 1705(a)(3))", () => {
    const { tortOption: _t, ...noElection } = pa;
    expect(rate(noElection as RatingInput).sixMonthPremium).toBe(rate({ ...pa, tortOption: "full" }).sixMonthPremium);
  });

  test("UM/UIM stacking only applies with 2+ vehicles, and costs more than unstacked", () => {
    const two = { ...pa, vehicles: [car, { ...car, modelYear: 2015 }] };
    const um = (i: RatingInput) => rate(i).lines.filter((l) => l.coverage === "UM").reduce((s, l) => s + l.premium, 0);
    expect(um({ ...two, umStacked: true })).toBeGreaterThan(um({ ...two, umStacked: false }));
    expect(um({ ...pa, umStacked: true })).toBe(um({ ...pa, umStacked: false }));
  });

  test("Philadelphia is the most expensive PA territory", () => {
    const prices = ([1, 2, 3, 4, 5] as const).map((t) => rate({ ...pa, territory: t }).sixMonthPremium);
    expect(prices[0]).toBe(Math.max(...prices));
    expect(prices[4]).toBe(Math.min(...prices));
  });

  test("NJ quotes never carry a tort factor", () => {
    const nj = rate({ ...pa, state: "NJ", tortOption: "limited" });
    expect(nj.lines.flatMap((l) => l.factors.map((f) => f.name))).not.toContain("limited tort");
    expect(nj.lines.map((l) => l.coverage)).toContain("PIP");
  });
});

describe("Pennsylvania quote flow (HTTP)", () => {
  const SECRET = "test-secret-test-secret-123456";
  let repo: Repo;
  let app: ReturnType<typeof createApp>;
  const C = { conversation_id: "conv_pa_1", eval_tag: "unit" };
  const call = async (tool: string, body: Record<string, unknown>) =>
    (await (await app.request(`/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": SECRET }, body: JSON.stringify(body) })).json()) as any;

  beforeEach(() => {
    repo = new Repo(openDb(":memory:"));
    app = createApp({ repo, service: new QuoteService({ repo, now: () => new Date("2026-10-14T15:00:00Z"), decode: async () => ({ decoded: null, source: "timeout" }), licenseKey: "k" }), toolSecret: SECRET, opsUser: "max", opsPassword: "pw-pw-pw-pw" });
  });

  async function startPa(zip = "18947") {
    const s = await call("start_quote", { ...C, caller_name: "Max Harar", zip, prior_insurance_months: 24 });
    expect(s.ok).toBe(true);
    expect(s.state).toBe("Pennsylvania");
    expect(s.tort_choice_required).toBe(true);
    expect(s.packages_sentence).toContain("15/30");
    expect((await call("save_driver", { ...C, driver_index: 1, first_name: "Max", last_name: "Harar", date_of_birth: "2001-03-15", license_state: "PA", license_number: "1234 5678", years_licensed: 7, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false })).ok).toBe(true);
    expect((await call("save_vehicle", { ...C, vehicle_index: 1, year: 2020, make: "Toyota", model: "Camry", usage: "commute", annual_miles: 12000 })).ok).toBe(true);
  }

  test("PA set_coverage requires the tort election, then quotes and applies", async () => {
    await startPa();
    const noTort = await call("set_coverage", { ...C, package: "recommended", pay_in_full: false });
    expect(noTort.error).toBe("TORT_OPTION_REQUIRED");
    expect((await call("get_quote", C)).error).toBe("MISSING_INFO");
    expect((await call("set_coverage", { ...C, package: "recommended", pay_in_full: false, tort_option: "limited" })).tort_option).toBe("limited");
    const q = await call("get_quote", C);
    expect(q.ok).toBe(true);
    expect(q.tort_option).toBe("limited tort");
    expect(q.package).toContain("$25,000 medical benefits");
    const sub = await call("submit_application", { ...C, quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Max", last_name: "Harar" });
    expect(sub.application_number).toMatch(/^ANA-\d{7}$/);
    const row = repo.getQuote(C.conversation_id)!;
    expect(row).toMatchObject({ state: "PA", territory: 3, tort_option: "limited", status: "applied" });
    expect(JSON.parse(row.rating_json!).result.rateTableVersion).toBe("DEMO-PA-2026.10");
  });

  test("changing the tort election invalidates the quote hash", async () => {
    await startPa();
    await call("set_coverage", { ...C, package: "recommended", pay_in_full: false, tort_option: "limited" });
    const q = await call("get_quote", C);
    await call("set_coverage", { ...C, package: "recommended", pay_in_full: false, tort_option: "full" });
    expect((await call("submit_application", { ...C, quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Max", last_name: "Harar" })).ok).toBe(false);
  });

  test("NJ set_coverage ignores a stray tort option", async () => {
    await call("start_quote", { ...C, caller_name: "Sarah Smith", zip: "08540", prior_insurance_months: 36 });
    const r = await call("set_coverage", { ...C, package: "recommended", pay_in_full: false, tort_option: "limited" });
    expect(r.ok).toBe(true);
    expect(repo.getQuote(C.conversation_id)!.tort_option).toBeNull();
  });

  test("PA summary page shows the state, tort choice, and medical benefits", async () => {
    await startPa("19123");
    await call("set_coverage", { ...C, package: "recommended", pay_in_full: true, tort_option: "full" });
    const q = await call("get_quote", C);
    const sub = await call("submit_application", { ...C, quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Max", last_name: "Harar" });
    const html = await (await app.request(`/q/${sub.application_number}`, { headers: { authorization: "Basic " + Buffer.from("max:pw-pw-pw-pw").toString("base64") } })).text();
    expect(html).toContain("Pennsylvania");
    expect(html).toContain("Full tort");
    expect(html).toContain("First party medical benefits");
    expect(html).not.toContain("Personal injury protection");
  });
});

describe("migration onto the pre-PA production schema", () => {
  test("adds state and tort_option to an existing quotes table without losing rows", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE quotes (id TEXT PRIMARY KEY, eval_tag TEXT NOT NULL DEFAULT 'live', zip TEXT, territory INTEGER, status TEXT NOT NULL DEFAULT 'open')");
    db.exec("INSERT INTO quotes (id, zip, territory) VALUES ('old_nj', '08540', 3)");
    migrate(db);
    migrate(db); // idempotent
    const cols = (db.query("PRAGMA table_info(quotes)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("state");
    expect(cols).toContain("tort_option");
    // The pre-PA line only quoted New Jersey, so the row is backfilled rather than left to a silent NJ default (review 2026-10-16).
    expect(db.query("SELECT id, state FROM quotes").all()).toEqual([{ id: "old_nj", state: "NJ" }]);
  });
});
