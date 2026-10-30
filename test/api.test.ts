import { beforeEach, describe, expect, test } from "bun:test";
import { openDb, Repo } from "../src/db";
import { createApp, TOOL_SCHEMAS } from "../src/server/app";
import { QuoteService } from "../src/service";
import type { DecodeOutcome } from "../src/verify/vpic";

const SECRET = "test-secret-test-secret-123456";
const ADMIN = "admin-secret-admin-secret-1234";
const NOW = new Date("2026-10-14T15:00:00Z");

const fakeDecode = async (vin: string): Promise<DecodeOutcome> =>
  vin === "1HGCM82633A004352"
    ? { decoded: { year: 2003, make: "HONDA", model: "Accord", bodyClass: "Coupe" }, source: "vpic" }
    : vin === "18GCM82633A004352"
      ? { decoded: null, source: "not_found" }
      : { decoded: null, source: "timeout" };

let repo: Repo;
let logs: string[];
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  logs = [];
  app = createApp({
    repo,
    service: new QuoteService({ repo, now: () => NOW, decode: fakeDecode, licenseKey: "k" }),
    toolSecret: SECRET,
    adminSecret: ADMIN,
    opsUser: "max",
    opsPassword: "pw-pw-pw-pw",
    log: (l) => logs.push(JSON.stringify(l)),
  });
});

