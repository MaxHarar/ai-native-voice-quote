import { Database } from "bun:sqlite";
import { createFieldCipher, DEV_ENCRYPTION_KEY, type FieldCipher } from "../security/crypto";
import type { DecodedVin, VinCache } from "../verify/vpic";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,                -- ElevenLabs conversation_id (server-side session key)
  eval_tag TEXT NOT NULL DEFAULT 'live',
  caller_name TEXT,
  caller_phone TEXT,
  zip TEXT,
  state TEXT,
  territory INTEGER,
  tort_option TEXT,
  prior_insurance_months INTEGER,
  package TEXT,
  pay_in_full INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','quoted','referred','applied','transferred')),
  transfer_reason TEXT,
  quote_hash TEXT,
  six_month_premium INTEGER,
  monthly_payment REAL,
  rating_json TEXT,
  eligibility_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS quotes_eval_tag ON quotes(eval_tag);

CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  driver_index INTEGER NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  dob TEXT NOT NULL,
  license_state TEXT NOT NULL,
  license_hash TEXT NOT NULL,          -- HMAC; the full number is never stored
  license_last4 TEXT NOT NULL,
  years_licensed INTEGER NOT NULL,
  sr_tickets_3y INTEGER NOT NULL,
  sr_at_fault_3y INTEGER NOT NULL,
  sr_dui_3y INTEGER NOT NULL,
  UNIQUE (quote_id, driver_index)
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  vehicle_index INTEGER NOT NULL,
  vin TEXT,
  vin_verified INTEGER NOT NULL DEFAULT 0,
  year INTEGER NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  body_class TEXT NOT NULL,
  usage TEXT NOT NULL,
  rideshare INTEGER NOT NULL DEFAULT 0,
  annual_miles INTEGER NOT NULL,
  anti_theft INTEGER NOT NULL DEFAULT 0,
  UNIQUE (quote_id, vehicle_index)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  driver_index INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('MVR','CLUE','PRIOR')),
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (quote_id, driver_index, kind)
);

