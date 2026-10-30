import { describe, expect, test } from "bun:test";
import { openDb, Repo } from "../src/db";
import { createFieldCipher } from "../src/security/crypto";
import { SlidingWindowLimiter } from "../src/security/rateLimit";
import { stateConfig } from "../src/rating/rateTable";
import { createApp } from "../src/server/app";
import { QuoteService } from "../src/service";

// Whole-journey coverage of the quote line through the real HTTP tool surface, in call order.
// The core property: a caller who drops at ANY point and calls back loses nothing, is never asked
// for what's already saved, and ends on exactly the price an uninterrupted call would have given.
// Field cases (2026-10-15): Jordan dropped for missing licenses and re-gave everything on the call back;
// Sean hung up when a missing license blocked any price.

const SECRET = "test-secret-test-secret-123456";
const INIT = "initiation-secret-initiation-secret";
const PHONE = "+12155550199";
type Body = Record<string, unknown>;
type Step = [tool: string, body: Body];

function build(nowRef: { t: Date } = { t: new Date("2026-10-15T15:00:00Z") }) {
  const repo = new Repo(openDb(":memory:"), createFieldCipher(Buffer.alloc(32, 9).toString("base64")));
  const service = new QuoteService({ repo, now: () => nowRef.t, decode: async () => ({ decoded: null, source: "timeout" }), licenseKey: "journey-key" });
  const app = createApp({ repo, service, toolSecret: SECRET, initiationSecret: INIT, limiter: new SlidingWindowLimiter(), now: () => nowRef.t, fetchMeta: async () => null, fetchTranscript: async () => null, log: () => {} });
  const tool = async (name: string, body: Body) =>
    (await (await app.request(`/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": SECRET }, body: JSON.stringify(body) })).json()) as Record<string, any>;
  /** The call-start webhook: binds the number to the conversation; returns the resume code when one is offered. */
  const initiate = async (conversationId: string, callerId = PHONE): Promise<string | null> => {
    const res = await app.request("/webhooks/elevenlabs/initiation", {
      method: "POST",
      headers: { "content-type": "application/json", "x-initiation-secret": INIT },
      body: JSON.stringify({ caller_id: callerId, agent_id: "agent_x", called_number: "+16095550100", call_sid: "CA1", conversation_id: conversationId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation_config_override?: { agent: { prompt: { prompt: string } } } };
    return body.conversation_config_override?.agent.prompt.prompt.match(/resume_code "([A-Z0-9]+)"/)?.[1] ?? null;
  };
  /** Runs steps in order on one conversation; every step must succeed. Returns the last get_quote result. */
  const run = async (conversationId: string, steps: Step[]) => {
    let last: Record<string, any> | null = null;
    for (const [name, body] of steps) {
      const r = await tool(name, { conversation_id: conversationId, ...body });
      expect({ step: name, ok: r.ok, error: r.error }).toEqual({ step: name, ok: true, error: undefined });
      if (name === "get_quote") last = r;
    }
    return last;
  };
  return { repo, tool, initiate, run, nowRef };
}
type H = ReturnType<typeof build>;

// ── Households ────────────────────────────────────────────────────────────────────────────────

/** Pennsylvania: two drivers, two vehicles. Licenses are unseeded numbers, so reports come back clean. */
function paSteps(licenses: boolean): Step[] {
  return [
    ["start_quote", { caller_name: "Jordan Reyes", zip: "18940", prior_insurance_months: 300 }],
    ["save_driver", { driver_index: 1, first_name: "Jordan", last_name: "Reyes", date_of_birth: "1971-05-14", license_state: "PA", ...(licenses ? { license_number: "4821 0937" } : {}), years_licensed: 35, tickets_3y: 4, at_fault_accidents_3y: 1, dui_3y: false }],
    ["save_driver", { driver_index: 2, first_name: "Casey", last_name: "Reyes", date_of_birth: "1994-06-11", license_state: "PA", ...(licenses ? { license_number: "4455 6677" } : {}), years_licensed: 10, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false }],
    ["save_vehicle", { vehicle_index: 1, year: 2022, make: "Chevrolet", model: "Suburban", usage: "pleasure", annual_miles: 12000 }],
    ["save_vehicle", { vehicle_index: 2, year: 2019, make: "Honda", model: "Civic", usage: "commute", annual_miles: 9000 }],
    ["set_coverage", { package: "minimum", pay_in_full: false, tort_option: "limited" }],
    ["get_quote", {}],
  ];
}
const JORDAN_DOB = "1971-05-14";

/** Michigan: PIP opt-out with eligibility confirmed, garaging city drives the territory. */
const MI_STEPS: Step[] = [
  ["start_quote", { caller_name: "Dana Brooks", zip: "48226", prior_insurance_months: 24, garaging_city: "Detroit" }],
  ["save_driver", { driver_index: 1, first_name: "Dana", last_name: "Brooks", date_of_birth: "1958-04-12", license_state: "MI", license_number: "B 123 456 789 012", years_licensed: 45, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false }],
  ["save_vehicle", { vehicle_index: 1, year: 2018, make: "Ford", model: "Escape", usage: "pleasure", annual_miles: 6000 }],
  ["set_coverage", { package: "recommended", pay_in_full: true, pip_medical: "opt_out", pip_confirmed: true }],
  ["get_quote", {}],
];

/** Everything that defines a quote's content, minus identity, timestamps and pricing state. */
function snapshot(h: H, id: string) {
  const q = h.repo.getQuote(id)!;
  const strip = <T extends object>(row: T) => Object.fromEntries(Object.entries(row).filter(([k]) => !["id", "quote_id", "created_at", "updated_at"].includes(k)));
  return {
    quote: {
      caller_name: q.caller_name, zip: q.zip, state: q.state, territory: q.territory, prior_insurance_months: q.prior_insurance_months,
      package: q.package, pay_in_full: q.pay_in_full, tort_option: q.tort_option, garaging_city: q.garaging_city ?? null,
      pip_medical: q.pip_medical ?? null, pip_confirmed_at: q.pip_confirmed_at ?? null,
      // The caller's number rides along, so the next call back from it still finds this quote.
      caller_hash: q.caller_hash ?? null, caller_phone: q.caller_phone ?? null,
    },
    drivers: h.repo.drivers(id).map(strip),
    vehicles: h.repo.vehicles(id).map(strip),
    reports: h.repo.reports(id).map(strip),
  };
}

async function submit(h: H, id: string, quoteHash: string, first = "Jordan", last = "Reyes") {
  return h.tool("submit_application", { conversation_id: id, quote_hash: quoteHash, caller_confirmed: true, first_name: first, last_name: last });
}

/** One uninterrupted call: the price every interrupted journey must land on. */
async function baselinePremium(steps: Step[]): Promise<number> {
  const h = build();
  await h.initiate("conv_base");
  const q = await h.run("conv_base", steps);
  return q!.six_month_premium;
}

// ── Drop at every point, call back, finish ───────────────────────────────────────────────────

describe("a caller can drop after any saved step, call back, and finish with nothing lost", async () => {
  const steps = paSteps(true);
  const expectedPremium = await baselinePremium(steps);
  // After k completed tool calls the caller hangs up. Where the call back must pick up:
  const resumeAt: Record<number, string> = { 2: "other_drivers", 3: "other_drivers", 4: "coverage", 5: "coverage", 6: "price", 7: "price" };
  // What the agent is told to do next, per branch (licenses are all on file here).
  const nextFor: Record<number, string[]> = {
    2: ["summarize what's on file", "anyone else in the household drives besides Jordan, and continue"],
    3: ["summarize what's on file", "anyone else in the household drives besides Jordan and Casey"],
    4: ["summarize what's on file", "continue with the coverage step"],
    5: ["summarize what's on file", "continue with the coverage step"],
    6: ["re-checking their price", "Then call get_quote."],
    7: ["re-checking their price", "Then call get_quote."],
  };

  for (let k = 2; k <= steps.length; k++) {
    test(`drop after ${k} of ${steps.length} (${steps[k - 1]![0]}): resumes at ${resumeAt[k]}, all data carried, same final price`, async () => {
      const h = build();
      await h.initiate("conv_1");
      await h.run("conv_1", steps.slice(0, k));
      const saved = snapshot(h, "conv_1");

      const code = await h.initiate("conv_2");
      expect(code).not.toBeNull();
      const r = await h.tool("resume_quote", { conversation_id: "conv_2", resume_code: code, date_of_birth: JORDAN_DOB });
      expect(r.ok).toBe(true);
      expect(r.resume_at).toBe(resumeAt[k]);
      expect(r.next_step).toContain("never ask those questions again");
      for (const s of nextFor[k]!) expect(r.next_step).toContain(s);
      expect(r.next_step).not.toContain("add_license");
      expect(r.license_needed_for).toEqual([]);
      // Every saved answer, driver, vehicle, coverage choice, pulled report and the caller's number comes across byte for byte.
      expect(saved.quote.caller_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(saved.quote.caller_phone).toBe(PHONE);
      expect(snapshot(h, "conv_2")).toEqual(saved);
      expect(h.repo.getQuote("conv_1")!.resumed_into).toBe("conv_2");
      // What the agent needs to carry on without calling start_quote again.
      expect(r.packages_sentence).toBe(stateConfig("PA").packagesSentence);
      expect(r.tort_choice_required).toBe(true);
      expect(r.pip_choice_required).toBe(false);

      // Finish only the steps that weren't done. A priced quote is always re-priced on the new call.
      const rest = steps.slice(k);
      const last = await h.run("conv_2", rest.length ? rest : [["get_quote", {}]]);
      expect(last!.six_month_premium).toBe(expectedPremium);
      const app = await submit(h, "conv_2", last!.quote_hash);
      expect(app.ok).toBe(true);
      expect(h.repo.getQuote("conv_2")!.status).toBe("applied");
    });
  }

  test("drop right after start_quote: nothing to verify the caller against, so it isn't offered and they start fresh", async () => {
    const h = build();
    await h.initiate("conv_1");
    await h.run("conv_1", steps.slice(0, 1));
    expect(await h.initiate("conv_2")).toBeNull();
    const last = await h.run("conv_2", steps);
    expect(last!.six_month_premium).toBe(expectedPremium);
  });

  test("a priced quote must be re-priced after resuming: the old quote_hash can't be submitted", async () => {
    const h = build();
    await h.initiate("conv_1");
    const first = await h.run("conv_1", steps);
    const code = await h.initiate("conv_2");
    await h.tool("resume_quote", { conversation_id: "conv_2", resume_code: code, date_of_birth: JORDAN_DOB });
    const stale = await submit(h, "conv_2", first!.quote_hash);
    expect(stale).toMatchObject({ ok: false, error: "NO_CURRENT_QUOTE" });
    expect(h.repo.applicationByQuote("conv_2")).toBeFalsy();
    const fresh = await h.run("conv_2", [["get_quote", {}]]);
    expect(fresh!.six_month_premium).toBe(first!.six_month_premium);
    expect((await submit(h, "conv_2", fresh!.quote_hash)).ok).toBe(true);
  });
});

// ── Missing licenses: estimate, drop, call back, add_license, final price ─────────────────────

describe("licenses not handy: estimate on the first call, numbers added on the call back", async () => {
  const licensedPremium = await baselinePremium(paSteps(true));

  test("first call ends on an estimate that is saved for nothing and can't be submitted", async () => {
    const h = build();
    await h.initiate("conv_1");
    const est = await h.run("conv_1", paSteps(false));
    expect(est).toMatchObject({ estimate: true, license_needed_for: ["Jordan", "Casey"] });
    expect(est!.quote_hash).toBeUndefined();
    expect(h.repo.getQuote("conv_1")).toMatchObject({ status: "open", six_month_premium: null, quote_hash: null });
    expect((await submit(h, "conv_1", "ANYTHING")).error).toBe("LICENSE_NEEDED");
  });

  test("the estimate equals the final price when the record comes back clean", async () => {
    const h = build();
    await h.initiate("conv_1");
    const est = await h.run("conv_1", paSteps(false));
    expect(est!.six_month_premium).toBe(licensedPremium);
  });

  test("call back: only the license numbers are asked for, the rest is untouched, and the final price matches", async () => {
    const h = build();
    await h.initiate("conv_1");
    await h.run("conv_1", paSteps(false));
    const before = snapshot(h, "conv_1");

    const code = await h.initiate("conv_2");
    const r = await h.tool("resume_quote", { conversation_id: "conv_2", resume_code: code, date_of_birth: JORDAN_DOB });
    expect(r).toMatchObject({
      ok: true,
      resume_at: "price",
      license_needed: [
        { driver_index: 1, first_name: "Jordan", license_state: "PA" },
        { driver_index: 2, first_name: "Casey", license_state: "PA" },
      ],
    });
    expect(r.next_step).toContain("First ask for each missing license number");
    expect(r.next_step).toContain("add_license");
    // Priced before, but the licenses come first: no "re-checking your price" greeting.
    expect(r.next_step).toContain("summarize what's on file");
    expect(r.next_step).not.toContain("re-checking their price");
    expect(r.next_step).toContain("Then call get_quote.");

    const a1 = await h.tool("add_license", { conversation_id: "conv_2", driver_index: 1, license_number: "4821 0937" });
    expect(a1).toMatchObject({ ok: true, license_needed_for: ["Casey"] });
    // Pricing in between still gives an estimate for whoever is missing.
    expect((await h.tool("get_quote", { conversation_id: "conv_2" })).license_needed_for).toEqual(["Casey"]);
    const a2 = await h.tool("add_license", { conversation_id: "conv_2", driver_index: 2, license_number: "4455 6677" });
    expect(a2).toMatchObject({ ok: true, license_needed_for: [] });

    // Self-reported history, names, DOBs and years licensed are exactly what the first call saved.
    const after = snapshot(h, "conv_2");
    const answers = (s: typeof before) => s.drivers.map((d) => ({ ...d, license_hash: undefined, license_last4: undefined }));
    expect(answers(after)).toEqual(answers(before));
    expect(after.vehicles).toEqual(before.vehicles);
    expect(after.quote).toEqual(before.quote);
    expect(after.reports.length).toBe(6);

    const final = await h.run("conv_2", [["get_quote", {}]]);
    expect(final!.estimate).toBeUndefined();
    expect(final!.six_month_premium).toBe(licensedPremium);
    expect((await submit(h, "conv_2", final!.quote_hash)).ok).toBe(true);
  });

  test("still no license on the call back: they get the estimate again and everything stays saved for the next one", async () => {
    const h = build();
    await h.initiate("conv_1");
    await h.run("conv_1", paSteps(false));
    const code = await h.initiate("conv_2");
    await h.tool("resume_quote", { conversation_id: "conv_2", resume_code: code, date_of_birth: JORDAN_DOB });
    const est = await h.run("conv_2", [["get_quote", {}]]);
    expect(est!.estimate).toBe(true);
    const code3 = await h.initiate("conv_3");
    expect(code3).not.toBeNull();
    const r = await h.tool("resume_quote", { conversation_id: "conv_3", resume_code: code3, date_of_birth: JORDAN_DOB });
    expect(r.license_needed_for).toEqual(["Jordan", "Casey"]);
    expect(snapshot(h, "conv_3")).toEqual(snapshot(h, "conv_1"));
  });
});

// ── Several drops in a row ───────────────────────────────────────────────────────────────────

test("three calls: whatever the second call saved before dropping is there on the third", async () => {
  const steps = paSteps(true);
  const expected = await baselinePremium(steps);
  const h = build();
  await h.initiate("conv_1");
  await h.run("conv_1", steps.slice(0, 2)); // start + Jordan

  const c2 = await h.initiate("conv_2");
  expect((await h.tool("resume_quote", { conversation_id: "conv_2", resume_code: c2, date_of_birth: JORDAN_DOB })).resume_at).toBe("other_drivers");
  await h.run("conv_2", steps.slice(2, 4)); // Casey + the Suburban, then drop

  const c3 = await h.initiate("conv_3");
  const r = await h.tool("resume_quote", { conversation_id: "conv_3", resume_code: c3, date_of_birth: JORDAN_DOB });
  expect(r).toMatchObject({ ok: true, drivers: ["Jordan", "Casey"], vehicles: ["2022 CHEVROLET Suburban"], resume_at: "coverage" });
  expect(snapshot(h, "conv_3")).toEqual(snapshot(h, "conv_2"));
  expect(h.repo.getQuote("conv_2")!.resumed_into).toBe("conv_3");

  const last = await h.run("conv_3", steps.slice(4));
  expect(last!.six_month_premium).toBe(expected);
  expect((await submit(h, "conv_3", last!.quote_hash)).ok).toBe(true);
});

// ── Michigan: PIP election, confirmation and city survive a drop ─────────────────────────────

describe("Michigan journeys", async () => {
  const expected = await baselinePremium(MI_STEPS);

  test("drop after a confirmed PIP opt-out: election, confirmation time and city carry over; price matches", async () => {
    const h = build();
    await h.initiate("conv_1");
    await h.run("conv_1", MI_STEPS.slice(0, 4));
    const saved = snapshot(h, "conv_1");
    expect(saved.quote).toMatchObject({ pip_medical: "opt_out", garaging_city: "Detroit" });
    expect(saved.quote.pip_confirmed_at).toBeTruthy();

    const code = await h.initiate("conv_2");
    const r = await h.tool("resume_quote", { conversation_id: "conv_2", resume_code: code, date_of_birth: "1958-04-12" });
    expect(r).toMatchObject({ ok: true, resume_at: "price", garaging_city: "Detroit", pip_choice_required: true });
    expect(snapshot(h, "conv_2")).toEqual(saved);
    const last = await h.run("conv_2", [["get_quote", {}]]);
    expect(last!.six_month_premium).toBe(expected);
  });

  test("drop in the middle of the PIP eligibility check: nothing was recorded, so the call back resumes at coverage", async () => {
    const h = build();
    await h.initiate("conv_1");
    await h.run("conv_1", MI_STEPS.slice(0, 3));
    const check = await h.tool("set_coverage", { conversation_id: "conv_1", package: "recommended", pay_in_full: true, pip_medical: "opt_out" });
    expect(check.error).toBe("PIP_ELIGIBILITY_CHECK");

    const code = await h.initiate("conv_2");
    const r = await h.tool("resume_quote", { conversation_id: "conv_2", resume_code: code, date_of_birth: "1958-04-12" });
    expect(r).toMatchObject({ ok: true, resume_at: "coverage", pip_medical: null });
    const last = await h.run("conv_2", MI_STEPS.slice(3));
    expect(last!.six_month_premium).toBe(expected);
  });
});

// ── Who gets offered a saved quote ───────────────────────────────────────────────────────────

describe("which saved quote a returning number is offered", () => {
  test("starting a new quote instead: the newest unfinished one is offered next time", async () => {
    const h = build();
    await h.initiate("conv_1");
    await h.run("conv_1", paSteps(true).slice(0, 2));
    expect(await h.initiate("conv_2")).not.toBeNull();
    // Caller chose "start a new one" and gave someone else's details this time.
    await h.run("conv_2", [
      ["start_quote", { caller_name: "Casey Reyes", zip: "18940", prior_insurance_months: 60 }],
      ["save_driver", { driver_index: 1, first_name: "Casey", last_name: "Reyes", date_of_birth: "1994-06-11", license_state: "PA", license_number: "4455 6677", years_licensed: 10, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false }],
    ]);
    const code = await h.initiate("conv_3");
    const r = await h.tool("resume_quote", { conversation_id: "conv_3", resume_code: code, date_of_birth: "1994-06-11" });
    expect(r).toMatchObject({ ok: true, first_name: "Casey" });
  });

  test("an applied quote is never offered again", async () => {
    const h = build();
    await h.initiate("conv_1");
    const q = await h.run("conv_1", paSteps(true));
    expect((await submit(h, "conv_1", q!.quote_hash)).ok).toBe(true);
    expect(await h.initiate("conv_2")).toBeNull();
  });

  test("a quote handed to a licensed agent is never offered again", async () => {
    const h = build();
    await h.initiate("conv_1");
    await h.run("conv_1", paSteps(true).slice(0, 3));
    expect((await h.tool("flag_for_human", { conversation_id: "conv_1", reason: "caller_requested", summary: "wants a person" })).ok).toBe(true);
    expect(await h.initiate("conv_2")).toBeNull();
  });

  test("a different phone number is never offered someone else's quote", async () => {
    const h = build();
    await h.initiate("conv_1");
    await h.run("conv_1", paSteps(true).slice(0, 4));
    expect(await h.initiate("conv_2", "+12155550100")).toBeNull();
  });

  test("after 30 days the saved quote is no longer offered", async () => {
    const h = build();
    await h.initiate("conv_1");
    await h.run("conv_1", paSteps(true).slice(0, 4));
    // No created_at pinning: the service stamps it from the test clock (test/clock.test.ts guards that).
    h.nowRef.t = new Date("2026-11-15T15:00:00Z");
    expect(await h.initiate("conv_2")).toBeNull();
  });

  test("a wrong date of birth reveals nothing, and the third miss locks the code", async () => {
    const h = build();
    await h.initiate("conv_1");
    await h.run("conv_1", paSteps(true).slice(0, 4));
    const code = await h.initiate("conv_2");
    for (const expected of ["DOB_MISMATCH", "DOB_MISMATCH", "RESUME_LOCKED"]) {
      const r = await h.tool("resume_quote", { conversation_id: "conv_2", resume_code: code, date_of_birth: "1980-01-01" });
      expect(r).toEqual({ ok: false, error: expected, hint: expect.any(String) });
    }
    expect((await h.tool("resume_quote", { conversation_id: "conv_2", resume_code: code, date_of_birth: JORDAN_DOB })).error).toBe("RESUME_LOCKED");
    expect(h.repo.drivers("conv_2")).toEqual([]);
  });
});

// ── A dirty driving record survives a drop: the reports pulled on call one price call two ─────

/** New Jersey: Daniel Diaz's seeded license (D2…02) carries two tickets he doesn't mention. */
const DIRTY_NJ: Step[] = [
  ["start_quote", { caller_name: "Daniel Diaz", zip: "08540", prior_insurance_months: 14 }],
  ["save_driver", { driver_index: 1, first_name: "Daniel", last_name: "Diaz", date_of_birth: "1990-06-01", license_state: "NJ", license_number: "D20000000000002", years_licensed: 12, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false }],
  ["save_vehicle", { vehicle_index: 1, year: 2020, make: "Toyota", model: "Camry", usage: "commute", annual_miles: 11000 }],
  ["set_coverage", { package: "recommended", pay_in_full: false }],
  ["get_quote", {}],
];
const DIAZ_DOB = "1990-06-01";

describe("a seeded dirty record carries across a drop", async () => {
  const dirty = await baselinePremium(DIRTY_NJ);
  // Same household and self-report on an unseeded number: what the price would be if the reports were lost.
  const clean = await baselinePremium(DIRTY_NJ.map(([n, b]): Step => [n, n === "save_driver" ? { ...b, license_number: "D99999999999999" } : b]));

  test("the reports change the price (otherwise this matrix would prove nothing)", () => {
    expect(dirty).toBeGreaterThan(clean);
  });

  for (const k of [2, 3, 4, 5]) {
    test(`drop after ${k} (${DIRTY_NJ[k - 1]![0]}): the call back prices on the carried MVR, with the discrepancy`, async () => {
      const h = build();
      await h.initiate("conv_1");
      await h.run("conv_1", DIRTY_NJ.slice(0, k));
      const code = await h.initiate("conv_2");
      const r = await h.tool("resume_quote", { conversation_id: "conv_2", resume_code: code, date_of_birth: DIAZ_DOB });
      expect(r).toMatchObject({ ok: true, license_needed_for: [] });
      expect(h.repo.reports("conv_2").map((x) => [x.kind, x.source]).sort()).toEqual([["CLUE", "vendor"], ["MVR", "vendor"], ["PRIOR", "vendor"]]);
      const rest = DIRTY_NJ.slice(k);
      const last = await h.run("conv_2", rest.length ? rest : [["get_quote", {}]]);
      expect(last!.six_month_premium).toBe(dirty);
      expect(last!.discrepancies).toEqual([expect.stringContaining("Daniel: driving record shows 2 tickets")]);
      expect((await submit(h, "conv_2", last!.quote_hash, "Daniel", "Diaz")).ok).toBe(true);
    });
  }

  test("New Jersey resume: no tort or PIP choice is asked for, and the NJ packages are offered", async () => {
    const h = build();
    await h.initiate("conv_1");
    await h.run("conv_1", DIRTY_NJ.slice(0, 3));
    const code = await h.initiate("conv_2");
    const r = await h.tool("resume_quote", { conversation_id: "conv_2", resume_code: code, date_of_birth: DIAZ_DOB });
    expect(r).toMatchObject({ ok: true, state: "New Jersey", resume_at: "coverage", tort_choice_required: false, pip_choice_required: false, tort_option: null });
    expect(r.packages_sentence).toBe(stateConfig("NJ").packagesSentence);
    expect(r).not.toHaveProperty("garaging_city");
    expect(r).not.toHaveProperty("pip_medical");
  });
});

// ── Licenses pending AND no vehicles yet ──────────────────────────────────────────────────────

test("drop with both drivers saved without licenses and no vehicles: resumes at other drivers and asks for the licenses first", async () => {
  const h = build();
  await h.initiate("conv_1");
  await h.run("conv_1", paSteps(false).slice(0, 3));
  const code = await h.initiate("conv_2");
  const r = await h.tool("resume_quote", { conversation_id: "conv_2", resume_code: code, date_of_birth: JORDAN_DOB });
  expect(r).toMatchObject({ ok: true, resume_at: "other_drivers", vehicles: [], license_needed_for: ["Jordan", "Casey"], package: null });
  expect(r.next_step).toContain("summarize what's on file");
  expect(r.next_step).toContain("First ask for each missing license number");
  expect(r.next_step).toContain("anyone else in the household drives besides Jordan and Casey");
  // Licenses before the household question.
  expect(r.next_step.indexOf("add_license")).toBeLessThan(r.next_step.indexOf("anyone else"));
});
