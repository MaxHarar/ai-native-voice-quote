import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, openDb, Repo } from "../src/db";
import { createFieldCipher } from "../src/security/crypto";
import { SlidingWindowLimiter } from "../src/security/rateLimit";
import { createApp } from "../src/server/app";
import { cheaperOptions, QuoteService, type ServiceDeps } from "../src/service";
import { rate, seniorDiscountImpact } from "../src/rating/engine";
import { stateConfig } from "../src/rating/rateTable";
import type { RatingInput } from "../src/rating/types";

// Fix wave from the 2026-10-16 deep review, code review and silent-failure hunt, driven through the real HTTP tool
// surface. Each describe names the finding it pins.

const SECRET = "test-secret-test-secret-123456";
const INIT = "initiation-secret-initiation-secret";
const PHONE = "+12155550123";
type Body = Record<string, unknown>;
type Step = [tool: string, body: Body];

function build(o: { decode?: ServiceDeps["decode"]; toolTimeoutMs?: number } = {}) {
  const nowRef = { t: new Date("2026-10-15T15:00:00Z") };
  const repo = new Repo(openDb(":memory:"), createFieldCipher(Buffer.alloc(32, 7).toString("base64")));
  const service = new QuoteService({ repo, now: () => nowRef.t, decode: o.decode ?? (async () => ({ decoded: null, source: "timeout" })), licenseKey: "fix-wave-key" });
  const logs: Record<string, unknown>[] = [];
  const app = createApp({
    repo, service, toolSecret: SECRET, initiationSecret: INIT, limiter: new SlidingWindowLimiter(), now: () => nowRef.t,
    fetchMeta: async () => null, fetchTranscript: async () => null, log: (l) => logs.push(l), ...(o.toolTimeoutMs ? { toolTimeoutMs: o.toolTimeoutMs } : {}),
  });
  const tool = async (name: string, body: Body) =>
    (await (await app.request(`/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": SECRET }, body: JSON.stringify(body) })).json()) as Record<string, any>;
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
  return { repo, service, tool, initiate, run, nowRef, logs };
}
type H = ReturnType<typeof build>;

const DOB = "1971-05-14";
const WRONG = "1990-01-01";
const PA_STEPS: Step[] = [
  ["start_quote", { caller_name: "Jordan Reyes", zip: "18940", prior_insurance_months: 300 }],
  ["save_driver", { driver_index: 1, first_name: "Jordan", last_name: "Reyes", date_of_birth: DOB, license_state: "PA", license_number: "4821 0937", years_licensed: 35, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false }],
  ["save_vehicle", { vehicle_index: 1, year: 2019, make: "Honda", model: "Civic", usage: "commute", annual_miles: 9000 }],
  ["set_coverage", { package: "recommended", pay_in_full: false, tort_option: "full" }],
  ["get_quote", {}],
];
const resume = (h: H, id: string, code: string, dob: string) => h.tool("resume_quote", { conversation_id: id, resume_code: code, date_of_birth: dob });

/** A saved, unfinished quote from PHONE on conv_1. */
async function saved(h: H) {
  await h.initiate("conv_1");
  await h.run("conv_1", PA_STEPS.slice(0, 3));
}

// ── A1. A successful resume resets the number's DOB budget ───────────────────────────────────

describe("A1: a verified resume resets the caller number's failed DOB attempts (review 2026-10-16)", () => {
  test("miss, miss, correct; on the next call a single miss is a mismatch, not a lockout, and the right date works", async () => {
    const h = build();
    await saved(h);
    const code2 = (await h.initiate("conv_2"))!;
    expect((await resume(h, "conv_2", code2, WRONG)).error).toBe("DOB_MISMATCH");
    expect((await resume(h, "conv_2", code2, WRONG)).error).toBe("DOB_MISMATCH");
    expect((await resume(h, "conv_2", code2, DOB)).ok).toBe(true);
    // conv_2 is now the number's saved quote; the owner just proved who they are.
    const code3 = await h.initiate("conv_3");
    expect(code3).not.toBeNull();
    expect((await resume(h, "conv_3", code3!, WRONG)).error).toBe("DOB_MISMATCH");
    expect((await resume(h, "conv_3", code3!, DOB)).ok).toBe(true);
  });

  test("the attacker budget still holds: three misses with no success in between lock the number", async () => {
    const h = build();
    await saved(h);
    const code2 = (await h.initiate("conv_2"))!;
    await resume(h, "conv_2", code2, WRONG);
    await resume(h, "conv_2", code2, WRONG);
    const code3 = (await h.initiate("conv_3"))!;
    expect((await resume(h, "conv_3", code3, WRONG)).error).toBe("RESUME_LOCKED");
    expect(await h.initiate("conv_4")).toBeNull();
  });

  test("exploit: verifying a quote the spoofer made under the number never resets misses against the victim's quote", async () => {
    // Coordinator security correction: a caller-wide reset gave unlimited guesses. Spoof the number, miss twice on
    // the victim's quote, make a quote with your own DOB, resume it correctly, hand it off so it isn't offered, and
    // the victim's quote came back with fresh guesses.
    const h = build();
    await saved(h); // the victim's quote, DOB 1971-05-14
    const a1 = (await h.initiate("conv_a1"))!;
    expect((await resume(h, "conv_a1", a1, WRONG)).error).toBe("DOB_MISMATCH");
    expect((await resume(h, "conv_a1", a1, WRONG)).error).toBe("DOB_MISMATCH");
    // The attacker's own quote on that call, own DOB.
    h.nowRef.t = new Date(h.nowRef.t.getTime() + 60_000);
    await h.run("conv_a1", [
      ["start_quote", { caller_name: "Mal Lory", zip: "18940", prior_insurance_months: 12 }],
      ["save_driver", { driver_index: 1, first_name: "Mal", last_name: "Lory", date_of_birth: WRONG, license_state: "PA", license_number: "1234 5678", years_licensed: 10, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false }],
    ]);
    const a2 = (await h.initiate("conv_a2"))!;
    expect((await resume(h, "conv_a2", a2, WRONG)).ok).toBe(true); // the attacker's quote, correctly verified
    await h.tool("flag_for_human", { conversation_id: "conv_a2", reason: "caller_requested", summary: "x" });
    // The number's budget still holds the two misses against the victim: one more locks it.
    const a3 = await h.initiate("conv_a3");
    expect(a3).not.toBeNull(); // the victim's quote is offered again (2 misses, budget 3)
    expect((await resume(h, "conv_a3", a3!, "1980-02-02")).error).toBe("RESUME_LOCKED");
    expect(await h.initiate("conv_a4")).toBeNull();
    expect(h.repo.drivers("conv_a3")).toEqual([]);
    expect(h.repo.drivers("conv_a4")).toEqual([]);
  });
});

// ── A2. A slow save_vehicle that lands after resume_quote is discarded ──────────────────────

describe("A2: a pre-resume slow save_vehicle never lands on the resumed quote (review 2026-10-16)", () => {
  const SLOW_VIN = "1HGCM82633A004352";
  const slowDecode: ServiceDeps["decode"] = async (vin) => {
    if (vin !== SLOW_VIN) return { decoded: null, source: "timeout" };
    await Bun.sleep(150);
    return { decoded: { year: 2003, make: "HONDA", model: "Accord", bodyClass: "Sedan" }, source: "vpic" };
  };

  test("TIMEOUT, then resume_quote succeeds, then the slow save finishes: the resumed vehicle is untouched", async () => {
    const h = build({ decode: slowDecode, toolTimeoutMs: 40 });
    await saved(h);
    const code = (await h.initiate("conv_2"))!;
    await h.tool("start_quote", { conversation_id: "conv_2", caller_name: "Jordan Reyes", zip: "18940", prior_insurance_months: 300 });
    expect((await h.tool("save_vehicle", { conversation_id: "conv_2", vehicle_index: 1, vin: SLOW_VIN, usage: "commute", annual_miles: 9000 })).error).toBe("TIMEOUT");
    expect((await resume(h, "conv_2", code, DOB)).ok).toBe(true);
    await Bun.sleep(250);
    expect(h.repo.vehicles("conv_2").map((v) => `${v.year} ${v.make} ${v.model}`)).toEqual(["2019 HONDA Civic"]);
  });
});

// ── A8. resume_quote is idempotent on the call that resumed ─────────────────────────────────

describe("A8: a retried resume_quote on the same call returns the same success (review 2026-10-16)", () => {
  test("same code, same conversation, after success: same payload, nothing re-copied", async () => {
    const h = build();
    await saved(h);
    const code = (await h.initiate("conv_2"))!;
    const first = await resume(h, "conv_2", code, DOB);
    expect(first.ok).toBe(true);
    const again = await resume(h, "conv_2", code, DOB);
    expect(again).toEqual(first);
    expect(h.repo.vehicles("conv_2").length).toBe(1);
  });

  test("another conversation holding a used code still gets nothing", async () => {
    const h = build();
    await saved(h);
    const code = (await h.initiate("conv_2"))!;
    expect((await resume(h, "conv_2", code, DOB)).ok).toBe(true);
    expect((await resume(h, "conv_x", code, DOB)).error).toBe("RESUME_UNAVAILABLE");
  });
});

// ── A14. Call-start says why a number was not offered its saved quote ───────────────────────

describe("A14: initiation reports resume_locked when the number's DOB budget is spent (review 2026-10-16)", () => {
  test("the result carries the reason and the initiation log line says it; the caller is treated as new", async () => {
    const h = build();
    await saved(h);
    const code = (await h.initiate("conv_2"))!;
    for (let k = 0; k < 3; k++) await resume(h, "conv_2", code, WRONG);
    expect(h.service.initiation({ conversationId: "conv_3", callerId: PHONE })).toEqual({ returning: false, reason: "resume_locked" });
    expect(await h.initiate("conv_4")).toBeNull();
    expect(h.logs.find((l) => l.message === "initiation" && l.conversation_id === "conv_4")).toMatchObject({ returning: false, reason: "resume_locked" });
  });

  test("an ordinary first-time caller has no reason", () => {
    const h = build();
    expect(h.service.initiation({ conversationId: "conv_new", callerId: PHONE })).toEqual({ returning: false });
  });
});

// ── A18. A quote with no state is never priced as New Jersey ─────────────────────────────────

describe("A18: no silent New Jersey default for a quote with no state (review 2026-10-16)", () => {
  test("get_quote and set_coverage fail STATE_UNKNOWN instead of pricing NJ", async () => {
    const h = build();
    await h.run("conv_1", PA_STEPS.slice(0, 4));
    h.repo.db.exec("UPDATE quotes SET state = NULL WHERE id = 'conv_1'");
    expect((await h.tool("get_quote", { conversation_id: "conv_1" })).error).toBe("STATE_UNKNOWN");
    expect((await h.tool("set_coverage", { conversation_id: "conv_1", package: "recommended", pay_in_full: true })).error).toBe("STATE_UNKNOWN");
  });

  test("a saved quote with no state is never offered on a call back", async () => {
    const h = build();
    await saved(h);
    h.repo.db.exec("UPDATE quotes SET state = NULL WHERE id = 'conv_1'");
    expect(await h.initiate("conv_2")).toBeNull();
  });

  test("migration: rows quoted in the New Jersey-only era (territory, no state) are backfilled to NJ", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec("INSERT INTO quotes (id, zip, territory) VALUES ('legacy', '08540', 1)");
    db.exec("INSERT INTO quotes (id, zip) VALUES ('out_of_state', '10001')");
    migrate(db);
    const rows = db.query("SELECT id, state FROM quotes ORDER BY id").all();
    expect(rows).toEqual([{ id: "legacy", state: "NJ" }, { id: "out_of_state", state: null }]);
  });
});

// ── A3. lookup_application shares price and package only with the applicant ─────────────────

describe("A3: lookup_application withholds the premium unless the last name matches driver 1 (review 2026-10-16)", () => {
  async function application(h: H) {
    const q = await h.run("conv_1", PA_STEPS);
    const app = await h.tool("submit_application", { conversation_id: "conv_1", quote_hash: q!.quote_hash, caller_confirmed: true, first_name: "Jordan", last_name: "Reyes" });
    expect(app.ok).toBe(true);
    return app.application_number as string;
  }

  test("old agent (number only, no conversation): it exists and its status, no premium or package", async () => {
    const h = build();
    const n = await application(h);
    const r = await h.tool("lookup_application", { application_number: n });
    expect(r).toMatchObject({ ok: true, application_number: n, status: "received, pending specialist review" });
    expect(r.six_month_premium).toBeUndefined();
    expect(r.package).toBeUndefined();
    expect(r.submitted_at).toBeUndefined();
  });

  test("matching last name (any case, padded) gets the premium and package", async () => {
    const h = build();
    const n = await application(h);
    const r = await h.tool("lookup_application", { conversation_id: "conv_2", application_number: n, last_name: "  rEYES " });
    expect(r).toMatchObject({ ok: true, application_number: n, package: "recommended" });
    expect(r.six_month_premium).toBeGreaterThan(0);
  });

  test("a wrong last name gets nothing more than the number alone", async () => {
    const h = build();
    const n = await application(h);
    const r = await h.tool("lookup_application", { conversation_id: "conv_2", application_number: n, last_name: "Smith" });
    expect(r.ok).toBe(true);
    expect(r.six_month_premium).toBeUndefined();
    expect(r.package).toBeUndefined();
  });

  test("with a conversation id, lookups are rate limited like every other tool on the call", async () => {
    const h = build();
    const n = await application(h);
    let last: Record<string, any> = {};
    for (let k = 0; k < 305; k++) last = await h.tool("lookup_application", { conversation_id: "conv_scan", application_number: n });
    expect(last.error).toBe("RATE_LIMITED");
  });
});

// ── A4 / B10. One guard for quotes that are no longer this call's to change ──────────────────

describe("A4: a transferred quote refuses every data-collecting tool (review 2026-10-16)", () => {
  test("save_driver, add_license, save_vehicle, set_coverage and start_quote all refuse with TRANSFERRED", async () => {
    const h = build();
    await h.run("conv_1", PA_STEPS.slice(0, 4));
    await h.tool("flag_for_human", { conversation_id: "conv_1", reason: "caller_requested", summary: "wants a person" });
    const before = JSON.stringify([h.repo.getQuote("conv_1")!.zip, h.repo.drivers("conv_1"), h.repo.vehicles("conv_1")]);
    const C = { conversation_id: "conv_1" };
    const calls: [string, Body][] = [
      ["save_driver", { ...C, ...PA_STEPS[1]![1], driver_index: 2 }],
      ["add_license", { ...C, driver_index: 1, license_number: "4821 0937" }],
      ["save_vehicle", { ...C, vehicle_index: 2, year: 2020, make: "Ford", model: "F-150", usage: "pleasure", annual_miles: 7000 }],
      ["set_coverage", { ...C, package: "minimum", pay_in_full: true, tort_option: "limited" }],
      ["start_quote", { ...C, caller_name: "Jordan Reyes", zip: "08540", prior_insurance_months: 300 }],
    ];
    for (const [name, body] of calls) {
      const r = await h.tool(name, body);
      expect({ name, error: r.error }).toEqual({ name, error: "TRANSFERRED" });
      expect(r.hint).toContain("licensed agent");
    }
    expect(JSON.stringify([h.repo.getQuote("conv_1")!.zip, h.repo.drivers("conv_1"), h.repo.vehicles("conv_1")])).toBe(before);
    expect(h.repo.getQuote("conv_1")!.status).toBe("transferred");
  });

  test("B10: add_license and save_driver after an application return the application number", async () => {
    const h = build();
    const q = await h.run("conv_1", PA_STEPS);
    const app = await h.tool("submit_application", { conversation_id: "conv_1", quote_hash: q!.quote_hash, caller_confirmed: true, first_name: "Jordan", last_name: "Reyes" });
    for (const [name, body] of [["add_license", { driver_index: 1, license_number: "4821 0937" }], ["save_driver", PA_STEPS[1]![1]]] as const) {
      const r = await h.tool(name, { conversation_id: "conv_1", ...body });
      expect({ name, error: r.error, n: r.application_number }).toEqual({ name, error: "ALREADY_APPLIED", n: app.application_number });
    }
  });
});

// ── C12. Missing reports for a licensed driver fail loudly ─────────────────────────────────

describe("C12: a licensed driver with no reports is never priced on the self-reported record (review 2026-10-16)", () => {
  test("get_quote fails REPORTS_MISSING instead of using the no-license stand-in", async () => {
    const h = build();
    await h.run("conv_1", PA_STEPS.slice(0, 4));
    h.repo.db.exec("DELETE FROM reports WHERE quote_id='conv_1' AND kind='CLUE'");
    const r = await h.tool("get_quote", { conversation_id: "conv_1" });
    expect(r.error).toBe("REPORTS_MISSING");
    expect(r.hint).toContain("transfer");
  });

  test("save_driver's driver row and its reports are one transaction", async () => {
    const h = build();
    await h.run("conv_1", PA_STEPS.slice(0, 1));
    const real = h.repo.upsertReport.bind(h.repo);
    let n = 0;
    h.repo.upsertReport = (r) => {
      if (++n === 2) throw new Error("disk full");
      real(r);
    };
    expect((await h.tool("save_driver", { conversation_id: "conv_1", ...PA_STEPS[1]![1] })).error).toBe("INTERNAL");
    expect(h.repo.drivers("conv_1")).toEqual([]);
    expect(h.repo.reports("conv_1")).toEqual([]);
  });
});

// ── C15. A referral on an estimate is persisted ────────────────────────────────────────────

describe("C15: an estimate that underwriting refers is recorded as referred (review 2026-10-16)", () => {
  test("status referred with no price, and it is not offered on a call back", async () => {
    const h = build();
    await h.initiate("conv_1");
    await h.run("conv_1", [PA_STEPS[0]!, ["save_driver", { ...PA_STEPS[1]![1], license_number: "", dui_3y: true }], PA_STEPS[2]!, PA_STEPS[3]!]);
    const r = await h.tool("get_quote", { conversation_id: "conv_1" });
    expect(r.eligibility).toBe("REFER");
    expect(h.repo.getQuote("conv_1")).toMatchObject({ status: "referred", quote_hash: null, six_month_premium: null });
    expect(await h.initiate("conv_2")).toBeNull();
  });
});

// ── C16 / C17. Outcomes that used to look like errors, and a hand-off reason that vanished ─

describe("C16/C17: SUPERSEDED is not an error; a dropped hand-off reason is on record (review 2026-10-16)", () => {
  test("a superseded late save_vehicle reports ok with superseded true", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => (release = res));
    const h = build({
      decode: async () => {
        await gate;
        return { decoded: { year: 2003, make: "HONDA", model: "Accord", bodyClass: "Sedan" }, source: "vpic" };
      },
    });
    await h.run("conv_1", PA_STEPS.slice(0, 1));
    const slow = h.tool("save_vehicle", { conversation_id: "conv_1", vehicle_index: 1, vin: "1HGCM82633A004352", usage: "commute", annual_miles: 9000 });
    await Bun.sleep(20);
    expect((await h.tool("save_vehicle", { conversation_id: "conv_1", ...PA_STEPS[2]![1] })).ok).toBe(true);
    release();
    expect(await slow).toMatchObject({ ok: true, superseded: true });
    expect(h.repo.vehicles("conv_1").map((v) => v.model)).toEqual(["Civic"]);
  });

  test("a later hand-off reason blocked by a recording decline leaves an event row", async () => {
    const h = build();
    await h.tool("flag_for_human", { conversation_id: "conv_1", reason: "declined_recording", summary: "x" });
    await h.tool("flag_for_human", { conversation_id: "conv_1", reason: "complaint", summary: "x" });
    expect(h.repo.getQuote("conv_1")!.transfer_reason).toBe("declined_recording");
    expect(h.repo.events("conv_1")).toContainEqual(expect.objectContaining({ tool: "flag_for_human", error: "DROPPED_REASON:complaint" }));
  });
});

// ── A5. The VIN decode cache follows the live retention window ──────────────────────────────

describe("A5: retention purges vin_cache entries older than the live window (review 2026-10-16)", () => {
  test("dry-run counts, enforce deletes only the expired ones", async () => {
    const { runRetention } = await import("../src/ops/retention");
    const h = build();
    const cache = h.repo.vinCache();
    cache.set("1HGCM82633A004352", { year: 2003, make: "HONDA", model: "Accord", bodyClass: "Sedan" });
    cache.set("2HGCM82633A004352", { year: 2003, make: "HONDA", model: "Accord", bodyClass: "Sedan" });
    h.repo.db.exec("UPDATE vin_cache SET fetched_at='2026-08-01T00:00:00.000Z' WHERE vin='1HGCM82633A004352'");
    const policy = { liveDays: 30, evalDays: 7 };
    expect(runRetention(h.repo.db, h.nowRef.t, { mode: "dry-run", ...policy }).vinCache).toBe(1);
    runRetention(h.repo.db, h.nowRef.t, { mode: "enforce", ...policy });
    expect(cache.get("1HGCM82633A004352")).toBeNull();
    expect(cache.get("2HGCM82633A004352")).not.toBeNull();
  });
});

// ── C13. Late outcomes are logged once, only when the timeout actually won ──────────────────

describe("C13: TIMEOUT race logging (review 2026-10-16)", () => {
  test("a slow call that times out logs its late outcome with the request id and leaves an event row", async () => {
    const h = build({
      decode: async () => {
        await Bun.sleep(120);
        return { decoded: { year: 2003, make: "HONDA", model: "Accord", bodyClass: "Sedan" }, source: "vpic" };
      },
      toolTimeoutMs: 30,
    });
    await h.run("conv_1", PA_STEPS.slice(0, 1));
    expect((await h.tool("save_vehicle", { conversation_id: "conv_1", vehicle_index: 1, vin: "1HGCM82633A004352", usage: "commute", annual_miles: 9000 })).error).toBe("TIMEOUT");
    await Bun.sleep(200);
    const late = h.logs.filter((l) => l.late === true);
    expect(late).toEqual([expect.objectContaining({ tool: "save_vehicle", quote_id: "conv_1", ok: true, request_id: expect.any(String) })]);
    expect(h.repo.events("conv_1")).toContainEqual(expect.objectContaining({ tool: "save_vehicle", ok: 1, error: "LATE" }));
  });

  test("an in-time failure is logged exactly once and never marked late", async () => {
    const h = build();
    h.service.getQuote = () => {
      throw new Error("boom 12345");
    };
    expect((await h.tool("get_quote", { conversation_id: "conv_1" })).error).toBe("INTERNAL");
    await Bun.sleep(10);
    expect(h.logs.filter((l) => l.level === "error")).toHaveLength(1);
    expect(h.logs.some((l) => l.late)).toBe(false);
  });
});

// ── B6 / B9. Ways to lower and the spoken top factor ───────────────────────────────────────

describe("B6: limited tort is never offered as a way to save (review 2026-10-16)", () => {
  test("Pennsylvania full tort, recommended, monthly: package and pay-in-full only", () => {
    const input: RatingInput = {
      state: "PA", territory: 3, package: "recommended", payInFull: false, priorInsuranceMonths: 24, tortOption: "full", umStacked: true, effectiveYear: 2026,
      drivers: [{ age: 35, yearsLicensed: 15, minorViolations3y: 0, majorViolations3y: 0, atFaultAccidents3y: 0 }],
      vehicles: [{ modelYear: 2020, bodyClass: "sedan", valueBand: "standard", usage: "commute", annualMiles: 12000, antiTheft: false }],
    };
    const ways = cheaperOptions(input, rate(input).sixMonthPremium, stateConfig("PA"));
    expect(ways.map((w) => w.option).sort()).toEqual(["pay the six months in full", `switch to the ${stateConfig("PA").packages.minimum.label} package`].sort());
  });
});

describe("B9: the senior low-mileage discount is weighted by the share of cars that qualify (review 2026-10-16)", () => {
  const mi = (miles: number[]): RatingInput => ({
    state: "MI", territory: 1, package: "recommended", payInFull: false, priorInsuranceMonths: 24, pipMedical: "unlimited", effectiveYear: 2026,
    drivers: [{ age: 70, yearsLicensed: 50, minorViolations3y: 0, majorViolations3y: 0, atFaultAccidents3y: 0 }],
    vehicles: miles.map((annualMiles) => ({ modelYear: 2020, bodyClass: "sedan", valueBand: "standard", usage: "pleasure", annualMiles, antiTheft: false })),
  });
  test("one of two cars qualifying is half the discount; one of one is all of it; none is neutral", () => {
    expect(seniorDiscountImpact(mi([2000, 12000]))).toBeCloseTo(0.95, 10);
    expect(seniorDiscountImpact(mi([2000]))).toBeCloseTo(0.9, 10);
    expect(seniorDiscountImpact(mi([12000]))).toBe(1);
  });
});