CREATE TABLE IF NOT EXISTS applications (
  app_number TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id) ON DELETE CASCADE,
  quote_hash TEXT NOT NULL,
  six_month_premium INTEGER NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS call_events (
  id INTEGER PRIMARY KEY,
  quote_id TEXT,
  tool TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT,
  ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS call_events_quote ON call_events(quote_id);

-- Live call outcomes from ElevenLabs post-call webhooks (no transcripts are stored; data minimization).
CREATE TABLE IF NOT EXISTS calls (
  conversation_id TEXT PRIMARY KEY,
  agent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('call','initiation_failure')),
  status TEXT,
  is_test INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  started_at TEXT,
  duration_secs INTEGER,
  termination_reason TEXT,
  error TEXT,
  caller_phone TEXT,                   -- encrypted
  call_successful TEXT,
  evaluation_json TEXT,
  cost REAL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS calls_received ON calls(received_at);

-- Conversation-quality counts per call (src/ops/callMetrics.ts). Counts and timings only, never transcript text.
CREATE TABLE IF NOT EXISTS call_metrics (
  conversation_id TEXT PRIMARY KEY,
  is_test INTEGER NOT NULL DEFAULT 0,
  metrics_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS call_metrics_created ON call_metrics(created_at);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  channels TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS alerts_key ON alerts(key, created_at);

-- Append-only audit of every request to the ops console, quote summaries and admin endpoints.
CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY,
  ip TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  principal TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Caller number captured at call start (ElevenLabs initiation webhook), keyed by conversation.
CREATE TABLE IF NOT EXISTS call_bindings (
  conversation_id TEXT PRIMARY KEY,
  caller_phone TEXT NOT NULL,          -- encrypted
  caller_hash TEXT NOT NULL,           -- HMAC, for lookups
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Single-use codes that let a returning caller resume a quote after verifying their date of birth.
CREATE TABLE IF NOT EXISTS resume_tokens (
  token TEXT PRIMARY KEY,
  from_quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  caller_hash TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  used_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS vin_cache (
  vin TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

export interface QuoteRow {
  id: string; eval_tag: string; caller_name: string | null; caller_phone: string | null; zip: string | null;
  state: "NJ" | "PA" | "MI" | null; territory: number | null; tort_option: "limited" | "full" | null;
  /** MI: where the car is garaged (territories are municipal there), the PIP medical election, and when its eligibility and disclosure were confirmed. */
  garaging_city?: string | null; pip_medical?: string | null; pip_confirmed_at?: string | null; caller_hash?: string | null; resumed_into?: string | null;
  consent_version?: string | null; consent_at?: string | null; consent_status?: "continued" | "declined" | null; prior_insurance_months: number | null; package: string | null; pay_in_full: number | null;
  status: "open" | "quoted" | "referred" | "applied" | "transferred"; transfer_reason: string | null;
  quote_hash: string | null; six_month_premium: number | null; monthly_payment: number | null;
  rating_json: string | null; eligibility_json: string | null; created_at: string; updated_at: string;
}
export interface DriverRow {
  id: number; quote_id: string; driver_index: number; first_name: string; last_name: string; dob: string;
  license_state: string; license_hash: string; license_last4: string; years_licensed: number;
  sr_tickets_3y: number; sr_at_fault_3y: number; sr_dui_3y: number;
}
export interface VehicleRow {
  id: number; quote_id: string; vehicle_index: number; vin: string | null; vin_verified: number; year: number;
  make: string; model: string; body_class: string; usage: string; rideshare: number; annual_miles: number; anti_theft: number;
}
export interface ReportRow { quote_id: string; driver_index: number; kind: "MVR" | "CLUE" | "PRIOR"; source: string; payload_json: string; created_at: string }
export interface ApplicationRow { app_number: string; quote_id: string; quote_hash: string; six_month_premium: number; email: string | null; applicant_name: string | null; pending_requirements?: string | null; created_at: string }

export function openDb(path = process.env.DATABASE_PATH ?? "data/quotes.sqlite"): Database {
  if (path !== ":memory:") {
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir) Bun.spawnSync(["mkdir", "-p", dir]);
  }
  const db = new Database(path, { create: true, strict: true });
  // WAL + synchronous=NORMAL is durable across process crashes and fast; busy_timeout absorbs short contention (e.g. a backup snapshot).
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  migrate(db);
  return db;
}

/** Columns added after the first production deploy; ALTERed onto existing databases on boot. */
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: "quotes", column: "state", ddl: "ALTER TABLE quotes ADD COLUMN state TEXT" },
  { table: "quotes", column: "tort_option", ddl: "ALTER TABLE quotes ADD COLUMN tort_option TEXT" },
  { table: "applications", column: "applicant_name", ddl: "ALTER TABLE applications ADD COLUMN applicant_name TEXT" },
  { table: "quotes", column: "caller_hash", ddl: "ALTER TABLE quotes ADD COLUMN caller_hash TEXT" },
  { table: "quotes", column: "resumed_into", ddl: "ALTER TABLE quotes ADD COLUMN resumed_into TEXT" },
  { table: "quotes", column: "garaging_city", ddl: "ALTER TABLE quotes ADD COLUMN garaging_city TEXT" },
  { table: "quotes", column: "pip_medical", ddl: "ALTER TABLE quotes ADD COLUMN pip_medical TEXT" },
  { table: "quotes", column: "pip_confirmed_at", ddl: "ALTER TABLE quotes ADD COLUMN pip_confirmed_at TEXT" },
  // Recording consent record: which disclosure the caller heard, when we first had it, and whether they continued or declined.
  { table: "quotes", column: "consent_version", ddl: "ALTER TABLE quotes ADD COLUMN consent_version TEXT" },
  { table: "quotes", column: "consent_at", ddl: "ALTER TABLE quotes ADD COLUMN consent_at TEXT" },
  { table: "quotes", column: "consent_status", ddl: "ALTER TABLE quotes ADD COLUMN consent_status TEXT" },
  // JSON array of what the specialist still needs before a policy can issue (e.g. the signed PA tort form).
  { table: "applications", column: "pending_requirements", ddl: "ALTER TABLE applications ADD COLUMN pending_requirements TEXT" },
];

export function migrate(db: Database) {
  db.exec(SCHEMA);
  for (const c of ADDED_COLUMNS) {
    const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${c.table})`).all().map((r) => r.name);
    if (!cols.includes(c.column)) db.exec(c.ddl);
  }
  // Quotes priced before Pennsylvania shipped have a territory but no state; the line only accepted New Jersey ZIPs then.
  // Backfilled so nothing downstream needs a silent NJ default (review 2026-10-16). Out-of-state shells have no territory.
  db.exec("UPDATE quotes SET state='NJ' WHERE state IS NULL AND territory IS NOT NULL");
  const quoteCols = db.query<{ name: string }, []>("PRAGMA table_info(quotes)").all().map((r) => r.name);
  if (quoteCols.includes("caller_hash") && quoteCols.includes("created_at")) db.exec("CREATE INDEX IF NOT EXISTS quotes_caller ON quotes(caller_hash, created_at)");
}

export interface CallRow {
  conversation_id: string; agent_id: string | null; kind: "call" | "initiation_failure"; status: string | null; is_test: number; source: string | null;
  started_at: string | null; duration_secs: number | null; termination_reason: string | null; error: string | null; caller_phone: string | null;
  call_successful: string | null; evaluation_json: string | null; cost: number | null; received_at: string;
}

/**
 * created_at for rows the service windows on (resume window, retention). Callers pass the service clock's now(); the
 * fallback is the real clock, the same instant SQLite's column default used to stamp. Root cause of the journeys
 * "after 30 days" flake (pinned in 36b87a9): created_at came from SQLite's clock while the window compared it with the
 * service's injected now(), so a pinned-clock test depended on the day the suite ran.
 */
const stamp = (iso?: string) => iso ?? new Date().toISOString();

export class Repo {
  constructor(
    readonly db: Database,
    private readonly cipher: FieldCipher = createFieldCipher(DEV_ENCRYPTION_KEY),
  ) {}

  private enc(v: string | null | undefined): string | null {
    return v === null || v === undefined || v === "" ? (v ?? null) : this.cipher.encrypt(v);
  }
  private dec(v: string | null): string | null {
    return v === null ? null : this.cipher.decrypt(v);
  }
  private decQuote(q: QuoteRow | null): QuoteRow | null {
    return q ? { ...q, caller_phone: this.dec(q.caller_phone) } : null;
  }

  /** Runs fn in one transaction (nested calls become savepoints). */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getQuote(id: string): QuoteRow | null {
    return this.decQuote(this.db.query<QuoteRow, [string]>("SELECT * FROM quotes WHERE id = ?").get(id));
  }

  upsertQuoteStart(q: {
    id: string; evalTag: string; callerName: string; callerPhone: string | null; zip: string; state: string; territory: number; priorInsuranceMonths: number;
    garagingCity?: string | null; createdAt?: string;
  }) {
    this.db
      .query(
        `INSERT INTO quotes (id, eval_tag, caller_name, caller_phone, zip, state, territory, prior_insurance_months, garaging_city, created_at)
         VALUES ($id, $evalTag, $callerName, $callerPhone, $zip, $state, $territory, $priorInsuranceMonths, $garagingCity, $createdAt)
         ON CONFLICT(id) DO UPDATE SET caller_name=excluded.caller_name, caller_phone=COALESCE(excluded.caller_phone, caller_phone),
           zip=excluded.zip, state=excluded.state, territory=excluded.territory, prior_insurance_months=excluded.prior_insurance_months,
           garaging_city=excluded.garaging_city, eval_tag=excluded.eval_tag, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE quotes.status <> 'applied'`,
      )
      .run({ ...q, garagingCity: q.garagingCity ?? null, callerPhone: this.enc(q.callerPhone), createdAt: stamp(q.createdAt) });
  }

  /** Out-of-state callers are never quoted, but the human taking the hand-off needs who called and from where. */
  upsertOutOfState(q: { id: string; evalTag: string; callerName: string; zip: string; createdAt?: string }) {
    this.db
      .query(
        `INSERT INTO quotes (id, eval_tag, caller_name, zip, created_at) VALUES ($id, $evalTag, $callerName, $zip, $createdAt)
         ON CONFLICT(id) DO UPDATE SET caller_name=excluded.caller_name, zip=excluded.zip, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run({ ...q, createdAt: stamp(q.createdAt) });
  }

  /** Ensures a quote shell exists (e.g. a transfer flagged before start_quote). */
  /** The caller heard the disclosure and kept going. Never overwrites a decline, and keeps the first timestamp. */
  recordConsent(id: string, version: string) {
    this.db
      .query("UPDATE quotes SET consent_version=COALESCE(consent_version, ?), consent_at=COALESCE(consent_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')), consent_status=COALESCE(consent_status, 'continued') WHERE id=?")
      .run(version, id);
  }

  recordConsentDeclined(id: string, version: string) {
    this.db
      .query("UPDATE quotes SET consent_version=?, consent_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), consent_status='declined' WHERE id=?")
      .run(version, id);
  }

  saveCallMetrics(conversationId: string, isTest: boolean, metrics: object) {
    this.db
      .query("INSERT INTO call_metrics (conversation_id, is_test, metrics_json) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET is_test=excluded.is_test, metrics_json=excluded.metrics_json")
      .run(conversationId, isTest ? 1 : 0, JSON.stringify(metrics));
  }

  callMetrics(conversationId: string): { conversation_id: string; is_test: number; metrics_json: string; created_at: string } | null {
    return this.db.query<{ conversation_id: string; is_test: number; metrics_json: string; created_at: string }, [string]>("SELECT * FROM call_metrics WHERE conversation_id=?").get(conversationId) ?? null;
  }

  /** Most recent live calls first. */
  recentCallMetrics(limit = 50): { conversation_id: string; metrics_json: string; created_at: string }[] {
    return this.db
      .query<{ conversation_id: string; metrics_json: string; created_at: string }, [number]>("SELECT conversation_id, metrics_json, created_at FROM call_metrics WHERE is_test=0 ORDER BY created_at DESC LIMIT ?")
      .all(limit);
  }

  ensureQuote(id: string, evalTag: string, createdAt?: string) {
    this.db.query("INSERT OR IGNORE INTO quotes (id, eval_tag, created_at) VALUES (?, ?, ?)").run(id, evalTag, stamp(createdAt));
  }

  /** Any change to rating inputs invalidates a previously issued quote hash. */
  invalidateQuote(id: string) {
    this.db
      .query(
        `UPDATE quotes SET quote_hash=NULL, six_month_premium=NULL, monthly_payment=NULL, rating_json=NULL, eligibility_json=NULL,
           status=CASE WHEN status IN ('quoted','referred') THEN 'open' ELSE status END, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=? AND status <> 'applied'`,
      )
      .run(id);
  }

  upsertDriver(d: Omit<DriverRow, "id">) {
    this.db
      .query(
        `INSERT INTO drivers (quote_id, driver_index, first_name, last_name, dob, license_state, license_hash, license_last4, years_licensed, sr_tickets_3y, sr_at_fault_3y, sr_dui_3y)
         VALUES ($quote_id, $driver_index, $first_name, $last_name, $dob, $license_state, $license_hash, $license_last4, $years_licensed, $sr_tickets_3y, $sr_at_fault_3y, $sr_dui_3y)
         ON CONFLICT(quote_id, driver_index) DO UPDATE SET first_name=excluded.first_name, last_name=excluded.last_name, dob=excluded.dob,
           license_state=excluded.license_state, license_hash=excluded.license_hash, license_last4=excluded.license_last4,
           years_licensed=excluded.years_licensed, sr_tickets_3y=excluded.sr_tickets_3y, sr_at_fault_3y=excluded.sr_at_fault_3y, sr_dui_3y=excluded.sr_dui_3y`,
      )
      .run({ ...d, dob: this.enc(d.dob)! });
  }

  upsertVehicle(v: Omit<VehicleRow, "id">) {
    this.db
      .query(
        `INSERT INTO vehicles (quote_id, vehicle_index, vin, vin_verified, year, make, model, body_class, usage, rideshare, annual_miles, anti_theft)
         VALUES ($quote_id, $vehicle_index, $vin, $vin_verified, $year, $make, $model, $body_class, $usage, $rideshare, $annual_miles, $anti_theft)
         ON CONFLICT(quote_id, vehicle_index) DO UPDATE SET vin=excluded.vin, vin_verified=excluded.vin_verified, year=excluded.year, make=excluded.make,
           model=excluded.model, body_class=excluded.body_class, usage=excluded.usage, rideshare=excluded.rideshare,
           annual_miles=excluded.annual_miles, anti_theft=excluded.anti_theft`,
      )
      .run(v);
  }

  upsertReport(r: Omit<ReportRow, "created_at">) {
    this.db
      .query(
        `INSERT INTO reports (quote_id, driver_index, kind, source, payload_json) VALUES ($quote_id, $driver_index, $kind, $source, $payload_json)
         ON CONFLICT(quote_id, driver_index, kind) DO UPDATE SET source=excluded.source, payload_json=excluded.payload_json,
           created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run(r);
  }

  setCoverage(id: string, pkg: string, payInFull: boolean, tortOption: string | null, pip: { level: string; confirmedAt: string | null } | null = null) {
    this.db
      .query(
        "UPDATE quotes SET package=?, pay_in_full=?, tort_option=?, pip_medical=?, pip_confirmed_at=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
      )
      .run(pkg, payInFull ? 1 : 0, tortOption, pip?.level ?? null, pip?.confirmedAt ?? null, id);
  }

  /**
   * Never touches an applied quote (its hash and price are what the application was issued on) or a transferred one
   * (re-rating would make a quote handed to a human submittable and resumable again).
   */
  saveRated(id: string, r: { status: "quoted" | "referred"; quoteHash: string | null; sixMonthPremium: number | null; monthlyPayment: number | null; ratingJson: string | null; eligibilityJson: string }) {
    this.db
      .query(
        `UPDATE quotes SET status=$status, quote_hash=$quoteHash, six_month_premium=$sixMonthPremium, monthly_payment=$monthlyPayment,
           rating_json=$ratingJson, eligibility_json=$eligibilityJson, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=$id AND status NOT IN ('applied','transferred')`,
      )
      .run({ id, ...r });
  }

  setCallerPhone(id: string, phone: string) {
    this.db.query("UPDATE quotes SET caller_phone=? WHERE id=? AND caller_phone IS NULL").run(this.enc(phone), id);
  }

  /** A recording decline is never overwritten: the post-call webhook keys the owed-callback alert on that reason. */
  markTransferred(id: string, reason: string) {
    this.db
      .query(
        `UPDATE quotes SET status=CASE WHEN status='applied' THEN status ELSE 'transferred' END,
           transfer_reason=CASE WHEN transfer_reason='declined_recording' THEN transfer_reason ELSE ? END, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
      )
      .run(reason, id);
  }

  drivers(quoteId: string): DriverRow[] {
    return this.db
      .query<DriverRow, [string]>("SELECT * FROM drivers WHERE quote_id=? ORDER BY driver_index")
      .all(quoteId)
      .map((d) => ({ ...d, dob: this.dec(d.dob)! }));
  }
  vehicles(quoteId: string): VehicleRow[] {
    return this.db.query<VehicleRow, [string]>("SELECT * FROM vehicles WHERE quote_id=? ORDER BY vehicle_index").all(quoteId);
  }
  reports(quoteId: string): ReportRow[] {
    return this.db.query<ReportRow, [string]>("SELECT * FROM reports WHERE quote_id=? ORDER BY driver_index, kind").all(quoteId);
  }

  // ── Returning callers ──
  bindCaller(conversationId: string, phone: string, hash: string, createdAt?: string) {
    this.db
      .query("INSERT INTO call_bindings (conversation_id, caller_phone, caller_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id) DO NOTHING")
      .run(conversationId, this.enc(phone), hash, stamp(createdAt));
  }
  callerFor(conversationId: string): { phone: string; hash: string } | null {
    const r = this.db.query<{ caller_phone: string; caller_hash: string }, [string]>("SELECT caller_phone, caller_hash FROM call_bindings WHERE conversation_id=?").get(conversationId);
    return r ? { phone: this.dec(r.caller_phone)!, hash: r.caller_hash } : null;
  }
  /** Attaches the caller's number (encrypted) and lookup hash to a quote, if not already set. */
  attachCaller(quoteId: string, phone: string, hash: string) {
    this.db.query("UPDATE quotes SET caller_phone=COALESCE(caller_phone, ?), caller_hash=COALESCE(caller_hash, ?) WHERE id=?").run(this.enc(phone), hash, quoteId);
  }
  /** Adds lookup hashes to quotes saved with a caller number before returning-caller support. Idempotent. */
  backfillCallerHashes(hash: (phone: string) => string): number {
    const rows = this.db.query<{ id: string; caller_phone: string }, []>("SELECT id, caller_phone FROM quotes WHERE caller_phone IS NOT NULL AND caller_hash IS NULL").all();
    const tx = this.db.transaction(() => {
      for (const r of rows) this.db.query("UPDATE quotes SET caller_hash=? WHERE id=?").run(hash(this.dec(r.caller_phone)!), r.id);
    });
    tx();
    return rows.length;
  }

  /** Newest unfinished quote from this caller in the window, excluding the current conversation and quotes locked by failed DOB checks. */
  latestResumable(hash: string, excludeId: string, sinceIso: string, maxFailedAttempts: number): QuoteRow | null {
    return this.decQuote(
      this.db
        .query<QuoteRow, [string, string, string, number]>(
          // Only quotes with a saved primary driver: that driver's DOB is what the caller verifies against.
          `SELECT * FROM quotes WHERE caller_hash=? AND id<>? AND created_at>=? AND status IN ('open','quoted') AND resumed_into IS NULL AND zip IS NOT NULL AND state IS NOT NULL
             AND EXISTS (SELECT 1 FROM drivers d WHERE d.quote_id = quotes.id AND d.driver_index = 1)
             AND (SELECT COALESCE(SUM(t.failed_attempts), 0) FROM resume_tokens t WHERE t.from_quote_id = quotes.id) < ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(hash, excludeId, sinceIso, maxFailedAttempts),
    );
  }
  /** Failed DOB checks against a saved quote across every code ever minted for it (each call mints a new one). */
  resumeFailuresFor(fromQuoteId: string): number {
    return this.db.query<{ n: number }, [string]>("SELECT COALESCE(SUM(failed_attempts), 0) n FROM resume_tokens WHERE from_quote_id=?").get(fromQuoteId)!.n;
  }
  /**
   * Failed DOB checks for every code minted for this caller number inside the window. Per quote alone wasn't enough:
   * once one saved quote locked, call-start offered the number's next one with three fresh guesses (security review 2026-10-16).
   * Windowed on expires_at (set from the service clock, as created_at now is too).
   */
  resumeFailuresForCaller(callerHash: string, sinceIso: string): number {
    // A verified resume clears only the misses against the quote it verified (resumeInto), never the number's other quotes.
    return this.db
      .query<{ n: number }, [string, string]>("SELECT COALESCE(SUM(failed_attempts), 0) n FROM resume_tokens WHERE caller_hash=? AND expires_at>=?")
      .get(callerHash, sinceIso)!.n;
  }
  createResumeToken(t: { token: string; from_quote_id: string; conversation_id: string; caller_hash: string; expires_at: string; created_at?: string }) {
    this.db
      .query("INSERT INTO resume_tokens (token, from_quote_id, conversation_id, caller_hash, expires_at, created_at) VALUES ($token, $from_quote_id, $conversation_id, $caller_hash, $expires_at, $created_at)")
      .run({ ...t, created_at: stamp(t.created_at) });
  }
  resumeToken(token: string) {
    return this.db
      .query<{ token: string; from_quote_id: string; conversation_id: string; caller_hash: string; failed_attempts: number; used_at: string | null; expires_at: string }, [string]>(
        "SELECT * FROM resume_tokens WHERE token=?",
      )
      .get(token);
  }
  recordResumeFailure(token: string): number {
    this.db.query("UPDATE resume_tokens SET failed_attempts = failed_attempts + 1 WHERE token=?").run(token);
    return this.resumeToken(token)?.failed_attempts ?? 0;
  }
  /** True once a conversation has anything resumeInto would destroy: a driver, a vehicle, or an application. */
  hasQuoteData(quoteId: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string, string, string]>(
          "SELECT EXISTS (SELECT 1 FROM drivers WHERE quote_id=?) OR EXISTS (SELECT 1 FROM vehicles WHERE quote_id=?) OR EXISTS (SELECT 1 FROM applications WHERE quote_id=?) AS n",
        )
        .get(quoteId, quoteId, quoteId)!.n === 1
    );
  }
  /** Copies a prior quote's inputs into the new conversation and marks the token used, atomically. */
  resumeInto(token: string, fromId: string, toId: string, evalTag: string, createdAt?: string) {
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO quotes (id, eval_tag, caller_name, caller_phone, caller_hash, zip, state, territory, tort_option, prior_insurance_months, package, pay_in_full,
             garaging_city, pip_medical, pip_confirmed_at, created_at)
           SELECT ?, ?, caller_name, caller_phone, caller_hash, zip, state, territory, tort_option, prior_insurance_months, package, pay_in_full,
             garaging_city, pip_medical, pip_confirmed_at, ? FROM quotes WHERE id=?
           ON CONFLICT(id) DO UPDATE SET caller_name=excluded.caller_name, zip=excluded.zip, state=excluded.state, territory=excluded.territory,
             tort_option=excluded.tort_option, prior_insurance_months=excluded.prior_insurance_months, package=excluded.package, pay_in_full=excluded.pay_in_full,
             garaging_city=excluded.garaging_city, pip_medical=excluded.pip_medical, pip_confirmed_at=excluded.pip_confirmed_at,
             caller_hash=COALESCE(quotes.caller_hash, excluded.caller_hash), caller_phone=COALESCE(quotes.caller_phone, excluded.caller_phone)`,
        )
        .run(toId, evalTag, stamp(createdAt), fromId);
      this.db.query("DELETE FROM drivers WHERE quote_id=?").run(toId);
      this.db.query("DELETE FROM vehicles WHERE quote_id=?").run(toId);
      this.db.query("DELETE FROM reports WHERE quote_id=?").run(toId);
      this.db
        .query(
          `INSERT INTO drivers (quote_id, driver_index, first_name, last_name, dob, license_state, license_hash, license_last4, years_licensed, sr_tickets_3y, sr_at_fault_3y, sr_dui_3y)
           SELECT ?, driver_index, first_name, last_name, dob, license_state, license_hash, license_last4, years_licensed, sr_tickets_3y, sr_at_fault_3y, sr_dui_3y FROM drivers WHERE quote_id=?`,
        )
        .run(toId, fromId);
      this.db
        .query(
          `INSERT INTO vehicles (quote_id, vehicle_index, vin, vin_verified, year, make, model, body_class, usage, rideshare, annual_miles, anti_theft)
           SELECT ?, vehicle_index, vin, vin_verified, year, make, model, body_class, usage, rideshare, annual_miles, anti_theft FROM vehicles WHERE quote_id=?`,
        )
        .run(toId, fromId);
      this.db.query("INSERT INTO reports (quote_id, driver_index, kind, source, payload_json) SELECT ?, driver_index, kind, source, payload_json FROM reports WHERE quote_id=?").run(toId, fromId);
      this.db.query("UPDATE quotes SET resumed_into=? WHERE id=?").run(toId, fromId);
      this.db.query("UPDATE resume_tokens SET used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token=?").run(token);
      // The verified quote's DOB is now proven, so its misses no longer count against the number: the owner who missed
      // twice then got it right isn't locked out by one slip on the next call. Scoped to THIS quote's tokens only. A
      // caller-wide reset let someone spoofing the number verify a quote they made themselves, wipe the misses against
      // the victim's quote, and get fresh guesses at it every cycle (review 2026-10-16).
      this.db.query("UPDATE resume_tokens SET failed_attempts=0 WHERE from_quote_id=?").run(fromId);
    });
    tx();
  }

  /**
   * Issues the application atomically: one per quote, status flips to applied in the same transaction, and the
   * spelling the caller confirmed letter by letter replaces whatever speech recognition heard, only if it issues.
   */
  createApplication(a: Omit<ApplicationRow, "created_at"> & { created_at?: string }, confirmedName?: { first: string; last: string }): ApplicationRow {
    const tx = this.db.transaction(() => {
      this.db
        .query("INSERT INTO applications (app_number, quote_id, quote_hash, six_month_premium, email, applicant_name, pending_requirements, created_at) VALUES ($app_number, $quote_id, $quote_hash, $six_month_premium, $email, $applicant_name, $pending_requirements, $created_at)")
        .run({ ...a, email: this.enc(a.email), pending_requirements: a.pending_requirements ?? null, created_at: stamp(a.created_at) });
      if (confirmedName) {
        this.db.query("UPDATE drivers SET first_name=?, last_name=? WHERE quote_id=? AND driver_index=1").run(confirmedName.first, confirmedName.last, a.quote_id);
        this.db.query("UPDATE quotes SET caller_name=? WHERE id=?").run(confirmedName.first + " " + confirmedName.last, a.quote_id);
      }
      this.db.query("UPDATE quotes SET status='applied', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(a.quote_id);
    });
    tx();
    return this.applicationByQuote(a.quote_id)!;
  }
  private decApp(a: ApplicationRow | null): ApplicationRow | null {
    return a ? { ...a, email: this.dec(a.email) } : null;
  }
  applicationByQuote(quoteId: string): ApplicationRow | null {
    return this.decApp(this.db.query<ApplicationRow, [string]>("SELECT * FROM applications WHERE quote_id=?").get(quoteId));
  }
  application(appNumber: string): ApplicationRow | null {
    return this.decApp(this.db.query<ApplicationRow, [string]>("SELECT * FROM applications WHERE app_number=?").get(appNumber));
  }

  logEvent(e: { quote_id: string | null; tool: string; ok: boolean; error: string | null; ms: number }) {
    this.db.query("INSERT INTO call_events (quote_id, tool, ok, error, ms) VALUES (?, ?, ?, ?, ?)").run(e.quote_id, e.tool, e.ok ? 1 : 0, e.error, e.ms);
  }
  events(quoteId: string) {
    return this.db.query("SELECT tool, ok, error, ms, created_at FROM call_events WHERE quote_id=? ORDER BY id").all(quoteId);
  }
  quotesByTag(tag: string): QuoteRow[] {
    return this.db
      .query<QuoteRow, [string]>("SELECT * FROM quotes WHERE eval_tag=? ORDER BY created_at")
      .all(tag)
      .map((q) => this.decQuote(q)!);
  }

  /** Encrypts PII still stored as plaintext (rows written before field encryption shipped). Idempotent. */
  encryptLegacyRows(): { drivers: number; quotes: number; applications: number } {
    const counts = { drivers: 0, quotes: 0, applications: 0 };
    const tx = this.db.transaction(() => {
      for (const r of this.db.query<{ id: number; dob: string }, []>("SELECT id, dob FROM drivers WHERE dob NOT LIKE 'enc:v1:%'").all()) {
        this.db.query("UPDATE drivers SET dob=? WHERE id=?").run(this.cipher.encrypt(r.dob), r.id);
        counts.drivers++;
      }
      for (const r of this.db.query<{ id: string; caller_phone: string }, []>("SELECT id, caller_phone FROM quotes WHERE caller_phone IS NOT NULL AND caller_phone NOT LIKE 'enc:v1:%'").all()) {
        this.db.query("UPDATE quotes SET caller_phone=? WHERE id=?").run(this.cipher.encrypt(r.caller_phone), r.id);
        counts.quotes++;
      }
      for (const r of this.db.query<{ app_number: string; email: string }, []>("SELECT app_number, email FROM applications WHERE email IS NOT NULL AND email NOT LIKE 'enc:v1:%'").all()) {
        this.db.query("UPDATE applications SET email=? WHERE app_number=?").run(this.cipher.encrypt(r.email), r.app_number);
        counts.applications++;
      }
    });
    tx();
    return counts;
  }

  // ── Calls (post-call webhooks) ──
  upsertCall(c: Omit<CallRow, "received_at">) {
    this.db
      .query(
        `INSERT INTO calls (conversation_id, agent_id, kind, status, is_test, source, started_at, duration_secs, termination_reason, error, caller_phone, call_successful, evaluation_json, cost)
         VALUES ($conversation_id, $agent_id, $kind, $status, $is_test, $source, $started_at, $duration_secs, $termination_reason, $error, $caller_phone, $call_successful, $evaluation_json, $cost)
         ON CONFLICT(conversation_id) DO UPDATE SET status=excluded.status, kind=excluded.kind, duration_secs=excluded.duration_secs, termination_reason=excluded.termination_reason,
           error=excluded.error, caller_phone=COALESCE(excluded.caller_phone, caller_phone), call_successful=excluded.call_successful, evaluation_json=excluded.evaluation_json, cost=excluded.cost`,
      )
      .run({ ...c, caller_phone: this.enc(c.caller_phone) });
  }
  recentCalls(limit = 50, includeTests = false): CallRow[] {
    return this.db
      .query<CallRow, [number, number]>("SELECT * FROM calls WHERE is_test <= ? ORDER BY received_at DESC LIMIT ?")
      .all(includeTests ? 1 : 0, limit)
      .map((c) => ({ ...c, caller_phone: this.dec(c.caller_phone) }));
  }

  // ── Alerts ──
  /** created_at comes from the caller's clock so cooldown math and timestamps share one time source. */
  insertAlert(a: { key: string; severity: string; title: string; detail: string | null; channels: string; created_at: string }) {
    this.db.query("INSERT INTO alerts (key, severity, title, detail, channels, created_at) VALUES ($key, $severity, $title, $detail, $channels, $created_at)").run(a);
  }
  /** Most recent time an alert with this key went out on a channel (ISO string), for cooldowns. */
  lastAlertOn(key: string, channel: string): string | null {
    return this.db.query<{ created_at: string }, [string, string]>("SELECT created_at FROM alerts WHERE key=? AND instr(channels, ?) > 0 ORDER BY id DESC LIMIT 1").get(key, channel)?.created_at ?? null;
  }
  alertsOnChannelSince(channel: string, sinceIso: string): number {
    return this.db.query<{ n: number }, [string, string]>("SELECT COUNT(*) n FROM alerts WHERE instr(channels, ?) > 0 AND created_at >= ?").get(channel, sinceIso)!.n;
  }
  recentAlerts(limit = 20) {
    return this.db.query<{ key: string; severity: string; title: string; channels: string; created_at: string }, [number]>("SELECT key, severity, title, channels, created_at FROM alerts ORDER BY id DESC LIMIT ?").all(limit);
  }

  // ── Access audit ──
  logAccess(a: { ip: string; method: string; path: string; status: number; principal: string | null; request_id: string | null }) {
    this.db.query("INSERT INTO access_log (ip, method, path, status, principal, request_id) VALUES ($ip, $method, $path, $status, $principal, $request_id)").run(a);
  }
  recentAccess(limit = 20) {
    return this.db.query<{ ip: string; method: string; path: string; status: number; principal: string | null; created_at: string }, [number]>("SELECT ip, method, path, status, principal, created_at FROM access_log ORDER BY id DESC LIMIT ?").all(limit);
  }

  // ── Meta (job state) ──
  getMeta(key: string): string | null {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get(key)?.value ?? null;
  }
  setMeta(key: string, value: string) {
    this.db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')").run(key, value);
  }

  vinCache(): VinCache {
    return {
      get: (vin) => {
        const row = this.db.query<{ json: string }, [string]>("SELECT json FROM vin_cache WHERE vin=?").get(vin);
        return row ? (JSON.parse(row.json) as DecodedVin) : null;
      },
      set: (vin, decoded) => {
        this.db.query("INSERT OR REPLACE INTO vin_cache (vin, json) VALUES (?, ?)").run(vin, JSON.stringify(decoded));
      },
    };
  }
}
