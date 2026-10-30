import { describe, expect, test } from "bun:test";
import { openDb, Repo } from "../src/db";
import { SlidingWindowLimiter } from "../src/security/rateLimit";
import { createApp } from "../src/server/app";
import { QuoteService } from "../src/service";

// Field feedback (2026-10-15): callers often don't have their license in hand. They can now finish
// everything else, add the number later in the call, or call back and resume.

const SECRET = "test-secret-test-secret-123456";
const INIT = "initiation-secret-initiation-secret";

function build() {
  const repo = new Repo(openDb(":memory:"));
  const service = new QuoteService({ repo, now: () => new Date("2026-10-15T15:00:00Z"), decode: async () => ({ decoded: null, source: "timeout" }), licenseKey: "k" });
  const app = createApp({ repo, service, toolSecret: SECRET, initiationSecret: INIT, limiter: new SlidingWindowLimiter(), fetchMeta: async () => null, fetchTranscript: async () => null, log: () => {} });
  const tool = async (name: string, body: Record<string, unknown>) =>
    (await (await app.request(`/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": SECRET }, body: JSON.stringify(body) })).json()) as Record<string, any>;
  return { repo, app, tool };
}

const driver = (C: object, license?: string) => ({
  ...C, driver_index: 1, first_name: "Sam", last_name: "Whitaker", date_of_birth: "2003-05-05", license_state: "PA",
  ...(license === undefined ? {} : { license_number: license }), years_licensed: 5, tickets_3y: 3, at_fault_accidents_3y: 1, dui_3y: false,
});

async function upToCoverage(t: ReturnType<typeof build>["tool"], C: { conversation_id: string }, license?: string) {
  await t("start_quote", { ...C, caller_name: "Sam Whitaker", zip: "18938", prior_insurance_months: 24 });
  const d = await t("save_driver", driver(C, license));
  await t("save_vehicle", { ...C, vehicle_index: 1, year: 2019, make: "Mercedes-Benz", model: "GLC", usage: "pleasure", annual_miles: 12000 });
  await t("set_coverage", { ...C, package: "recommended", pay_in_full: false, tort_option: "full" });
  return d;
}

describe("license number not handy", () => {
  test("the driver saves without a number and is marked pending (empty string or omitted)", async () => {
    for (const license of [undefined, ""]) {
      const { tool, repo } = build();
      const d = await upToCoverage(tool, { conversation_id: "conv_l" }, license);
      expect(d).toMatchObject({ ok: true, license_pending: true });
      expect(repo.drivers("conv_l")[0]!.license_last4).toBe("");
      expect(repo.reports("conv_l").length).toBe(0);
    }
  });

  test("without the number the caller still hears an estimate, from what they said, that is never saved as a quote", async () => {
    const { tool, repo } = build();
    await upToCoverage(tool, { conversation_id: "conv_l" });
    const q = await tool("get_quote", { conversation_id: "conv_l" });
    expect(q).toMatchObject({ ok: true, estimate: true, license_needed_for: ["Sam"] });
    expect(q.six_month_premium).toBeGreaterThan(0);
    expect(q.quote_hash).toBeUndefined();
    expect(q.next_step).toContain("call back from this number");
    expect(q.next_step).toContain("add_license");
    expect(q.next_step).toContain("may change");
    expect(repo.reports("conv_l").length).toBe(0);
    const row = repo.getQuote("conv_l")!;
    expect(row.status).toBe("open");
    expect(row.six_month_premium).toBeNull();
  });

  test("the estimate prices the self-reported record: the same household with a license and a clean MVR prices the same", async () => {
    // 4821 0937 is an unknown license, so its reports come back clean and the self-report decides both prices.
    const est = build();
    await upToCoverage(est.tool, { conversation_id: "conv_e" });
    const e = await est.tool("get_quote", { conversation_id: "conv_e" });
    const full = build();
    await upToCoverage(full.tool, { conversation_id: "conv_f" }, "4821 0937");
    const f = await full.tool("get_quote", { conversation_id: "conv_f" });
    expect(e.six_month_premium).toBe(f.six_month_premium);
  });

  test("an estimate can never be submitted", async () => {
    const { tool, repo } = build();
    await upToCoverage(tool, { conversation_id: "conv_l" });
    await tool("get_quote", { conversation_id: "conv_l" });
    const r = await tool("submit_application", { conversation_id: "conv_l", quote_hash: "ANYTHING", caller_confirmed: true, first_name: "Sam", last_name: "Whitaker" });
    expect(r).toMatchObject({ ok: false, error: "LICENSE_NEEDED", license_needed_for: ["Sam"] });
    expect(repo.applicationByQuote("conv_l")).toBeFalsy();
  });

  test("add_license attaches the number without re-asking anything, orders reports, and unlocks the final price", async () => {
    const { tool, repo } = build();
    await upToCoverage(tool, { conversation_id: "conv_l" });
    const before = repo.drivers("conv_l")[0]!;
    const r = await tool("add_license", { conversation_id: "conv_l", driver_index: 1, license_number: "4821 0937" });
    expect(r).toMatchObject({ ok: true, driver_index: 1, license_last4: "0937", license_needed_for: [] });
    const after = repo.drivers("conv_l")[0]!;
    expect({ ...after, license_hash: "", license_last4: "" }).toEqual({ ...before, license_hash: "", license_last4: "" });
    expect(repo.reports("conv_l").length).toBe(3);
    const q = await tool("get_quote", { conversation_id: "conv_l" });
    expect(q.estimate).toBeUndefined();
    expect(q.quote_hash).toMatch(/^[0-9A-F]{10}$/);
    const sub = await tool("submit_application", { conversation_id: "conv_l", quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Sam", last_name: "Whitaker" });
    expect(sub).toMatchObject({ ok: true, application_number: expect.stringMatching(/^ANA-\d{7}$/) });
    expect(repo.getQuote("conv_l")!.status).toBe("applied");
  });

  test("add_license validates against the state on file, takes a corrected state, and refuses unknown drivers", async () => {
    const { tool, repo } = build();
    await upToCoverage(tool, { conversation_id: "conv_l" });
    const bad = await tool("add_license", { conversation_id: "conv_l", driver_index: 1, license_number: "123" });
    expect(bad).toMatchObject({ ok: false, error: "INVALID_LICENSE" });
    expect(repo.drivers("conv_l")[0]!.license_last4).toBe("");
    expect((await tool("add_license", { conversation_id: "conv_l", driver_index: 2, license_number: "4821 0937" })).error).toBe("DRIVER_NOT_FOUND");
    const nj = await tool("add_license", { conversation_id: "conv_l", driver_index: 1, license_state: "NJ", license_number: "S 1000 0000 0000 01" });
    expect(nj.ok).toBe(true);
    expect(repo.drivers("conv_l")[0]!.license_state).toBe("NJ");
  });

  test("when the caller balks, real cheaper alternatives are on hand, biggest saving first", async () => {
    const { tool } = build();
    await upToCoverage(tool, { conversation_id: "conv_l" }, "4821 0937");
    const q = await tool("get_quote", { conversation_id: "conv_l" });
    const ways = q.ways_to_lower as { option: string; six_month_premium: number; saves: number }[];
    expect(ways.map((w) => w.option)).toEqual(expect.arrayContaining(["switch to the State Minimum package", "pay the six months in full"]));
    expect(ways.some((w) => w.option.includes("tort"))).toBe(false); // never a saving to pitch (review 2026-10-16)
    for (const w of ways) expect(w.six_month_premium).toBeCloseTo(q.six_month_premium - w.saves, 2);
    expect([...ways].sort((x, y) => y.saves - x.saves)).toEqual(ways);
    expect(q.next_step).toContain("ways_to_lower");
    // Re-pricing with the top option gives exactly the quoted alternative.
    await tool("set_coverage", { conversation_id: "conv_l", package: "minimum", pay_in_full: false, tort_option: "full" });
    const min = await tool("get_quote", { conversation_id: "conv_l" });
    expect(min.six_month_premium).toBe(ways.find((w) => w.option.includes("Minimum"))!.six_month_premium);
  });

  test("the cheapest setup offers nothing to lower", async () => {
    const { tool } = build();
    await upToCoverage(tool, { conversation_id: "conv_l" }, "4821 0937");
    await tool("set_coverage", { conversation_id: "conv_l", package: "minimum", pay_in_full: true, tort_option: "limited" });
    expect((await tool("get_quote", { conversation_id: "conv_l" })).ways_to_lower).toEqual([]);
  });

  test("adding the number later orders the reports and prices the quote", async () => {
    const { tool, repo } = build();
    await upToCoverage(tool, { conversation_id: "conv_l" });
    const later = await tool("save_driver", driver({ conversation_id: "conv_l" }, "4821 0937"));
    expect(later).toMatchObject({ ok: true, license_last4: "0937" });
    expect(repo.reports("conv_l").length).toBe(3);
    const q = await tool("get_quote", { conversation_id: "conv_l" });
    expect(q.ok).toBe(true);
    expect(q.six_month_premium).toBeGreaterThan(0);
  });

  test("re-saving a driver without a number never erases one already on file", async () => {
    const { tool, repo } = build();
    await upToCoverage(tool, { conversation_id: "conv_l" }, "4821 0937");
    const again = await tool("save_driver", driver({ conversation_id: "conv_l" }));
    expect(again.license_pending).toBe(false);
    expect(repo.drivers("conv_l")[0]!.license_last4).toBe("0937");
  });

  test("a call back resumes the saved quote and points straight at the missing number", async () => {
    const { tool, app } = build();
    const initiate = (id: string) => app.request("/webhooks/elevenlabs/initiation", { method: "POST", headers: { "content-type": "application/json", "x-initiation-secret": INIT }, body: JSON.stringify({ caller_id: "+12155550123", conversation_id: id }) });
    await initiate("conv_first");
    await upToCoverage(tool, { conversation_id: "conv_first" });
    const body = (await (await initiate("conv_back")).json()) as { conversation_config_override: { agent: { prompt: { prompt: string } } } };
    const code = body.conversation_config_override.agent.prompt.prompt.match(/resume_code "([A-Z0-9]+)"/)![1]!;
    const r = await tool("resume_quote", { conversation_id: "conv_back", resume_code: code, date_of_birth: "2003-05-05" });
    expect(r).toMatchObject({ ok: true, license_needed_for: ["Sam"], license_needed: [{ driver_index: 1, first_name: "Sam", license_state: "PA" }] });
    expect(r.next_step).toContain("add_license");
    expect(r.next_step).toContain("never ask those questions again");
    // Jordan's call back (2026-10-15): the number goes on the saved driver; nothing else is re-collected.
    const added = await tool("add_license", { conversation_id: "conv_back", driver_index: 1, license_number: "4821 0937" });
    expect(added).toMatchObject({ ok: true, license_needed_for: [] });
    const q = await tool("get_quote", { conversation_id: "conv_back" });
    expect(q.estimate).toBeUndefined();
    const sub = await tool("submit_application", { conversation_id: "conv_back", quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Sam", last_name: "Whitaker" });
    expect(sub).toMatchObject({ ok: true, application_number: expect.stringMatching(/^ANA-\d{7}$/) });
  });
});

// ── Dirty records: the estimate rests on the self-report, the final price on the pulled reports ──

/** New Jersey household whose license isn't handy. Prior insurance matches the seeded carrier report (14 months). */
async function njUpToCoverage(t: ReturnType<typeof build>["tool"], C: { conversation_id: string }, who: { first: string; last: string; dui?: boolean }, usage = "pleasure") {
  expect((await t("start_quote", { ...C, caller_name: `${who.first} ${who.last}`, zip: "08540", prior_insurance_months: 14 })).ok).toBe(true);
  const d = await t("save_driver", {
    ...C, driver_index: 1, first_name: who.first, last_name: who.last, date_of_birth: "1990-06-01", license_state: "NJ",
    years_licensed: 12, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: who.dui ?? false,
  });
  expect(d).toMatchObject({ ok: true, license_pending: true });
  expect((await t("save_vehicle", { ...C, vehicle_index: 1, year: 2020, make: "Toyota", model: "Camry", usage, annual_miles: 12000 })).ok).toBe(true);
  expect((await t("set_coverage", { ...C, package: "recommended", pay_in_full: false })).ok).toBe(true);
}

describe("estimate first, then a seeded driving record", () => {
  test("unreported tickets on the MVR: the final price has a hash, names the discrepancy, and is above the estimate", async () => {
    const { tool, repo } = build();
    const C = { conversation_id: "conv_dirty" };
    await njUpToCoverage(tool, C, { first: "Daniel", last: "Diaz" });
    const est = await tool("get_quote", C);
    expect(est).toMatchObject({ ok: true, eligibility: "OK", estimate: true });

    // D2…02 is Daniel Diaz in the simulated vendor: two minor violations he didn't mention.
    const added = await tool("add_license", { ...C, driver_index: 1, license_number: "D 2000 0000 0000 02" });
    expect(added).toMatchObject({ ok: true, license_last4: "0002", warnings: [], license_needed_for: [] });
    expect(repo.reports("conv_dirty").map((r) => [r.kind, r.source])).toEqual(expect.arrayContaining([["MVR", "vendor"], ["CLUE", "vendor"], ["PRIOR", "vendor"]]));

    const final = await tool("get_quote", C);
    expect(final.estimate).toBeUndefined();
    expect(final.quote_hash).toMatch(/^[0-9A-F]{10}$/);
    expect(final.discrepancies).toEqual([expect.stringContaining("Daniel: driving record shows 2 tickets")]);
    expect(final.next_step).toContain("what the reports found");
    expect(final.six_month_premium).toBeGreaterThan(est.six_month_premium);
    expect(repo.getQuote("conv_dirty")).toMatchObject({ status: "quoted", quote_hash: final.quote_hash, six_month_premium: final.six_month_premium });
  });

  test("a DUI on the MVR: the estimate was a price, the final answer is a referral with no price that can't be submitted", async () => {
    const { tool, repo } = build();
    const C = { conversation_id: "conv_refer" };
    await njUpToCoverage(tool, C, { first: "Riley", last: "Reed" });
    expect(await tool("get_quote", C)).toMatchObject({ eligibility: "OK", estimate: true });

    // R3…03 is Riley Reed: a DUI inside three years.
    expect((await tool("add_license", { ...C, driver_index: 1, license_number: "R30000000000003" })).ok).toBe(true);
    const q = await tool("get_quote", C);
    expect(q).toMatchObject({ ok: true, eligibility: "REFER", reasons: ["DUI_WITHIN_3Y"] });
    expect(q.discrepancies).toEqual(["Riley: driving record shows a DUI within 3 years that the caller did not report"]);
    expect(q.six_month_premium).toBeUndefined();
    expect(q.estimate).toBeUndefined();
    expect(q.quote_hash).toBeUndefined();
    expect(q.next_step).toContain("flag_for_human");
    expect(repo.getQuote("conv_refer")).toMatchObject({ status: "referred", quote_hash: null, six_month_premium: null });

    const sub = await tool("submit_application", { ...C, quote_hash: "ANYTHING", caller_confirmed: true, first_name: "Riley", last_name: "Reed" });
    expect(sub).toMatchObject({ ok: false, error: "REFERRED" });
    expect(repo.applicationByQuote("conv_refer")).toBeFalsy();
  });
});

describe("an estimate that underwriting would refer", () => {
  for (const [label, who, usage, reason] of [
    ["a self-reported DUI", { first: "Sam", last: "Stone", dui: true }, "pleasure", "DUI_WITHIN_3Y"],
    ["a rideshare vehicle", { first: "Sam", last: "Stone" }, "rideshare", "RIDESHARE_OR_COMMERCIAL"],
  ] as const) {
    test(`${label}: REFER with no price, no estimate flag, nothing saved, discrepancies empty`, async () => {
      const { tool, repo } = build();
      const C = { conversation_id: "conv_est_refer" };
      await njUpToCoverage(tool, C, who, usage);
      const q = await tool("get_quote", C);
      expect(q).toMatchObject({ ok: true, eligibility: "REFER", reasons: [reason], discrepancies: [] });
      expect(q.six_month_premium).toBeUndefined();
      expect(q.monthly_payment).toBeUndefined();
      expect(q.estimate).toBeUndefined();
      expect(q.quote_hash).toBeUndefined();
      expect(q.next_step).toContain("underwriting_referral");
      // Recorded as referred with no price (review 2026-10-16): a self-reported DUI or rideshare refers whatever the
      // reports say, and an open quote was offered for resume on the next call. add_license still reopens and re-rates.
      expect(repo.getQuote("conv_est_refer")).toMatchObject({ status: "referred", quote_hash: null, six_month_premium: null });
      expect(repo.reports("conv_est_refer").length).toBe(0);
    });
  }
});

describe("add_license guards", () => {
  test("refused after the caller declined recording, and on a call with no quote", async () => {
    const { tool, repo } = build();
    await upToCoverage(tool, { conversation_id: "conv_l" });
    expect((await tool("flag_for_human", { conversation_id: "conv_l", reason: "declined_recording" })).ok).toBe(true);
    expect(await tool("add_license", { conversation_id: "conv_l", driver_index: 1, license_number: "4821 0937" })).toMatchObject({ ok: false, error: "RECORDING_DECLINED" });
    expect(repo.drivers("conv_l")[0]!.license_last4).toBe("");
    expect(repo.reports("conv_l").length).toBe(0);

    expect(await tool("add_license", { conversation_id: "conv_nothing", driver_index: 1, license_number: "4821 0937" })).toMatchObject({ ok: false, error: "QUOTE_NOT_STARTED" });
    expect(repo.getQuote("conv_nothing")).toBeNull();
  });

  test("an empty number is invalid input; a blank one fails the license format; neither saves anything", async () => {
    const { tool, repo } = build();
    await upToCoverage(tool, { conversation_id: "conv_l" });
    expect(await tool("add_license", { conversation_id: "conv_l", driver_index: 1, license_number: "" })).toMatchObject({ ok: false, error: "INVALID_INPUT" });
    // Whitespace passes the schema's min length, then normalizes to nothing and fails the PA format check.
    expect(await tool("add_license", { conversation_id: "conv_l", driver_index: 1, license_number: "   " })).toMatchObject({ ok: false, error: "INVALID_LICENSE" });
    expect(repo.drivers("conv_l")[0]!.license_last4).toBe("");
    expect(repo.reports("conv_l").length).toBe(0);
  });

  test("replacing a number already on file re-pulls the reports and voids a price already given", async () => {
    const { tool, repo } = build();
    const C = { conversation_id: "conv_swap" };
    await njUpToCoverage(tool, C, { first: "Daniel", last: "Diaz" });
    // An unseeded number first: clean default reports.
    expect((await tool("add_license", { ...C, driver_index: 1, license_number: "D99999999999999" })).ok).toBe(true);
    const before = repo.drivers("conv_swap")[0]!;
    expect(repo.reports("conv_swap").every((r) => r.source === "default")).toBe(true);
    const clean = await tool("get_quote", C);
    expect(clean.quote_hash).toMatch(/^[0-9A-F]{10}$/);

    // Caller corrects the number: it's Daniel's real (seeded) one.
    const fixed = await tool("add_license", { ...C, driver_index: 1, license_number: "D20000000000002" });
    expect(fixed).toMatchObject({ ok: true, license_last4: "0002" });
    const after = repo.drivers("conv_swap")[0]!;
    expect(after.license_last4).toBe("0002");
    expect(after.license_hash).not.toBe(before.license_hash);
    expect(repo.reports("conv_swap").length).toBe(3);
    expect(repo.reports("conv_swap").every((r) => r.source === "vendor")).toBe(true);
    expect(repo.getQuote("conv_swap")).toMatchObject({ status: "open", quote_hash: null, six_month_premium: null });

    const stale = await tool("submit_application", { ...C, quote_hash: clean.quote_hash, caller_confirmed: true, first_name: "Daniel", last_name: "Diaz" });
    expect(stale).toMatchObject({ ok: false, error: "NO_CURRENT_QUOTE" });
    const repriced = await tool("get_quote", C);
    expect(repriced.six_month_premium).toBeGreaterThan(clean.six_month_premium);
    expect(repriced.quote_hash).not.toBe(clean.quote_hash);
  });

  test("a corrected license state is stored and the number is checked against the new state's format", async () => {
    const { tool, repo } = build();
    const C = { conversation_id: "conv_state" };
    await njUpToCoverage(tool, C, { first: "Daniel", last: "Diaz" });
    // A PA-format number against the NJ license on file fails; with license_state PA it passes.
    expect(await tool("add_license", { ...C, driver_index: 1, license_number: "4821 0937" })).toMatchObject({ ok: false, error: "INVALID_LICENSE" });
    expect(repo.drivers("conv_state")[0]!.license_state).toBe("NJ");
    expect(await tool("add_license", { ...C, driver_index: 1, license_state: "pa", license_number: "4821 0937" })).toMatchObject({ ok: true, license_last4: "0937" });
    expect(repo.drivers("conv_state")[0]!.license_state).toBe("PA");
    // A blank state means "keep what's on file".
    expect(await tool("add_license", { ...C, driver_index: 1, license_state: " ", license_number: "1234 5678" })).toMatchObject({ ok: true, license_last4: "5678" });
    expect(repo.drivers("conv_state")[0]!.license_state).toBe("PA");
  });
});
