import { expect, test } from "bun:test";
import fc from "fast-check";
import { openDb, Repo } from "../src/db";
import { createFieldCipher } from "../src/security/crypto";
import { SlidingWindowLimiter } from "../src/security/rateLimit";
import { createApp } from "../src/server/app";
import { QuoteService, RESUME_MAX_ATTEMPTS, RESUME_TOKEN_TTL_MS, RESUME_WINDOW_DAYS } from "../src/service";

// Model-based test of the whole quote line through the real HTTP tool surface (fast-check fc.commands).
// Random interleavings of every tool, hang-ups and call backs (same number or another), clock jumps, and verbatim
// webhook replays. A deliberately small model predicts each tool's outcome; after EVERY command the database is
// checked against the model and the invariants from the 2026-10-16 audit (applied quotes frozen, one application
// per lineage, estimates never persisted, the caller-wide DOB budget, transferred/declined never revived, prices
// deterministic against a fresh uninterrupted call, transferred quotes refuse every data-collecting tool).
//
// Known Bun bug (Bun 1.3.x + hono/body-limit): after ~9k in-process app.request() calls in ONE test process, every
// request body arrives empty ("undefined is not a function" from the body stream) for the rest of that process, in
// every test file. It does not reproduce over a real socket. So this file talks to a real Bun.serve socket by default
// (MODEL_INPROCESS=1 switches back to app.request), and the fresh-call price baselines are cached to keep the request
// count down. If unrelated suites start failing on empty bodies, count in-process requests before suspecting the code.
// Also in docs/RUNBOOK.md, Testing notes.
//
// Runs: MODEL_RUNS (default 60) with a fixed seed so CI is repeatable. MODEL_SEED overrides the seed; set
// MODEL_RUNS=2000 locally for a deep soak. A failure prints the shrunk command sequence and the seed.

const SECRET = "test-secret-test-secret-123456";
const INIT = "initiation-secret-initiation-secret";
const PHONES = ["+12155550199", "+16095550123"] as const;
const DAY = 86400_000;
const RUNS = Number(process.env.MODEL_RUNS ?? 100);
const SEED = process.env.MODEL_SEED ? Number(process.env.MODEL_SEED) : 20261016;
const SOCKET = !process.env.MODEL_INPROCESS;
const STATS: Record<string, number> | null = process.env.MODEL_STATS ? {} : null;
type Body = Record<string, unknown>;
type Res = Record<string, any>;
type St = "PA" | "NJ" | "MI";

// ── Harness (same shape as journeys.test.ts: real app, in-memory DB, injected clock) ─────────────────────────

