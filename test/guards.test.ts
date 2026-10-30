import { describe, expect, test } from "bun:test";
import { openDb, Repo } from "../src/db";
import { createFieldCipher } from "../src/security/crypto";
import { SlidingWindowLimiter } from "../src/security/rateLimit";
import { createApp } from "../src/server/app";
import { QuoteService, type ServiceDeps } from "../src/service";

// State guards found in the 2026-10-16 code audit, driven through the real HTTP tool surface.
// Each describe names the bug it pins; every assertion checks the specific error code, not just ok:false.

const SECRET = "test-secret-test-secret-123456";
const INIT = "initiation-secret-initiation-secret";
const PHONE = "+12155550199";
type Body = Record<string, unknown>;
type Step = [tool: string, body: Body];

function build(o: { decode?: ServiceDeps["decode"]; toolTimeoutMs?: number; appNumber?: () => string } = {}) {
  const nowRef = { t: new Date("2026-10-15T15:00:00Z") };
  const repo = new Repo(openDb(":memory:"), createFieldCipher(Buffer.alloc(32, 9).toString("base64")));
  const service = new QuoteService({
    repo,
    now: () => nowRef.t,
    decode: o.decode ?? (async () => ({ decoded: null, source: "timeout" })),
    licenseKey: "guards-key",
    ...(o.appNumber ? { appNumber: o.appNumber } : {}),
  });
  const app = createApp({
    repo, service, toolSecret: SECRET, initiationSecret: INIT, limiter: new SlidingWindowLimiter(), now: () => nowRef.t,
    fetchMeta: async () => null, fetchTranscript: async () => null, log: () => {}, ...(o.toolTimeoutMs ? { toolTimeoutMs: o.toolTimeoutMs } : {}),
  });
  const tool = async (name: string, body: Body) =>
    (await (await app.request(`/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": SECRET }, body: JSON.stringify(body) })).json()) as Record<string, any>;
  /** The call-start webhook; returns the resume code when a saved quote is offered. */
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
  const run = async (conversationId: string, steps: Step[]) => {
    let last: Record<string, any> | null = null;
    for (const [name, body] of steps) {
      const r = await tool(name, { conversation_id: conversationId, ...body });
      expect({ step: name, ok: r.ok, error: r.error }).toEqual({ step: name, ok: true, error: undefined });
      if (name === "get_quote") last = r;
    }
    return last;
  };
  return { repo, service, tool, initiate, run, nowRef };
}
type H = ReturnType<typeof build>;

const JORDAN_DOB = "1971-05-14";
const PA_STEPS: Step[] = [
  ["start_quote", { caller_name: "Jordan Reyes", zip: "18940", prior_insurance_months: 300 }],
  ["save_driver", { driver_index: 1, first_name: "Jordan", last_name: "Reyes", date_of_birth: JORDAN_DOB, license_state: "PA", license_number: "4821 0937", years_licensed: 35, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false }],
  ["save_vehicle", { vehicle_index: 1, year: 2019, make: "Honda", model: "Civic", usage: "commute", annual_miles: 9000 }],
  ["set_coverage", { package: "recommended", pay_in_full: false, tort_option: "full" }],
  ["get_quote", {}],
];

async function applied(h: H, id: string) {
  await h.initiate(id);
  const q = await h.run(id, PA_STEPS);
  const app = await h.tool("submit_application", { conversation_id: id, quote_hash: q!.quote_hash, caller_confirmed: true, first_name: "Jordan", last_name: "Reyes" });
  expect(app.ok).toBe(true);
  return { quote: q!, app };
}

// ── 1. get_quote after an application ─────────────────────────────────────────────────────────

describe("bug 1: get_quote on an applied quote", () => {
  test("returns ALREADY_APPLIED with the application number and leaves the quote applied", async () => {
    const h = build();
    const { quote, app } = await applied(h, "conv_1");
    const r = await h.tool("get_quote", { conversation_id: "conv_1" });
    expect(r).toMatchObject({ ok: false, error: "ALREADY_APPLIED", application_number: app.application_number });
    const q = h.repo.getQuote("conv_1")!;
    expect(q.status).toBe("applied");
    expect(q.quote_hash).toBe(quote.quote_hash);
  });

  test("the guard holds for every later tool, and the call back offers nothing (no second application)", async () => {
    const h = build();
    await applied(h, "conv_1");
    await h.tool("get_quote", { conversation_id: "conv_1" });
    for (const [name, body] of PA_STEPS.slice(1, 4)) {
      expect(`${name}:${(await h.tool(name, { conversation_id: "conv_1", ...body })).error}`).toBe(`${name}:ALREADY_APPLIED`);
    }
    expect(await h.initiate("conv_2")).toBeNull();
  });

  test("defense in depth: saveRated never touches an applied row", async () => {
    const h = build();
    const { quote } = await applied(h, "conv_1");
    h.repo.saveRated("conv_1", { status: "quoted", quoteHash: "XXXXXXXXXX", sixMonthPremium: 1, monthlyPayment: 1, ratingJson: null, eligibilityJson: "{}" });
    expect(h.repo.getQuote("conv_1")).toMatchObject({ status: "applied", quote_hash: quote.quote_hash });
  });
});

// ── 2. start_quote after an application ───────────────────────────────────────────────────────

describe("bug 2: start_quote on an applied quote", () => {
  test("returns ALREADY_APPLIED and rewrites nothing", async () => {
    const h = build();
    await applied(h, "conv_1");
    const before = h.repo.getQuote("conv_1")!;
    const r = await h.tool("start_quote", { conversation_id: "conv_1", caller_name: "Someone Else", zip: "08540", prior_insurance_months: 1 });
    expect(r).toMatchObject({ ok: false, error: "ALREADY_APPLIED" });
    expect(h.repo.getQuote("conv_1")).toMatchObject({ caller_name: before.caller_name, zip: before.zip, state: before.state, territory: before.territory, status: "applied" });
  });
});

// ── 3. resume_quote over a conversation that already has data ─────────────────────────────────

describe("bug 3: resume_quote never clobbers data already saved on this call", () => {
  async function savedThenCallBack(h: H) {
    await h.initiate("conv_1");
    await h.run("conv_1", PA_STEPS.slice(0, 3));
    const code = await h.initiate("conv_2");
    expect(code).not.toBeNull();
    return code!;
  }

  test("a driver already saved on this call: RESUME_UNAVAILABLE, nothing deleted, no attempt burned, code still usable", async () => {
    const h = build();
    const code = await savedThenCallBack(h);
    await h.run("conv_2", [
      ["start_quote", { caller_name: "Casey Reyes", zip: "08540", prior_insurance_months: 12 }],
      ["save_driver", { driver_index: 1, first_name: "Casey", last_name: "Reyes", date_of_birth: "1994-06-11", license_state: "NJ", years_licensed: 10, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false }],
    ]);
    const r = await h.tool("resume_quote", { conversation_id: "conv_2", resume_code: code, date_of_birth: JORDAN_DOB });
    expect(r).toMatchObject({ ok: false, error: "RESUME_UNAVAILABLE" });
    expect(r.hint).toContain("already");
    expect(h.repo.drivers("conv_2").map((d) => d.first_name)).toEqual(["Casey"]);
    expect(h.repo.getQuote("conv_2")).toMatchObject({ zip: "08540", state: "NJ" });
    expect(h.repo.resumeToken(code)).toMatchObject({ failed_attempts: 0, used_at: null });
    expect(h.repo.getQuote("conv_1")!.resumed_into).toBeNull();
  });

  test("a vehicle already saved on this call: RESUME_UNAVAILABLE", async () => {
    const h = build();
    const code = await savedThenCallBack(h);
    await h.run("conv_2", [
      ["start_quote", { caller_name: "Jordan Reyes", zip: "18940", prior_insurance_months: 300 }],
      ["save_vehicle", { vehicle_index: 1, year: 2022, make: "Chevrolet", model: "Suburban", usage: "pleasure", annual_miles: 12000 }],
    ]);
    expect((await h.tool("resume_quote", { conversation_id: "conv_2", resume_code: code, date_of_birth: JORDAN_DOB })).error).toBe("RESUME_UNAVAILABLE");
    expect(h.repo.vehicles("conv_2").map((v) => v.model)).toEqual(["Suburban"]);
  });

  test("an application already on this call: RESUME_UNAVAILABLE and the application's quote is untouched", async () => {
    const h = build();
    const code = await savedThenCallBack(h);
    const q = await h.run("conv_2", PA_STEPS);
    expect((await h.tool("submit_application", { conversation_id: "conv_2", quote_hash: q!.quote_hash, caller_confirmed: true, first_name: "Jordan", last_name: "Reyes" })).ok).toBe(true);
    expect((await h.tool("resume_quote", { conversation_id: "conv_2", resume_code: code, date_of_birth: JORDAN_DOB })).error).toBe("RESUME_UNAVAILABLE");
    expect(h.repo.getQuote("conv_2")).toMatchObject({ status: "applied", quote_hash: q!.quote_hash });
    expect(h.repo.vehicles("conv_2").length).toBe(1);
  });

  test("only start_quote on this call (no driver or vehicle yet): the resume still goes through", async () => {
    const h = build();
    const code = await savedThenCallBack(h);
    await h.run("conv_2", [["start_quote", { caller_name: "Jordan Reyes", zip: "18940", prior_insurance_months: 300 }]]);
    const r = await h.tool("resume_quote", { conversation_id: "conv_2", resume_code: code, date_of_birth: JORDAN_DOB });
    expect(r.ok).toBe(true);
    expect(h.repo.drivers("conv_2").map((d) => d.first_name)).toEqual(["Jordan"]);
  });
});

// ── 4. Transfers are sticky ───────────────────────────────────────────────────────────────────

describe("bug 4: a quote handed to a human stays handed off", () => {
  test("get_quote after flag_for_human returns TRANSFERRED, keeps status transferred, and the call back offers nothing", async () => {
    const h = build();
    await h.initiate("conv_1");
    await h.run("conv_1", PA_STEPS.slice(0, 4));
    expect((await h.tool("flag_for_human", { conversation_id: "conv_1", reason: "caller_requested", summary: "wants a person" })).ok).toBe(true);
    const r = await h.tool("get_quote", { conversation_id: "conv_1" });
    expect(r).toMatchObject({ ok: false, error: "TRANSFERRED" });
    expect(r.six_month_premium).toBeUndefined();
    expect(h.repo.getQuote("conv_1")).toMatchObject({ status: "transferred", transfer_reason: "caller_requested", quote_hash: null });
    expect(await h.initiate("conv_2")).toBeNull();
  });

  test("a quote priced before the hand-off can't be submitted after it", async () => {
    const h = build();
    await h.initiate("conv_1");
    const q = await h.run("conv_1", PA_STEPS);
    await h.tool("flag_for_human", { conversation_id: "conv_1", reason: "coverage_advice", summary: "asked which package" });
    const r = await h.tool("submit_application", { conversation_id: "conv_1", quote_hash: q!.quote_hash, caller_confirmed: true, first_name: "Jordan", last_name: "Reyes" });
    expect(r).toMatchObject({ ok: false, error: "NO_CURRENT_QUOTE" });
    expect(h.repo.applicationByQuote("conv_1")).toBeNull();
    expect(await h.initiate("conv_2")).toBeNull();
  });

  test("defense in depth: saveRated never un-transfers a quote", async () => {
    const h = build();
    await h.run("conv_1", PA_STEPS.slice(0, 4));
    await h.tool("flag_for_human", { conversation_id: "conv_1", reason: "complaint" });
    h.repo.saveRated("conv_1", { status: "quoted", quoteHash: "XXXXXXXXXX", sixMonthPremium: 1, monthlyPayment: 1, ratingJson: null, eligibilityJson: "{}" });
    expect(h.repo.getQuote("conv_1")).toMatchObject({ status: "transferred", quote_hash: null });
  });

  test("a later flag_for_human never overwrites declined_recording (the post-call callback alert keys on it)", async () => {
    const h = build();
    expect((await h.tool("flag_for_human", { conversation_id: "conv_1", reason: "declined_recording", summary: "no recording" })).ok).toBe(true);
    await h.tool("flag_for_human", { conversation_id: "conv_1", reason: "caller_requested", summary: "wants a person" });
    expect(h.repo.getQuote("conv_1")).toMatchObject({ status: "transferred", transfer_reason: "declined_recording", consent_status: "declined" });
  });

  test("other reasons still update: the latest hand-off reason wins", async () => {
    const h = build();
    await h.tool("flag_for_human", { conversation_id: "conv_1", reason: "out_of_state" });
    await h.tool("flag_for_human", { conversation_id: "conv_1", reason: "complaint" });
    expect(h.repo.getQuote("conv_1")!.transfer_reason).toBe("complaint");
  });
});

// ── 5. DOB guesses are budgeted per saved quote, not per call ─────────────────────────────────

describe("bug 5: date-of-birth guesses across calls share one budget per saved quote", () => {
  const miss = (h: H, conv: string, code: string) => h.tool("resume_quote", { conversation_id: conv, resume_code: code, date_of_birth: "1980-01-01" });

  test("two misses on one call and one on the next lock the quote; later calls aren't offered it", async () => {
    const h = build();
    await h.initiate("conv_1");
    await h.run("conv_1", PA_STEPS.slice(0, 3));
    const code2 = (await h.initiate("conv_2"))!;
    expect((await miss(h, "conv_2", code2)).error).toBe("DOB_MISMATCH");
    expect((await miss(h, "conv_2", code2)).error).toBe("DOB_MISMATCH");
    // Hang up and call again: a fresh code must not mean three fresh guesses.
    const code3 = await h.initiate("conv_3");
    expect(code3).not.toBeNull();
    expect((await miss(h, "conv_3", code3!)).error).toBe("RESUME_LOCKED");
    expect((await h.tool("resume_quote", { conversation_id: "conv_3", resume_code: code3, date_of_birth: JORDAN_DOB })).error).toBe("RESUME_LOCKED");
    expect(h.repo.drivers("conv_3")).toEqual([]);
    expect(await h.initiate("conv_4")).toBeNull();
  });

  test("an exhausted budget locks even a code minted before it ran out", async () => {
    const h = build();
    await h.initiate("conv_1");
    await h.run("conv_1", PA_STEPS.slice(0, 3));
    const a = (await h.initiate("conv_a"))!;
    const b = (await h.initiate("conv_b"))!;
    for (let k = 0; k < 3; k++) await miss(h, "conv_a", a);
    expect((await h.tool("resume_quote", { conversation_id: "conv_b", resume_code: b, date_of_birth: JORDAN_DOB })).error).toBe("RESUME_LOCKED");
  });

  test("locking one saved quote doesn't hand out three fresh guesses on the number's older quote (security review 2026-10-16)", async () => {
    // Two unfinished quotes from the same number, same person as driver 1. Once the newest locks, call-start
    // would offer the older one, so a spoofed caller ID got three more DOB guesses per saved quote.
    const h = build();
    await h.initiate("conv_old");
    await h.run("conv_old", PA_STEPS.slice(0, 3));
    h.nowRef.t = new Date(h.nowRef.t.getTime() + 60_000);
    await h.initiate("conv_new");
    await h.run("conv_new", PA_STEPS.slice(0, 3));
    const code = (await h.initiate("conv_a"))!;
    for (let k = 0; k < 3; k++) await miss(h, "conv_a", code);
    expect(await h.initiate("conv_b")).toBeNull();
  });

  test("one miss on a call doesn't stop the right date working on the next", async () => {
    const h = build();
    await h.initiate("conv_1");
    await h.run("conv_1", PA_STEPS.slice(0, 3));
    const code2 = (await h.initiate("conv_2"))!;
    expect((await miss(h, "conv_2", code2)).error).toBe("DOB_MISMATCH");
    const code3 = (await h.initiate("conv_3"))!;
    expect((await miss(h, "conv_3", code3)).error).toBe("DOB_MISMATCH");
    expect((await h.tool("resume_quote", { conversation_id: "conv_3", resume_code: code3, date_of_birth: JORDAN_DOB })).ok).toBe(true);
  });
});

// ── 6. A tool call that timed out can't land after the retry ──────────────────────────────────

describe("bug 6: a late write from a timed-out call never clobbers the agent's retry", () => {
  const SLOW_VIN = "1HGCM82633A004352";
  const slowDecode = (ms: number): ServiceDeps["decode"] => async (vin) => {
    if (vin !== SLOW_VIN) return { decoded: null, source: "timeout" };
    await Bun.sleep(ms);
    return { decoded: { year: 2003, make: "HONDA", model: "Accord", bodyClass: "Sedan" }, source: "vpic" };
  };

  test("save_vehicle: TIMEOUT, corrected retry saves, the slow first call finishes later and is discarded", async () => {
    const h = build({ decode: slowDecode(150), toolTimeoutMs: 40 });
    await h.run("conv_1", PA_STEPS.slice(0, 2));
    const first = await h.tool("save_vehicle", { conversation_id: "conv_1", vehicle_index: 1, vin: SLOW_VIN, usage: "commute", annual_miles: 9000 });
    expect(first).toMatchObject({ ok: false, error: "TIMEOUT" });
    const retry = await h.tool("save_vehicle", { conversation_id: "conv_1", vehicle_index: 1, year: 2019, make: "Honda", model: "Civic", usage: "commute", annual_miles: 9000 });
    expect(retry.ok).toBe(true);
    await Bun.sleep(250);
    expect(h.repo.vehicles("conv_1").map((v) => `${v.year} ${v.make} ${v.model}`)).toEqual(["2019 HONDA Civic"]);
  });

  test("a slow call with no newer call for the same vehicle still saves (it was just slow)", async () => {
    const h = build({ decode: slowDecode(100), toolTimeoutMs: 40 });
    await h.run("conv_1", PA_STEPS.slice(0, 2));
    expect((await h.tool("save_vehicle", { conversation_id: "conv_1", vehicle_index: 1, vin: SLOW_VIN, usage: "commute", annual_miles: 9000 })).error).toBe("TIMEOUT");
    await Bun.sleep(200);
    expect(h.repo.vehicles("conv_1").map((v) => v.model)).toEqual(["Accord"]);
  });

  test("a newer call for a different vehicle doesn't discard the slow one", async () => {
    const h = build({ decode: slowDecode(100), toolTimeoutMs: 40 });
    await h.run("conv_1", PA_STEPS.slice(0, 2));
    await h.tool("save_vehicle", { conversation_id: "conv_1", vehicle_index: 1, vin: SLOW_VIN, usage: "commute", annual_miles: 9000 });
    expect((await h.tool("save_vehicle", { conversation_id: "conv_1", vehicle_index: 2, year: 2019, make: "Honda", model: "Civic", usage: "commute", annual_miles: 9000 })).ok).toBe(true);
    await Bun.sleep(200);
    expect(h.repo.vehicles("conv_1").map((v) => v.model)).toEqual(["Accord", "Civic"]);
  });

  test("a slow save_vehicle that lands after the application writes nothing to the applied quote", async () => {
    const h = build({ decode: slowDecode(150), toolTimeoutMs: 40 });
    await h.run("conv_1", PA_STEPS.slice(0, 3));
    // A stray late save for a second vehicle, then the caller finishes and applies before it lands.
    await h.tool("save_vehicle", { conversation_id: "conv_1", vehicle_index: 2, vin: SLOW_VIN, usage: "commute", annual_miles: 9000 });
    const q = await h.run("conv_1", PA_STEPS.slice(3));
    expect((await h.tool("submit_application", { conversation_id: "conv_1", quote_hash: q!.quote_hash, caller_confirmed: true, first_name: "Jordan", last_name: "Reyes" })).ok).toBe(true);
    await Bun.sleep(250);
    expect(h.repo.vehicles("conv_1").map((v) => v.model)).toEqual(["Civic"]);
    expect(h.repo.getQuote("conv_1")).toMatchObject({ status: "applied", quote_hash: q!.quote_hash });
  });
});

// ── 7. Retention covers the caller-number bindings ────────────────────────────────────────────

describe("bug 7: retention purges call_bindings (encrypted caller number + lookup hash)", () => {
  async function seeded() {
    const { runRetention } = await import("../src/ops/retention");
    const h = build();
    await h.initiate("conv_old_live");
    await h.initiate("conv_new_live");
    await h.initiate("sim_eval-old");
    await h.initiate("sim_eval-new");
    h.repo.db.exec("UPDATE call_bindings SET created_at = '2026-08-01T00:00:00.000Z' WHERE conversation_id = 'conv_old_live'");
    h.repo.db.exec("UPDATE call_bindings SET created_at = '2026-10-14T00:00:00.000Z' WHERE conversation_id = 'conv_new_live'");
    h.repo.db.exec("UPDATE call_bindings SET created_at = '2026-10-01T00:00:00.000Z' WHERE conversation_id = 'sim_eval-old'");
    h.repo.db.exec("UPDATE call_bindings SET created_at = '2026-10-14T00:00:00.000Z' WHERE conversation_id = 'sim_eval-new'");
    return { h, runRetention };
  }
  const ids = (h: H) => (h.repo.db.query("SELECT conversation_id FROM call_bindings ORDER BY conversation_id").all() as { conversation_id: string }[]).map((r) => r.conversation_id);

  test("dry-run counts expired bindings (live 30 days, eval 7) and deletes nothing", async () => {
    const { h, runRetention } = await seeded();
    const r = runRetention(h.repo.db, h.nowRef.t, { mode: "dry-run", liveDays: 30, evalDays: 7 });
    expect(r.callBindings).toBe(2);
    expect(ids(h).length).toBe(4);
  });

  test("enforce removes only the expired bindings", async () => {
    const { h, runRetention } = await seeded();
    runRetention(h.repo.db, h.nowRef.t, { mode: "enforce", liveDays: 30, evalDays: 7 });
    expect(ids(h)).toEqual(["conv_new_live", "sim_eval-new"]);
    expect(h.repo.callerFor("conv_old_live")).toBeNull();
    expect(h.repo.callerFor("conv_new_live")?.phone).toBe(PHONE);
  });
});

// ── 8. The confirmed-name rename only happens with the application ────────────────────────────

describe("bug 8: submit_application renames driver 1 only when the application is created", () => {
  test("numbering exhausted: APP_NUMBER_EXHAUSTED, and driver 1 and the caller name are unchanged", async () => {
    // Every number the generator offers is already taken.
    const h = build({ appNumber: () => "ANA-0000000" });
    h.repo.db.exec("INSERT INTO quotes (id, eval_tag) VALUES ('conv_taken', 'live')");
    h.repo.db.exec("INSERT INTO applications (app_number, quote_id, quote_hash, six_month_premium) VALUES ('ANA-0000000', 'conv_taken', 'H', 1)");
    await h.initiate("conv_1");
    const q = await h.run("conv_1", PA_STEPS);
    const r = await h.tool("submit_application", { conversation_id: "conv_1", quote_hash: q!.quote_hash, caller_confirmed: true, first_name: "Erik", last_name: "Poh" });
    expect(r).toMatchObject({ ok: false, error: "APP_NUMBER_EXHAUSTED" });
    expect(h.repo.drivers("conv_1")[0]).toMatchObject({ first_name: "Jordan", last_name: "Reyes" });
    expect(h.repo.getQuote("conv_1")).toMatchObject({ caller_name: "Jordan Reyes", status: "quoted" });
  });

  test("on success the confirmed spelling becomes the name of record, in the same step", async () => {
    const h = build();
    await h.initiate("conv_1");
    const q = await h.run("conv_1", PA_STEPS);
    const r = await h.tool("submit_application", { conversation_id: "conv_1", quote_hash: q!.quote_hash, caller_confirmed: true, first_name: "Erik", last_name: "Poh" });
    expect(r).toMatchObject({ ok: true, applicant: "Erik Poh" });
    expect(h.repo.drivers("conv_1")[0]).toMatchObject({ first_name: "Erik", last_name: "Poh" });
    expect(h.repo.getQuote("conv_1")).toMatchObject({ caller_name: "Erik Poh", status: "applied" });
  });
});