const call = async (tool: string, body: Record<string, unknown>, secret = SECRET) => {
  const res = await app.request(`/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": secret }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};
const C = { conversation_id: "conv_test_1", eval_tag: "unit" };

async function happyPathToQuote(license = "S10000000000001", last = "Smith") {
  expect((await call("start_quote", { ...C, caller_name: "Sarah Smith", zip: "08540", prior_insurance_months: 36 })).json.ok).toBe(true);
  const d = await call("save_driver", {
    ...C, driver_index: 1, first_name: "Sarah", last_name: last, date_of_birth: "1988-03-02", license_state: "NJ",
    license_number: license, years_licensed: 20, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false,
  });
  expect(d.json.ok).toBe(true);
  expect((await call("save_vehicle", { ...C, vehicle_index: 1, vin: "1HGCM82633A004352", usage: "commute", annual_miles: 11000 })).json.ok).toBe(true);
  expect((await call("set_coverage", { ...C, package: "recommended", pay_in_full: false })).json.ok).toBe(true);
  return (await call("get_quote", C)).json;
}

describe("tool API", () => {
  test("ISC-24: every tool rejects a missing or wrong secret with 401", async () => {
    for (const tool of Object.keys(TOOL_SCHEMAS)) {
      expect((await call(tool, C, "")).status).toBe(401);
      expect((await call(tool, C, "wrong-secret-wrong-secret-xx")).status).toBe(401);
    }
  });

  test("ISC-25: bad input returns a structured error, never a 500", async () => {
    for (const tool of Object.keys(TOOL_SCHEMAS)) {
      const r = await call(tool, { garbage: true });
      expect(r.status).toBe(200);
      expect(r.json.ok).toBe(false);
      expect(typeof r.json.hint).toBe("string");
    }
  });

  test("ISC-27: full scripted flow issues an application with a Luhn number", async () => {
    const q = await happyPathToQuote();
    expect(q.ok).toBe(true);
    expect(q.eligibility).toBe("OK");
    expect(q.six_month_premium).toBeGreaterThan(300);
    expect(q.discrepancies).toEqual([]);
    const sub = await call("submit_application", { ...C, quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Sarah", last_name: "Smith" });
    expect(sub.json.ok).toBe(true);
    expect(sub.json.application_number).toMatch(/^ANA-\d{7}$/);
    const row = repo.applicationByQuote(C.conversation_id)!;
    expect(row.app_number).toBe(sub.json.application_number);
    expect(repo.getQuote(C.conversation_id)!.status).toBe("applied");
    const look = await call("lookup_application", { application_number: sub.json.spoken });
    expect(look.json.ok).toBe(true);
  });

  test("ISC-19: submit without caller confirmation creates no application", async () => {
    const q = await happyPathToQuote();
    const r = await call("submit_application", { ...C, quote_hash: q.quote_hash, caller_confirmed: false, first_name: "Sarah", last_name: "Smith" });
    expect(r.json.error).toBe("NOT_CONFIRMED");
    expect(repo.applicationByQuote(C.conversation_id)).toBeNull();
  });

  test("submit with a stale hash is refused after details change", async () => {
    const q = await happyPathToQuote();
    await call("set_coverage", { ...C, package: "premium", pay_in_full: false });
    const r = await call("submit_application", { ...C, quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Sarah", last_name: "Smith" });
    expect(r.json.ok).toBe(false);
    expect(repo.applicationByQuote(C.conversation_id)).toBeNull();
  });

  test("submit is idempotent: a retry returns the same number", async () => {
    const q = await happyPathToQuote();
    const a = await call("submit_application", { ...C, quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Sarah", last_name: "Smith" });
    const b = await call("submit_application", { ...C, quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Sarah", last_name: "Smith" });
    expect(b.json.application_number).toBe(a.json.application_number);
    expect(repo.db.query("SELECT COUNT(*) n FROM applications").get()).toEqual({ n: 1 });
  });

  test("ISC-15 end-to-end: unreported tickets surface as a discrepancy and raise the price", async () => {
    const clean = await happyPathToQuote();
    repo.db.exec("DELETE FROM quotes");
    const dirty = await happyPathToQuote("D20000000000002", "Diaz");
    expect(dirty.discrepancies.length).toBeGreaterThan(0);
    expect(dirty.six_month_premium).toBeGreaterThan(clean.six_month_premium);
  });

  test("ISC-20: a referred quote cannot be submitted; it has no price", async () => {
    const q = await happyPathToQuote("R30000000000003", "Reed");
    expect(q.eligibility).toBe("REFER");
    expect(q.six_month_premium).toBeUndefined();
    const r = await call("submit_application", { ...C, quote_hash: "ANYTHING", caller_confirmed: true, first_name: "Sarah", last_name: "Smith" });
    expect(r.json.error).toBe("REFERRED");
  });

  test("out-of-state ZIP is refused and the transfer flag is recorded", async () => {
    const r = await call("start_quote", { ...C, caller_name: "Pat", zip: "19801", prior_insurance_months: 10 }); // Wilmington, DE
    expect(r.json.error).toBe("OUT_OF_STATE");
    await call("flag_for_human", { ...C, reason: "out_of_state" });
    expect(repo.getQuote(C.conversation_id)).toMatchObject({ status: "transferred", transfer_reason: "out_of_state", caller_name: "Pat", zip: "19801", territory: null });
  });

  test("an out-of-state quote cannot accept drivers, vehicles, or coverage", async () => {
    await call("start_quote", { ...C, caller_name: "Pat", zip: "10001", prior_insurance_months: 8 }); // New York, NY
    const d = await call("save_driver", { ...C, driver_index: 1, first_name: "Pat", last_name: "Kowalski", date_of_birth: "1990-01-01", license_state: "PA", license_number: "12345678", years_licensed: 10, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false });
    expect(d.json.error).toBe("QUOTE_NOT_STARTED");
    expect((await call("save_vehicle", { ...C, vehicle_index: 1, year: 2020, make: "Toyota", model: "Camry", usage: "commute", annual_miles: 9000 })).json.error).toBe("QUOTE_NOT_STARTED");
    expect((await call("set_coverage", { ...C, package: "recommended", pay_in_full: true })).json.error).toBe("QUOTE_NOT_STARTED");
    expect(repo.drivers(C.conversation_id).length).toBe(0);
  });

  test("VIN typo returns the likely correction instead of a dead end", async () => {
    await call("start_quote", { ...C, caller_name: "Sarah Smith", zip: "08540", prior_insurance_months: 36 });
    const r = await call("save_vehicle", { ...C, vehicle_index: 1, vin: "1HGCN82633A004352", usage: "commute", annual_miles: 11000 });
    expect(r.json.error).toBe("VIN_CHECK_DIGIT");
    expect(r.json.likely_corrections[0]).toBe("1 H G C, M 8 2 6, 3 3 A 0, 0 4 3 5 2");
  });

  test("check-digit-valid VIN that decodes to nothing asks for a re-read (H/8 blind spot)", async () => {
    await call("start_quote", { ...C, caller_name: "Sarah Smith", zip: "08540", prior_insurance_months: 36 });
    const r = await call("save_vehicle", { ...C, vehicle_index: 1, vin: "18GCM82633A004352", usage: "commute", annual_miles: 11000 });
    expect(r.json.error).toBe("VIN_NOT_FOUND");
    expect(repo.vehicles(C.conversation_id).length).toBe(0);
  });

  test("ISC-13: VIN that decodes to a different make than stated warns VERIFY_MISMATCH", async () => {
    await call("start_quote", { ...C, caller_name: "Sarah Smith", zip: "08540", prior_insurance_months: 36 });
    const r = await call("save_vehicle", { ...C, vehicle_index: 1, vin: "1HGCM82633A004352", make: "Toyota", usage: "commute", annual_miles: 11000 });
    expect(r.json.ok).toBe(true);
    expect(r.json.warnings[0]).toContain("VERIFY_MISMATCH");
  });

  test("ISC-10: VIN decoder timeout falls back to stated year/make/model", async () => {
    await call("start_quote", { ...C, caller_name: "Sarah Smith", zip: "08540", prior_insurance_months: 36 });
    const r = await call("save_vehicle", { ...C, vehicle_index: 1, vin: "1M8GDM9AXKP042788", year: 2019, make: "Ford", model: "F-150", usage: "commute", annual_miles: 11000 });
    expect(r.json.ok).toBe(true);
    expect(r.json.vin_verified).toBe(false);
  });

  test("a mis-transcribed license echoes what the server received so the agent can self-correct", async () => {
    await call("start_quote", { ...C, caller_name: "Taylor Tran", zip: "08002", prior_insurance_months: 24 });
    const bad = await call("save_driver", {
      ...C, driver_index: 1, first_name: "Taylor", last_name: "Tran", date_of_birth: "1985-01-22", license_state: "NJ",
      license_number: "T500000000000005", years_licensed: 20, tickets_3y: 0, at_fault_accidents_3y: 1, dui_3y: false,
    });
    expect(bad.json.error).toBe("INVALID_LICENSE");
    expect(bad.json.hint).toContain("T, 5 0 0 0, 0 0 0 0, 0 0 0 0, 0 0 5");
    expect(bad.json.hint).toContain("15 digits");
    // Grouped input exactly as read back is accepted (spaces stripped server-side).
    const good = await call("save_driver", {
      ...C, driver_index: 1, first_name: "Taylor", last_name: "Tran", date_of_birth: "1985-01-22", license_state: "NJ",
      license_number: "T 5000 0000 0000 05", years_licensed: 20, tickets_3y: 0, at_fault_accidents_3y: 1, dui_3y: false,
    });
    expect(good.json.ok).toBe(true);
    expect(good.json.license_last4).toBe("0005");
  });

  test("a grouped VIN as read back is accepted", async () => {
    await call("start_quote", { ...C, caller_name: "Sarah Smith", zip: "08540", prior_insurance_months: 36 });
    const r = await call("save_vehicle", { ...C, vehicle_index: 1, vin: "1HGC M826 33A0 04352", usage: "commute", annual_miles: 11000 });
    expect(r.json.ok).toBe(true);
    expect(r.json.vin_verified).toBe(true);
  });

  test("tool calls without eval_tag (live calls) are tagged live; sim ids derive their tag", async () => {
    await call("start_quote", { conversation_id: "conv_live_1", caller_name: "Live Caller", zip: "08540", prior_insurance_months: 12 });
    expect(repo.getQuote("conv_live_1")!.eval_tag).toBe("live");
    await call("start_quote", { conversation_id: "sim_eval-run1-happy-path-t2", caller_name: "Sim Caller", zip: "08540", prior_insurance_months: 12 });
    expect(repo.getQuote("sim_eval-run1-happy-path-t2")!.eval_tag).toBe("eval-run1-happy-path-t2");
  });

  test("upserts are idempotent: re-saving driver 1 does not duplicate", async () => {
    await happyPathToQuote();
    await happyPathToQuote();
    expect(repo.drivers(C.conversation_id).length).toBe(1);
    expect(repo.vehicles(C.conversation_id).length).toBe(1);
  });

  test("ISC-32: every tool call is in the event log", async () => {
    await happyPathToQuote();
    expect((repo.events(C.conversation_id) as unknown[]).length).toBe(5);
  });

  test("Anti ISC-29: the full license number never appears in logs, DB, or admin output", async () => {
    await happyPathToQuote();
    const admin = await (await app.request("/admin/quotes?eval_tag=unit", { headers: { "x-admin-secret": ADMIN } })).text();
    const dump = JSON.stringify(repo.db.query("SELECT * FROM drivers").all()) + JSON.stringify(repo.db.query("SELECT * FROM call_events").all());
    for (const blob of [logs.join("\n"), admin, dump]) expect(blob).not.toContain("S10000000000001");
  });
});

describe("submit_application guards", () => {
  const submit = (over: Record<string, unknown>) =>
    call("submit_application", { ...C, caller_confirmed: true, first_name: "Sarah", last_name: "Smith", ...over });

  test("coverage changed after the price: the old hash is NO_CURRENT_QUOTE (no price on file), not QUOTE_CHANGED", async () => {
    const q = await happyPathToQuote();
    expect((await call("set_coverage", { ...C, package: "premium", pay_in_full: false })).json.ok).toBe(true);
    expect(repo.getQuote(C.conversation_id)).toMatchObject({ status: "open", quote_hash: null });
    expect((await submit({ quote_hash: q.quote_hash })).json).toMatchObject({ ok: false, error: "NO_CURRENT_QUOTE" });
    expect(repo.applicationByQuote(C.conversation_id)).toBeNull();
  });

  test("a hash that isn't the current quote's is QUOTE_CHANGED", async () => {
    const q = await happyPathToQuote();
    const wrong = q.quote_hash.startsWith("0") ? "1" + q.quote_hash.slice(1) : "0" + q.quote_hash.slice(1);
    expect((await submit({ quote_hash: wrong })).json).toMatchObject({ ok: false, error: "QUOTE_CHANGED" });
    expect(repo.applicationByQuote(C.conversation_id)).toBeNull();
  });

  test("the hash is matched case-insensitively and ignoring surrounding spaces (as the agent may echo it)", async () => {
    const q = await happyPathToQuote();
    const r = await submit({ quote_hash: `  ${q.quote_hash.toLowerCase()} ` });
    expect(r.json).toMatchObject({ ok: true, application_number: expect.stringMatching(/^ANA-\d{7}$/) });
    expect(repo.applicationByQuote(C.conversation_id)!.quote_hash).toBe(q.quote_hash);
  });

  test("a blank spelled-back name is NAME_NOT_CONFIRMED; a malformed email is INVALID_EMAIL; neither creates an application", async () => {
    const q = await happyPathToQuote();
    // Whitespace passes the schema's min length and is caught by the service's own check.
    expect((await submit({ quote_hash: q.quote_hash, first_name: " " })).json).toMatchObject({ ok: false, error: "NAME_NOT_CONFIRMED" });
    expect((await submit({ quote_hash: q.quote_hash, last_name: "  " })).json).toMatchObject({ ok: false, error: "NAME_NOT_CONFIRMED" });
    for (const email of ["sarah", "sarah@example", "sarah @example.com"]) {
      expect((await submit({ quote_hash: q.quote_hash, email })).json).toMatchObject({ ok: false, error: "INVALID_EMAIL" });
    }
    expect(repo.applicationByQuote(C.conversation_id)).toBeNull();
    const ok = await submit({ quote_hash: q.quote_hash, email: "sarah@example.com" });
    expect(ok.json.ok).toBe(true);
    expect(repo.applicationByQuote(C.conversation_id)!.email).toBe("sarah@example.com");
  });

  test("a second submit is flagged duplicate and returns the same number", async () => {
    const q = await happyPathToQuote();
    const a = await submit({ quote_hash: q.quote_hash });
    expect(a.json.duplicate).toBeUndefined();
    const b = await submit({ quote_hash: q.quote_hash });
    expect(b.json).toEqual({ ok: true, application_number: a.json.application_number, spoken: a.json.spoken, duplicate: true });
  });

  test("after an application, every save tool is refused with ALREADY_APPLIED and nothing on file changes", async () => {
    const q = await happyPathToQuote();
    expect((await submit({ quote_hash: q.quote_hash })).json.ok).toBe(true);
    const before = { quote: repo.getQuote(C.conversation_id), drivers: repo.drivers(C.conversation_id), vehicles: repo.vehicles(C.conversation_id), reports: repo.reports(C.conversation_id) };
    const attempts: [string, Record<string, unknown>][] = [
      ["save_driver", { driver_index: 1, first_name: "Sarah", last_name: "Smith", date_of_birth: "1988-03-02", license_state: "NJ", license_number: "S10000000000001", years_licensed: 20, tickets_3y: 2, at_fault_accidents_3y: 0, dui_3y: false }],
      ["save_driver", { driver_index: 2, first_name: "Sam", last_name: "Smith", date_of_birth: "1990-03-02", license_state: "NJ", years_licensed: 10, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false }],
      ["save_vehicle", { vehicle_index: 2, year: 2021, make: "Honda", model: "Civic", usage: "pleasure", annual_miles: 5000 }],
      ["set_coverage", { package: "minimum", pay_in_full: true }],
      ["add_license", { driver_index: 1, license_number: "S 1000 0000 0000 99" }],
    ];
    for (const [name, body] of attempts) {
      expect({ name, ...(await call(name, { ...C, ...body })).json }).toMatchObject({ name, ok: false, error: "ALREADY_APPLIED" });
    }
    expect({ quote: repo.getQuote(C.conversation_id), drivers: repo.drivers(C.conversation_id), vehicles: repo.vehicles(C.conversation_id), reports: repo.reports(C.conversation_id) }).toEqual(before);
  });
});

describe("pages", () => {
  const auth = { authorization: "Basic " + Buffer.from("max:pw-pw-pw-pw").toString("base64") };

  test("ISC-22/23: quote summary renders, gated, DEMO-stamped, license masked", async () => {
    const q = await happyPathToQuote();
    const sub = await call("submit_application", { ...C, quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Sarah", last_name: "Smith" });
    const url = `/q/${sub.json.application_number}`;
    expect((await app.request(url)).status).toBe(401);
    const res = await app.request(url, { headers: auth });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("DEMO");
    expect(html).toContain("AI-Native Auto Insurance");
    expect(html).toContain("••••0001");
    expect(html).not.toContain("S10000000000001");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });

  test("ops console is gated and lists calls", async () => {
    await happyPathToQuote();
    expect((await app.request("/ops?tag=unit")).status).toBe(401);
    const res = await app.request("/ops?tag=unit", { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Sarah Smith");
    expect((await app.request(`/ops/quote/${C.conversation_id}`, { headers: auth })).status).toBe(200);
  });

  test("ops detail backfills the caller number from call metadata (off the voice path)", async () => {
    const withMeta = createApp({
      repo, toolSecret: SECRET, opsUser: "max", opsPassword: "pw-pw-pw-pw",
      fetchMeta: async () => ({ callerPhone: "caller-under-test", durationSecs: 125, termination: "end_call tool" }),
    });
    await happyPathToQuote();
    const html = await (await withMeta.request(`/ops/quote/${C.conversation_id}`, { headers: auth })).text();
    expect(html).toContain("caller-under-test");
    expect(html).toContain("2m 05s");
    expect(repo.getQuote(C.conversation_id)!.caller_phone).toBe("caller-under-test");
  });

  test("ops console fails closed when creds are unset", async () => {
    const closed = createApp({ repo, toolSecret: SECRET });
    expect((await closed.request("/ops")).status).toBe(503);
    expect((await closed.request("/admin/quotes?eval_tag=x", { headers: { "x-admin-secret": "" } })).status).toBe(401);
  });

  test("every public route declares the right content type (no octet-stream downloads)", async () => {
    const root = await app.request("/");
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/ops");
    expect((await app.request("/robots.txt")).headers.get("content-type")).toContain("text/plain");
    expect((await app.request("/health")).headers.get("content-type")).toContain("application/json");
    const ops = await app.request("/ops", { headers: auth });
    expect(ops.headers.get("content-type")).toContain("text/html");
    expect(ops.headers.get("x-robots-tag")).toContain("noindex");
    const unauthorized = await app.request("/ops");
    expect(unauthorized.headers.get("content-type")).toContain("text/plain");
    expect(unauthorized.headers.get("x-robots-tag")).toContain("noindex");
    const tool = await app.request("/tools/get_quote", { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": SECRET }, body: "{}" });
    expect(tool.headers.get("content-type")).toContain("application/json");
    expect(tool.headers.get("x-robots-tag")).toContain("noindex");
  });

  test("ISC-28: health reports version and db", async () => {
    expect(await (await app.request("/health")).json()).toMatchObject({ ok: true, db: "up" });
    expect(await (await app.request("/robots.txt")).text()).toContain("Disallow: /");
  });
});

describe("schema", () => {
  test("ISC-30/31: migration is idempotent; tables exist; FKs on", () => {
    const db = openDb(":memory:");
    const { migrate } = require("../src/db");
    migrate(db);
    migrate(db);
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ["quotes", "drivers", "vehicles", "reports", "applications", "call_events"]) expect(tables).toContain(t);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });
});