function build(nowRef: { t: Date }) {
  const repo = new Repo(openDb(":memory:"), createFieldCipher(Buffer.alloc(32, 9).toString("base64")));
  const service = new QuoteService({ repo, now: () => nowRef.t, decode: async () => ({ decoded: null, source: "timeout" }), licenseKey: "model-key" });
  const app = createApp({ repo, service, toolSecret: SECRET, initiationSecret: INIT, limiter: new SlidingWindowLimiter(), now: () => nowRef.t, fetchMeta: async () => null, fetchTranscript: async () => null, log: () => {} });
  // Over a real Bun.serve socket by default (MODEL_INPROCESS=1 for app.request): in-process app.request trips a Bun body-stream bug
  // after ~9k requests per process (see baselines below).
  const server = SOCKET ? Bun.serve({ port: 0, fetch: app.fetch }) : null;
  const request = (path: string, init: RequestInit) => (server ? fetch(`http://localhost:${server.port}${path}`, init) : app.request(path, init));
  const close = () => {
    server?.stop(true);
    repo.db.close();
  };
  const tool = async (name: string, body: Body) => {
    if (STATS) STATS.requests = (STATS.requests ?? 0) + 1;
    return (await (await request(`/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": SECRET }, body: JSON.stringify(body) })).json()) as Res;
  };
  const initiate = async (conversationId: string, callerId: string): Promise<string | null> => {
    const res = await request("/webhooks/elevenlabs/initiation", {
      method: "POST",
      headers: { "content-type": "application/json", "x-initiation-secret": INIT },
      body: JSON.stringify({ caller_id: callerId, agent_id: "agent_x", called_number: "+16095550100", call_sid: "CA1", conversation_id: conversationId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation_config_override?: { agent: { prompt: { prompt: string } } } };
    return body.conversation_config_override?.agent.prompt.prompt.match(/resume_code "([A-Z0-9]+)"/)?.[1] ?? null;
  };
  return { repo, service, tool, initiate, nowRef, close };
}
type Real = ReturnType<typeof build>;

// ── Fixed household data: the same index always means the same person or car, so prices are comparable ──────

const START: Record<St, Body> = {
  PA: { caller_name: "Jordan Reyes", zip: "18940", prior_insurance_months: 300 },
  NJ: { caller_name: "Jordan Reyes", zip: "08540", prior_insurance_months: 24 },
  MI: { caller_name: "Jordan Reyes", zip: "48226", prior_insurance_months: 24, garaging_city: "Detroit" },
};
// NJ-format numbers from the simulated vendor: 1 clean with verified prior, 2 two tickets, 3 an at-fault claim, 4 a DUI (refer).
const DRIVERS: Record<number, Body & { license: string; first_name: string; date_of_birth: string }> = {
  1: { first_name: "Jordan", last_name: "Reyes", date_of_birth: "1971-05-14", license_state: "NJ", license: "S10000000000001", years_licensed: 35, tickets_3y: 1, at_fault_accidents_3y: 0, dui_3y: false },
  2: { first_name: "Casey", last_name: "Reyes", date_of_birth: "1994-06-11", license_state: "NJ", license: "D20000000000002", years_licensed: 10, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false },
  3: { first_name: "Sam", last_name: "Reyes", date_of_birth: "2004-11-02", license_state: "NJ", license: "T50000000000005", years_licensed: 4, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false },
  4: { first_name: "Riley", last_name: "Reyes", date_of_birth: "1990-03-03", license_state: "NJ", license: "R30000000000003", years_licensed: 15, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false },
  5: { first_name: "Extra", last_name: "Reyes", date_of_birth: "1980-05-05", license_state: "NJ", license: "S10000000000001", years_licensed: 20, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false },
};
const VEHICLES: Record<number, Body> = {
  1: { year: 2022, make: "Chevrolet", model: "Suburban", usage: "pleasure", annual_miles: 12000 },
  2: { year: 2019, make: "Honda", model: "Civic", usage: "commute", annual_miles: 9000 },
  3: { year: 2015, make: "Toyota", model: "Camry", usage: "business", annual_miles: 15000 },
  4: { year: 2024, make: "Tesla", model: "Model 3", usage: "commute", annual_miles: 8000, anti_theft: true },
  5: { year: 2020, make: "Ford", model: "F-150", usage: "pleasure", annual_miles: 7000 },
};
const RESTRICTED_PIP = new Set(["opt_out", "250k_excluded", "50k"]);
const MCCA = { from: "2026-07-01", through: "2027-06-30" };

// ── The model ────────────────────────────────────────────────────────────────────────────────────────────────

type Status = "none" | "open" | "quoted" | "referred" | "transferred" | "applied";
interface Cov { pkg: string; pif: boolean; tort: string | null; pip: string | null }
interface Code { token: string; source: string; mint: number; used: boolean }
interface Conv {
  id: string; phone: string; lineage: number;
  row: boolean; started: boolean; state: St | null;
  /** Fake-clock time the quote row was first inserted: created_at is stamped from the service clock. */
  createdAt: number | null;
  drivers: Map<number, boolean>; // index -> licensed
  vehicles: Set<number>;
  cov: Cov | null;
  status: Status;
  hash: string | null; hashes: string[];
  declined: boolean; resumedInto: string | null;
  code: Code | null;
  appliedSnap: unknown; appNumber: string | null;
}
interface Model {
  t0: number; now: number; seq: number; lineages: number;
  convs: Map<string, Conv>; current: string;
  failures: { phone: string; source: string; token: string; mint: number }[];
  tokens: { token: string; conv: string }[];
  last: { tool: string; body: Body; res: Res } | null;
}

const cur = (m: Model) => m.convs.get(m.current)!;
const newConv = (m: Model, phone: string): Conv => {
  const c: Conv = {
    id: `conv_${++m.seq}`, phone, lineage: ++m.lineages, row: false, started: false, createdAt: null, state: null, drivers: new Map(), vehicles: new Set(), cov: null,
    status: "none", hash: null, hashes: [], declined: false, resumedInto: null, code: null, appliedSnap: null, appNumber: null,
  };
  m.convs.set(c.id, c);
  m.current = c.id;
  return c;
};
/** Any rating-input change: a price or referral is dropped (applied and transferred stay what they are). */
const invalidate = (c: Conv) => {
  if (c.status === "quoted" || c.status === "referred") c.status = "open";
  if (c.status !== "applied") c.hash = null;
};
const covComplete = (c: Conv) => Boolean(c.cov && (c.state !== "PA" || c.cov.tort) && (c.state !== "MI" || c.cov.pip));
const quoteFailures = (m: Model, source: string) => m.failures.filter((f) => f.source === source).length;
const tokenFailures = (m: Model, token: string) => m.failures.filter((f) => f.token === token).length;
/** The caller-wide DOB budget window: a failure counts while its code's expiry is inside the last 30 days. */
const callerFailures = (m: Model, phone: string) =>
  m.failures.filter((f) => f.phone === phone && f.mint + RESUME_TOKEN_TTL_MS >= m.now - RESUME_WINDOW_DAYS * DAY).length;
/**
 * The 30-day offer window runs from the quote row's created_at, which the service stamps from its (fake) clock. This
 * used to be "every row is created at real t0" because created_at came from SQLite's real clock (fixed 2026-10-20).
 */
const inWindow = (m: Model, c: Conv) => c.createdAt !== null && m.now - c.createdAt <= RESUME_WINDOW_DAYS * DAY;
/** A quote row's created_at is set by its first insert and never moves (every upsert leaves it alone). */
const insertRow = (m: Model, c: Conv) => {
  c.createdAt ??= m.now;
  c.row = true;
};
const offerable = (m: Model, phone: string, exclude: string) =>
  [...m.convs.values()].filter(
    (c) => c.id !== exclude && c.phone === phone && c.started && c.drivers.has(1) && (c.status === "open" || c.status === "quoted") &&
      !c.resumedInto && inWindow(m, c) && quoteFailures(m, c.id) < RESUME_MAX_ATTEMPTS,
  );

// ── Database views ───────────────────────────────────────────────────────────────────────────────────────────

const strip = (row: object) => Object.fromEntries(Object.entries(row).filter(([k]) => !["id", "quote_id", "created_at", "updated_at"].includes(k)));
/** Everything a quote IS (inputs, price, status, application). Excludes bookkeeping a flag may legitimately touch. */
function content(r: Real, id: string) {
  const q = r.repo.getQuote(id);
  if (!q) return null;
  const { updated_at, created_at, consent_at, consent_status, consent_version, transfer_reason, ...quote } = q as unknown as Record<string, unknown>;
  const app = r.repo.applicationByQuote(id);
  return {
    quote,
    drivers: r.repo.drivers(id).map(strip),
    vehicles: r.repo.vehicles(id).map(strip),
    reports: r.repo.reports(id).map(strip),
    app: app ? strip(app) : null,
  };
}
/** Full state of one conversation for replay comparison (only clocks excluded). */
function full(r: Real, id: string) {
  const q = r.repo.getQuote(id) as unknown as Record<string, unknown> | null;
  const tokens = r.repo.db.query<Record<string, unknown>, [string]>("SELECT token, from_quote_id, failed_attempts, used_at FROM resume_tokens WHERE conversation_id=? ORDER BY token").all(id);
  const apps = r.repo.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM applications").get()!.n;
  const failures = r.repo.db.query<{ n: number }, []>("SELECT COALESCE(SUM(failed_attempts),0) n FROM resume_tokens").get()!.n;
  const quote = q ? Object.fromEntries(Object.entries(q).filter(([k]) => !["updated_at", "consent_at"].includes(k))) : null;
  return { content: content(r, id), quote, tokens, apps, failures };
}
/** Same shape as journeys.test.ts snapshot(): what a resume must carry byte for byte. */
function carried(r: Real, id: string) {
  const q = r.repo.getQuote(id)!;
  return {
    quote: {
      caller_name: q.caller_name, zip: q.zip, state: q.state, territory: q.territory, prior_insurance_months: q.prior_insurance_months,
      package: q.package, pay_in_full: q.pay_in_full, tort_option: q.tort_option, garaging_city: q.garaging_city ?? null,
      pip_medical: q.pip_medical ?? null, pip_confirmed_at: q.pip_confirmed_at ?? null, caller_hash: q.caller_hash ?? null, caller_phone: q.caller_phone ?? null,
    },
    drivers: r.repo.drivers(id).map(strip),
    vehicles: r.repo.vehicles(id).map(strip),
    reports: r.repo.reports(id).map(strip),
  };
}

// ── Invariants, checked after every command ──────────────────────────────────────────────────────────────────

function invariants(m: Model, r: Real) {
  for (const c of m.convs.values()) {
    const q = r.repo.getQuote(c.id);
    const where = { conv: c.id };
    expect({ ...where, row: Boolean(q) }).toEqual({ ...where, row: c.row });
    if (!q) continue;
    // Status is exactly what the model predicts (open/quoted/referred/transferred/applied).
    expect({ ...where, status: q.status as string }).toEqual({ ...where, status: c.status as string });
    // One row per driver/vehicle index, and exactly the indexes the model saved; licensed flags match.
    const ds = r.repo.drivers(c.id);
    expect({ ...where, drivers: ds.map((d) => [d.driver_index, Boolean(d.license_last4)]) }).toEqual({ ...where, drivers: [...c.drivers].sort((a, b) => a[0] - b[0]) });
    expect({ ...where, vehicles: r.repo.vehicles(c.id).map((v) => v.vehicle_index) }).toEqual({ ...where, vehicles: [...c.vehicles].sort((a, b) => a - b) });
    // An estimate (or anything unpriced) is never persisted as a price.
    if (c.status === "open" || c.status === "referred") expect({ ...where, premium: q.six_month_premium, hash: q.quote_hash }).toEqual({ ...where, premium: null, hash: null });
    if (c.status === "quoted") expect({ ...where, hash: q.quote_hash }).toEqual({ ...where, hash: c.hash });
    // An applied quote never changes afterwards.
    if (c.status === "applied") expect({ ...where, applied: content(r, c.id) }).toEqual({ ...where, applied: c.appliedSnap as any });
    // A recording decline is never overwritten.
    if (c.declined) expect({ ...where, reason: q.transfer_reason, consent: q.consent_status }).toEqual({ ...where, reason: "declined_recording", consent: "declined" });
    expect({ ...where, resumed_into: q.resumed_into ?? null }).toEqual({ ...where, resumed_into: c.resumedInto });
  }
  // At most one application per quote lineage (a quote and everything resumed from it).
  const apps = r.repo.db.query<{ quote_id: string }, []>("SELECT quote_id FROM applications").all();
  const perLineage = new Map<number, number>();
  for (const a of apps) {
    const lin = m.convs.get(a.quote_id)!.lineage;
    perLineage.set(lin, (perLineage.get(lin) ?? 0) + 1);
  }
  for (const [lin, n] of perLineage) expect({ lineage: lin, applications: n }).toEqual({ lineage: lin, applications: 1 });
  expect(apps.length).toBe([...m.convs.values()].filter((c) => c.status === "applied").length);
  // DOB budget: every failed check is one the model accepted, and never more than 3 inside the window per number.
  for (const phone of PHONES) {
    const hash = r.service.callerHash(phone);
    const n = r.repo.db.query<{ n: number }, [string]>("SELECT COALESCE(SUM(failed_attempts),0) n FROM resume_tokens WHERE caller_hash=?").get(hash)!.n;
    expect({ phone, failures: n }).toEqual({ phone, failures: m.failures.filter((f) => f.phone === phone).length });
    expect(callerFailures(m, phone)).toBeLessThanOrEqual(RESUME_MAX_ATTEMPTS);
  }
}

// ── Tool calls with predicted outcomes ──────────────────────────────────────────────────────────────────────

async function call(m: Model, r: Real, tool: string, body: Body): Promise<Res> {
  const sent = { conversation_id: m.current, ...body };
  const res = await r.tool(tool, sent);
  m.last = { tool, body: sent, res };
  return res;
}
// On a mismatch the server's hint is printed too.
const expectOutcome = (tool: string, res: Res, error: string | null) => {
  const got = res.ok ? null : res.error;
  expect({ tool, ok: res.ok, error: got, ...(got === error ? {} : { hint: res.hint }) }).toEqual({ tool, ok: error === null, error });
};
const DECLINED = "RECORDING_DECLINED";
/** The shared guard (review 2026-10-16): declined, applied and transferred quotes refuse every data-collecting tool, in that order. */
const lockedErr = (c: Conv) => (c.declined ? DECLINED : c.status === "applied" ? "ALREADY_APPLIED" : c.status === "transferred" ? "TRANSFERRED" : null);

async function startQuote(m: Model, r: Real, st: St, withCity: boolean) {
  const c = cur(m);
  const body = { ...START[st] };
  if (!withCity) delete body.garaging_city;
  const res = await call(m, r, "start_quote", body);
  const err = lockedErr(c) ?? (st === "MI" && !withCity ? "CITY_REQUIRED" : null);
  expectOutcome("start_quote", res, err);
  if (err) return;
  insertRow(m, c);
  c.started = true;
  c.state = st;
  invalidate(c);
  if (c.status === "none") c.status = "open";
}

async function saveDriver(m: Model, r: Real, idx: number, withLicense: boolean, invalid: boolean) {
  const c = cur(m);
  const { license, ...d } = DRIVERS[idx]!;
  const res = await call(m, r, "save_driver", {
    driver_index: idx, ...d, ...(withLicense ? { license_number: license } : {}), ...(invalid ? { date_of_birth: "1971-02-30" } : {}),
  });
  const err = lockedErr(c) ?? (!c.started ? "QUOTE_NOT_STARTED" : idx > 4 ? "TOO_MANY_DRIVERS" : invalid ? "INVALID_DOB" : null);
  expectOutcome("save_driver", res, err);
  if (err) return;
  const licensed = (c.drivers.get(idx) ?? false) || withLicense;
  if (!withLicense) expect(res.license_pending).toBe(!licensed);
  c.drivers.set(idx, licensed);
  invalidate(c);
}

async function addLicense(m: Model, r: Real, idx: number, valid: boolean) {
  const c = cur(m);
  const res = await call(m, r, "add_license", { driver_index: idx, license_number: valid ? DRIVERS[idx]!.license : "12" });
  const err = lockedErr(c) ?? (!c.row ? "QUOTE_NOT_STARTED" : !c.drivers.has(idx) ? "DRIVER_NOT_FOUND" : !valid ? "INVALID_LICENSE" : null);
  expectOutcome("add_license", res, err);
  if (err) return;
  c.drivers.set(idx, true);
  invalidate(c);
  expect(res.license_needed_for).toEqual([...c.drivers].filter(([, l]) => !l).sort((a, b) => a[0] - b[0]).map(([i]) => DRIVERS[i]!.first_name));
}

async function saveVehicle(m: Model, r: Real, idx: number, invalid: boolean) {
  const c = cur(m);
  const res = await call(m, r, "save_vehicle", { vehicle_index: idx, ...VEHICLES[idx], ...(invalid ? { annual_miles: 160000 } : {}) });
  const err = lockedErr(c) ?? (!c.started ? "QUOTE_NOT_STARTED" : idx > 4 ? "TOO_MANY_VEHICLES" : invalid ? "INVALID_MILEAGE" : null);
  expectOutcome("save_vehicle", res, err);
  if (err) return;
  c.vehicles.add(idx);
  invalidate(c);
}

async function setCoverage(m: Model, r: Real, pkg: string, pif: boolean, tort: string | null, pip: string | null, confirmed: boolean) {
  const c = cur(m);
  const res = await call(m, r, "set_coverage", { package: pkg, pay_in_full: pif, tort_option: tort ?? "", pip_medical: pip ?? "", pip_confirmed: confirmed });
  const err = lockedErr(c) ?? (!c.started ? "QUOTE_NOT_STARTED"
    : c.state === "PA" && !tort ? "TORT_OPTION_REQUIRED"
    : c.state === "MI" && !pip ? "PIP_CHOICE_REQUIRED"
    : c.state === "MI" && RESTRICTED_PIP.has(pip!) && !confirmed ? "PIP_ELIGIBILITY_CHECK" : null);
  expectOutcome("set_coverage", res, err);
  if (err) return;
  c.cov = { pkg, pif, tort: c.state === "PA" ? tort : null, pip: c.state === "MI" ? pip : null };
  invalidate(c);
}

/** One uninterrupted call with the same saved inputs, at the same moment: the price every journey must land on. */
// Cached per UTC day and inputs (ages, model years and the MCCA period only move by the day). Besides speed, this keeps the
// suite well under ~9k in-process app.request calls: past that, Bun 1.3 + hono/body-limit starts failing every request
// body in the whole test process ("undefined is not a function"; not reproducible over a real Bun.serve socket).
const baselines = new Map<string, ReturnType<typeof priceOf>>();
async function baseline(m: Model, c: Conv) {
  const key = JSON.stringify([new Date(m.now).toISOString().slice(0, 10), c.state, [...c.drivers].sort(), [...c.vehicles].sort(), c.cov]);
  const hit = baselines.get(key);
  if (hit) return hit;
  const h = build({ t: new Date(m.now) });
  await h.initiate("conv_base", PHONES[0]);
  const run = async (tool: string, body: Body) => {
    const res = await h.tool(tool, { conversation_id: "conv_base", ...body });
    expect({ baseline: tool, ok: res.ok, error: res.error }).toEqual({ baseline: tool, ok: true, error: undefined });
    return res;
  };
  await run("start_quote", START[c.state!]);
  for (const [idx, licensed] of [...c.drivers].sort((a, b) => a[0] - b[0])) {
    const { license, ...d } = DRIVERS[idx]!;
    await run("save_driver", { driver_index: idx, ...d, ...(licensed ? { license_number: license } : {}) });
  }
  for (const idx of [...c.vehicles].sort((a, b) => a - b)) await run("save_vehicle", { vehicle_index: idx, ...VEHICLES[idx] });
  await run("set_coverage", { package: c.cov!.pkg, pay_in_full: c.cov!.pif, tort_option: c.cov!.tort ?? "", pip_medical: c.cov!.pip ?? "", pip_confirmed: true });
  const price = priceOf(await run("get_quote", {}));
  h.close();
  baselines.set(key, price);
  return price;
}
const priceOf = (res: Res) => ({ eligibility: res.eligibility, estimate: Boolean(res.estimate), premium: res.six_month_premium ?? null, hash: res.quote_hash ?? null });

async function getQuote(m: Model, r: Real) {
  const c = cur(m);
  const res = await call(m, r, "get_quote", {});
  const day = new Date(m.now).toISOString().slice(0, 10);
  const err = c.declined ? DECLINED : c.status === "applied" ? "ALREADY_APPLIED" : c.status === "transferred" ? "TRANSFERRED" : !c.started ? "QUOTE_NOT_STARTED"
    : !c.drivers.size || !c.vehicles.size || !covComplete(c) ? "MISSING_INFO"
    : c.state === "MI" && (day < MCCA.from || day > MCCA.through) ? "RATES_UNAVAILABLE" : null;
  expectOutcome("get_quote", res, err);
  if (err) return;
  // Same saved inputs, same price: compare against a fresh uninterrupted call.
  expect(priceOf(res)).toEqual(await baseline(m, c));
  const pending = [...c.drivers.values()].some((l) => !l);
  if (pending) {
    // An estimate (or a referral on self-reported data) saves nothing and is never submittable.
    expect(res.quote_hash).toBeUndefined();
    expect(res.estimate === true || res.eligibility === "REFER").toBe(true);
    // A referral is recorded even on an estimate, so it is never offered for resume (review 2026-10-16).
    if (res.eligibility === "REFER") c.status = "referred";
    return;
  }
  expect(res.estimate).toBeUndefined();
  if (res.eligibility === "REFER") {
    c.status = "referred";
    c.hash = null;
  } else {
    c.status = "quoted";
    c.hash = res.quote_hash;
    c.hashes.push(res.quote_hash);
  }
}

type HashKind = "latest" | "stale" | "wrong";
type NameKind = "ok" | "blank" | "invalid";
async function submit(m: Model, r: Real, hashKind: HashKind, nameKind: NameKind, confirmed: boolean) {
  const c = cur(m);
  const hash = hashKind === "latest" ? (c.hash ?? "NOHASH0000") : hashKind === "stale" ? (c.hashes[0] ?? "STALE00000") : "WRONG00000";
  const names = nameKind === "ok" ? ["Jordan", "Reyes"] : nameKind === "blank" ? ["Jordan", " "] : ["J0rdan", "Reyes"];
  const res = await call(m, r, "submit_application", { quote_hash: hash, caller_confirmed: confirmed, first_name: names[0], last_name: names[1] });
  if (!c.declined && c.status === "applied") {
    // Idempotent: the same application, never a second one.
    expect({ ok: res.ok, duplicate: res.duplicate, n: res.application_number }).toEqual({ ok: true, duplicate: true, n: c.appNumber });
    return;
  }
  const pending = [...c.drivers.values()].some((l) => !l);
  const err = c.declined ? DECLINED : !c.row ? "QUOTE_NOT_STARTED" : !confirmed ? "NOT_CONFIRMED" : c.status === "referred" ? "REFERRED"
    : pending ? "LICENSE_NEEDED" : c.status !== "quoted" || !c.hash ? "NO_CURRENT_QUOTE" : hash !== c.hash ? "QUOTE_CHANGED"
    : nameKind === "blank" ? "NAME_NOT_CONFIRMED" : nameKind === "invalid" ? "INVALID_NAME" : null;
  expectOutcome("submit_application", res, err);
  if (err) return;
  c.status = "applied";
  c.appNumber = res.application_number;
  c.appliedSnap = content(r, c.id);
  expect((c.appliedSnap as any).app).toMatchObject({ quote_hash: c.hash, applicant_name: "Jordan Reyes" });
}

async function flag(m: Model, r: Real, reason: string) {
  const c = cur(m);
  const res = await call(m, r, "flag_for_human", { reason });
  expectOutcome("flag_for_human", res, null);
  insertRow(m, c);
  if (c.status !== "applied") c.status = "transferred";
  if (reason === "declined_recording") c.declined = true;
}

/** Hang up and call back (same number or another): the call-start webhook offers a code only for a resumable quote. */
async function callBack(m: Model, r: Real, phone: string) {
  const c = newConv(m, phone);
  const code = await r.initiate(c.id, phone);
  const eligible = callerFailures(m, phone) < RESUME_MAX_ATTEMPTS ? offerable(m, phone, c.id) : [];
  expect({ offered: code !== null }).toEqual({ offered: eligible.length > 0 });
  if (!code) return;
  const t = r.repo.resumeToken(code)!;
  // Never an applied, transferred, declined, referred, resumed, locked or another number's quote.
  expect(eligible.map((e) => e.id)).toContain(t.from_quote_id);
  c.code = { token: code, source: t.from_quote_id, mint: m.now, used: false };
  m.tokens.push({ token: code, conv: c.id });
}

type ResumeKind = "right" | "wrong" | "foreign";
async function resume(m: Model, r: Real, kind: ResumeKind) {
  const c = cur(m);
  const foreign = [...m.tokens].reverse().find((t) => t.conv !== c.id);
  const token = kind === "foreign" ? foreign!.token : c.code!.token;
  const right = kind !== "wrong";
  const code = kind === "foreign" ? null : c.code!;
  const res = await call(m, r, "resume_quote", { resume_code: token, date_of_birth: right ? DRIVERS[1]!.date_of_birth : "1980-01-01" });
  const before = r.repo.drivers(c.id).length;
  const locked = () => !code || tokenFailures(m, code.token) >= RESUME_MAX_ATTEMPTS || quoteFailures(m, code.source) >= RESUME_MAX_ATTEMPTS || callerFailures(m, c.phone) >= RESUME_MAX_ATTEMPTS;
  let err: string | null;
  if (c.declined) err = DECLINED;
  else if (!code) err = "RESUME_UNAVAILABLE";
  else if (code.used) {
    // Idempotent on the call that resumed (review 2026-10-16): the same success, nothing copied or changed again.
    expectOutcome("resume_quote", res, null);
    expect(res.first_name).toBe(DRIVERS[1]!.first_name);
    expect(r.repo.drivers(c.id).length).toBe(before);
    return;
  }
  else if (code.mint + RESUME_TOKEN_TTL_MS < m.now) err = "RESUME_EXPIRED";
  else if (c.drivers.size || c.vehicles.size || c.status === "applied") err = "RESUME_UNAVAILABLE";
  else if (locked()) err = "RESUME_LOCKED";
  else if (!right) {
    m.failures.push({ phone: c.phone, source: code.source, token: code.token, mint: code.mint });
    err = locked() ? "RESUME_LOCKED" : "DOB_MISMATCH";
  } else err = null;
  expectOutcome("resume_quote", res, err);
  if (err) {
    // Nothing on file is revealed before a correct date of birth.
    for (const k of ["first_name", "drivers", "vehicles", "package", "state"]) expect(res).not.toHaveProperty(k);
    expect(r.repo.drivers(c.id).length).toBe(before);
    return;
  }
  const src = m.convs.get(code!.source)!;
  code!.used = true;
  // The verified quote's misses are forgiven, and ONLY that quote's: a spoofer verifying a quote they made themselves
  // must not reset the misses against someone else's quote on the same number (review 2026-10-16).
  m.failures = m.failures.filter((f) => f.source !== code!.source);
  src.resumedInto = c.id;
  // Every saved driver, vehicle, coverage choice and report comes across exactly.
  expect(carried(r, c.id)).toEqual(carried(r, src.id));
  expect(res.first_name).toBe(DRIVERS[1]!.first_name);
  insertRow(m, c);
  Object.assign(c, {
    row: true, started: true, state: src.state, lineage: src.lineage, drivers: new Map(src.drivers), vehicles: new Set(src.vehicles),
    cov: src.cov ? { ...src.cov } : null, status: c.status === "transferred" ? "transferred" : "open", hash: null,
  });
}

/** Webhook retry: the previous tool call verbatim. Nothing changes beyond the first call (get_quote re-prices to the same hash). */
async function duplicate(m: Model, r: Real) {
  const last = m.last!;
  const conv = String(last.body.conversation_id);
  const before = full(r, conv);
  const res = await r.tool(last.tool, last.body);
  expect({ tool: last.tool, ok: res.ok, error: res.error }).toEqual({ tool: last.tool, ok: last.res.ok, error: last.res.error });
  if (last.tool === "get_quote" && res.ok) expect(priceOf(res)).toEqual(priceOf(last.res));
  if (last.tool === "submit_application" && res.ok) expect(res.application_number).toBe(last.res.application_number);
  expect({ replay: last.tool, state: full(r, conv) }).toEqual({ replay: last.tool, state: before });
}

/** The caller answers everything still missing, then asks for the price (drives runs deep enough to apply). */
async function fill(m: Model, r: Real, st: St) {
  const c = cur(m);
  if (!c.started) await startQuote(m, r, st, true);
  if (!c.drivers.has(1)) await saveDriver(m, r, 1, true, false);
  if (!c.vehicles.size) await saveVehicle(m, r, 1, false);
  if (!covComplete(c)) await setCoverage(m, r, "recommended", false, "full", "unlimited", false);
  await getQuote(m, r);
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────────────────

class Cmd implements fc.AsyncCommand<Model, Real> {
  constructor(
    private readonly label: string,
    private readonly act: (m: Model, r: Real) => Promise<void>,
    private readonly pre: (m: Model) => boolean = () => true,
  ) {}
  check(m: Readonly<Model>) {
    return this.pre(m as Model);
  }
  async run(m: Model, r: Real) {
    await this.act(m, r);
    if (STATS && m.last) {
      const k = `${m.last.tool}:${m.last.res.ok ? "ok" : m.last.res.error}`;
      STATS[k] = (STATS[k] ?? 0) + 1;
    }
    invariants(m, r);
  }
  toString() {
    return this.label;
  }
}

const state = fc.constantFrom<St>("PA", "NJ", "MI");
const idx = fc.integer({ min: 1, max: 5 });
const live = (m: Model) => !cur(m).declined && cur(m).status !== "applied" && cur(m).status !== "transferred";

const kinds = [
  fc.tuple(state, fc.boolean()).map(([st, city]) => new Cmd(`start_quote(${st}${st === "MI" ? (city ? ",city" : ",no city") : ""})`, (m, r) => startQuote(m, r, st, city || st !== "MI"))),
  fc.tuple(idx, fc.boolean(), fc.nat(9)).map(([i, lic, bad]) => new Cmd(`save_driver(${i},${lic ? "license" : "no license"}${bad === 0 ? ",invalid" : ""})`, (m, r) => saveDriver(m, r, i, lic, bad === 0))),
  fc.tuple(idx, fc.nat(4)).map(([i, bad]) => new Cmd(`add_license(${i}${bad === 0 ? ",invalid" : ""})`, (m, r) => addLicense(m, r, i, bad !== 0))),
  fc.tuple(idx, fc.nat(9)).map(([i, bad]) => new Cmd(`save_vehicle(${i}${bad === 0 ? ",invalid" : ""})`, (m, r) => saveVehicle(m, r, i, bad === 0))),
  fc
    .tuple(
      fc.constantFrom("minimum", "recommended", "premium"),
      fc.boolean(),
      fc.constantFrom<string | null>("limited", "full", null),
      fc.constantFrom<string | null>("unlimited", "500k", "opt_out", "250k_excluded", "50k", null),
      fc.boolean(),
    )
    .map(([p, pif, t, pip, ok]) => new Cmd(`set_coverage(${p},${pif ? "pif" : "monthly"},tort=${t},pip=${pip}${ok ? ",confirmed" : ""})`, (m, r) => setCoverage(m, r, p, pif, t, pip, ok))),
  fc.constant(new Cmd("get_quote", getQuote)),
  fc
    .tuple(fc.constantFrom<HashKind>("latest", "latest", "stale", "wrong"), fc.constantFrom<NameKind>("ok", "ok", "ok", "blank", "invalid"), fc.nat(5))
    .map(([h, n, nc]) => new Cmd(`submit_application(${h} hash,${n} name${nc === 0 ? ",unconfirmed" : ""})`, (m, r) => submit(m, r, h, n, nc !== 0))),
  fc.constantFrom("caller_requested", "underwriting_referral", "caller_requested", "declined_recording").map((why) => new Cmd(`flag_for_human(${why})`, (m, r) => flag(m, r, why))),
  fc.constantFrom(0, 0, 1).map((p) => new Cmd(p === 0 ? "HANG_UP_CALL_BACK" : "CALL_FROM_ANOTHER_NUMBER", (m, r) => callBack(m, r, PHONES[p]!))),
  fc.constantFrom<ResumeKind>("right", "right", "wrong", "wrong", "foreign").map(
    (k) =>
      new Cmd(`resume_quote(${k === "foreign" ? "another call's code" : k + " DOB"})`, (m, r) => resume(m, r, k), (m) =>
        k === "foreign" ? m.tokens.some((t) => t.conv !== m.current) : cur(m).code !== null),
  ),
  fc.constantFrom(1, 1, 20, 20, 31, 24 * 60, 10 * 24 * 60, 31 * 24 * 60).map(
    (min) =>
      new Cmd(`ADVANCE_CLOCK(${min}m)`, async (m, r) => {
        m.now += min * 60_000;
        r.nowRef.t = new Date(m.now);
        m.last = null; // a retry minutes or days later is a new call, not a replay
      }),
  ),
  fc.constant(new Cmd("DUPLICATE", duplicate, (m) => m.last !== null && m.last.tool !== "resume_quote")),
  state.map((st) => new Cmd(`FILL_AND_PRICE(${st})`, (m, r) => fill(m, r, st), live)),
];

/** Runs the model with the command kinds above weighted as given (same order; 0 leaves a kind out). */
function property(weights: number[], runs: number) {
  const commands = kinds.flatMap((k, i) => Array<fc.Arbitrary<Cmd>>(weights[i]!).fill(k));
  return fc.assert(
    fc.asyncProperty(fc.commands(commands, { maxCommands: 60, size: "max" }), async (cmds) => {
      const t0 = Date.now();
      const real = build({ t: new Date(t0) });
      const model: Model = { t0, now: t0, seq: 0, lineages: 0, convs: new Map(), current: "", failures: [], tokens: [], last: null };
      newConv(model, PHONES[0]);
      expect(await real.initiate(model.current, PHONES[0])).toBeNull();
      try {
        await fc.asyncModelRun(() => ({ model, real }), cmds);
      } finally {
        real.close();
      }
    }),
    { numRuns: runs, seed: SEED, verbose: 1, ...(process.env.MODEL_PATH ? { path: process.env.MODEL_PATH } : {}) },
  );
}
const printStats = () => STATS && console.log(Object.entries(STATS).sort().map(([k, v]) => `${k} ${v}`).join("\n"));

// Order: start, save_driver, add_license, save_vehicle, set_coverage, get_quote, submit, flag, call back, resume, clock, duplicate, fill.
test(`model: every tool interleaved with hang-ups, replays and clock jumps (${RUNS} runs, seed ${SEED})`, async () => {
  // Terminal moves (flags, long clock jumps) stay light so runs reach applications and resumes.
  await property([2, 4, 2, 3, 3, 3, 4, 1, 3, 4, 2, 2, 3], RUNS);
  printStats();
}, 120_000);

test(`model: returning callers, resume codes and the caller-wide DOB budget (${RUNS} runs, seed ${SEED})`, async () => {
  await property([1, 1, 1, 0, 0, 0, 1, 1, 5, 6, 2, 0, 3], RUNS);
  printStats();
}, 120_000);
