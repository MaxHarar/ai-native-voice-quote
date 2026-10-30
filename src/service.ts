import { createHash, createHmac, randomInt } from "node:crypto";
import type { QuoteRow, Repo } from "./db";
import { rate } from "./rating/engine";
import { RATE_TABLE_VERSIONS, bodyClassFor, stateConfig, territoryForMunicipality, valueBandFor } from "./rating/rateTable";
import type { PackageId, PipMedical, RatingInput, State, Territory, TortOption, Usage } from "./rating/types";
import { pullReports, type DriverReports } from "./reports/vendor";
import { newApplicationNumber, normalizeApplicationNumber, spokenApplicationNumber } from "./underwriting/appNumber";
import { checkEligibility, type Eligibility } from "./underwriting/eligibility";
import { mergeRecord } from "./underwriting/merge";
import { ageOn, checkDob, checkLicense, checkYearsLicensed } from "./verify/identity";
import { checkVin, spokenVin } from "./verify/vin";
import { decodeVin, matchModel, type DecodeOutcome } from "./verify/vpic";
import { checkZip } from "./verify/zip";
import { DISCLOSURE_VERSION } from "./disclosure";

export type ToolResult = { ok: true; [k: string]: unknown } | { ok: false; error: string; hint: string; [k: string]: unknown };

export interface ServiceDeps {
  repo: Repo;
  now: () => Date;
  decode?: (vin: string) => Promise<DecodeOutcome>;
  /** vPIC model list for a make and year (null = unknown or unavailable). Unset = no model check (offline tests). */
  models?: (make: string, year: number) => Promise<string[] | null>;
  licenseKey?: string;
  /** Application number generator (tests force collisions). Defaults to a random Luhn-checked number. */
  appNumber?: () => string;
}

const fail = (error: string, hint: string, extra: Record<string, unknown> = {}): ToolResult => ({ ok: false, error, hint, ...extra });

/** After a recording decline the server refuses every data-collecting tool, so the decline never rests on the prompt alone. */
const DECLINED = (): ToolResult =>
  fail("RECORDING_DECLINED", "The caller declined recording. Don't collect anything. Say a licensed agent will call them back at this number, thank them, and call end_call.");

export type TransferReason =
  | "caller_requested"
  | "out_of_state"
  | "underwriting_referral"
  | "claims_billing_or_policy_service"
  | "coverage_advice"
  | "complaint"
  | "declined_recording"
  | "other";

/** Resume codes are short and speakable-free (the agent passes them; callers never hear them). */
const RESUME_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const RESUME_WINDOW_DAYS = 30;
export const RESUME_TOKEN_TTL_MS = 30 * 60_000;
export const RESUME_MAX_ATTEMPTS = 3;

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 10 ? "1" + digits : digits;
}

/**
 * reason resume_locked: the number has a saved quote but spent its DOB budget, so the caller is treated as new.
 * Ops-only (logged at call start); the agent is never told, since "your saved quote is locked" would confirm to
 * someone spoofing the number that a quote exists (review 2026-10-16).
 */
export type Initiation = { returning: false; reason?: "resume_locked" } | { returning: true; token: string; lastSeen: string; status: string };

const STATE_UNKNOWN = (): ToolResult =>
  fail("STATE_UNKNOWN", "Something's missing on our side for where the car is kept. Apologize briefly and follow the transfer procedure with reason other.");

/**
 * Michigan PIP elections with eligibility conditions. Nothing is recorded until the agent has confirmed the
 * eligibility with the caller and read the disclosure word for word (set_coverage with pip_confirmed true).
 * Conditions: opt-out MCL 500.3107d(1), (7); exclusions MCL 500.3109a(2); $50,000 MCL 500.3107c(1)(a).
 * Disclosures: proof of coverage MCL 500.3107d(2); 30 days to add PIP when coverage ends 3107d(2), 3109a(2)(d).
 */
const QHC_DEDUCTIBLE = `${(stateConfig("MI").qhcMaxDeductible ?? 0).toLocaleString("en-US")} dollars`;

export const PIP_RESTRICTED: Partial<Record<PipMedical, { eligibility: string; disclosure: string; if_not_eligible: string }>> = {
  opt_out: {
    eligibility:
      "To opt out, the caller needs Medicare Parts A and B, and everyone else in their household, meaning a spouse or relatives who live with them, needs qualifying health coverage or their own auto PIP.",
    disclosure:
      "With no PIP medical, this policy won't pay medical bills from a crash for you or your household; your health coverage would. You'll need to send proof of that coverage, and if it ends, you'll have 30 days to add PIP medical.",
    if_not_eligible:
      `Opting out requires Medicare Parts A and B. If they have health insurance that covers car accident injuries with a deductible of ${QHC_DEDUCTIBLE} or less, offer 250,000 dollars with exclusions. Otherwise offer unlimited, 500,000, or 250,000.`,
  },
  "250k_excluded": {
    eligibility:
      // The 100% reduction needs every person on non-Medicare coverage (MCL 500.3109a(2)(a) cites 3107d(7)(b)(i)); Medicare holders opt out instead.
      `To exclude the household, the caller and everyone in their household, meaning a spouse or relatives who live with them, need health insurance other than Medicare that covers car accident injuries, with a deductible of ${QHC_DEDUCTIBLE} or less per person.`,
    disclosure:
      "With your household excluded, this policy won't pay medical bills from a crash for anyone excluded; their health coverage would. If anyone's coverage ends, you'll have 30 days to add PIP medical back.",
    if_not_eligible:
      "If only some of the household qualifies, a licensed agent can set up partial exclusions. If the caller has Medicare Parts A and B, opting out may fit instead. Otherwise offer unlimited, 500,000, or 250,000.",
  },
  "50k": {
    eligibility:
      "The 50,000 dollar option requires that the caller is enrolled in Medicaid, and everyone else in their household has qualifying health coverage, Medicaid, or their own auto PIP.",
    disclosure: "With 50,000 dollars of PIP medical, this policy pays up to 50,000 dollars per person for medical bills from a crash.",
    if_not_eligible: "Offer unlimited, 500,000, or 250,000.",
  },
};

/** Stand-in reports for a driver with no license number yet: the estimate uses the self-reported record only. */
const NO_REPORTS: DriverReports = {
  mvr: { status: "VALID", violations: [], source: "default" },
  clue: { claims: [], source: "default" },
  prior: { carrier: null, continuousMonths: null, source: "default" },
};

const PACKAGE_ORDER: PackageId[] = ["minimum", "recommended", "premium"];

/**
 * Real, re-rated alternatives that lower this price, biggest saving first, for when the caller balks.
 * Only changes the caller controls on this call: a smaller package, paying in full. Never limited tort: pitched as a
 * money saver it skipped the statutory trade-off disclosure (75 Pa.C.S. § 1705) and edged into tort advice (review 2026-10-16).
 */
export function cheaperOptions(input: RatingInput, premium: number, cfg: ReturnType<typeof stateConfig>): { option: string; six_month_premium: number; saves: number }[] {
  const out: { option: string; six_month_premium: number; saves: number }[] = [];
  const add = (option: string, alt: RatingInput) => {
    const p = rate(alt).sixMonthPremium;
    if (p < premium) out.push({ option, six_month_premium: p, saves: Math.round((premium - p) * 100) / 100 });
  };
  for (const id of PACKAGE_ORDER.slice(0, PACKAGE_ORDER.indexOf(input.package))) add(`switch to the ${cfg.packages[id].label} package`, { ...input, package: id });
  if (!input.payInFull) add("pay the six months in full", { ...input, payInFull: true });
  return out.sort((a, b) => b.saves - a.saves);
}

/** Where a resumed quote picks up, and what to tell the agent. Everything already saved is never asked again. */
export function resumeNextStep(f: { vehicles: number; coverageMissing: boolean; licensesPending: boolean; driverNames: string[] }): { resumeAt: "other_drivers" | "coverage" | "price"; text: string } {
  const resumeAt = f.vehicles === 0 ? "other_drivers" : f.coverageMissing ? "coverage" : "price";
  const parts = [
    resumeAt === "price" && !f.licensesPending
      ? "Greet them by first name and say in one short sentence that you're re-checking their price."
      : "Greet them by first name and summarize what's on file in one sentence.",
    "Everything on file is already saved: never ask those questions again.",
    f.licensesPending
      ? "First ask for each missing license number (use that driver's license_state for how many digits), read it back, and save it with add_license. If they don't have it, carry on; get_quote will give an estimate."
      : "",
    resumeAt === "other_drivers"
      ? `Then ask whether anyone else in the household drives besides ${f.driverNames.join(" and ")}, and continue with the vehicles step.`
      : resumeAt === "coverage"
        ? "Then continue with the coverage step, using packages_sentence and the tort or PIP choice if required, then set_coverage and get_quote."
        : "Then call get_quote.",
  ];
  return { resumeAt, text: parts.filter(Boolean).join(" ") };
}

export class QuoteService {
  private readonly decode: (vin: string) => Promise<DecodeOutcome>;
  private readonly licenseKey: string;

  /** created_at for every row the resume window or retention compares with now(): one clock (see stamp in src/db). */
  private stampNow(): string {
    return this.deps.now().toISOString();
  }

  constructor(private readonly deps: ServiceDeps) {
    this.decode = deps.decode ?? ((vin) => decodeVin(vin, deps.repo.vinCache()));
    this.licenseKey = deps.licenseKey ?? process.env.LICENSE_HMAC_KEY ?? "dev-only-license-key";
  }

  private get repo() {
    return this.deps.repo;
  }

  /** Deterministic lookup key for a phone number (HMAC, so the raw number is never an index). */
  callerHash(phone: string): string {
    return createHmac("sha256", this.licenseKey).update("phone:" + normalizePhone(phone)).digest("hex");
  }

  /** Records the caller's number against the conversation and attaches it to the quote if one exists. */
  attachCallerPhone(conversationId: string, phone: string) {
    const hash = this.callerHash(phone);
    this.repo.bindCaller(conversationId, phone, hash, this.stampNow());
    if (this.repo.getQuote(conversationId)) this.repo.attachCaller(conversationId, phone, hash);
  }

  /**
   * Call start (ElevenLabs initiation webhook): bind the caller, and if they have an unfinished quote
   * from the last 30 days, mint a short-lived single-use resume code for the agent.
   */
  initiation(i: { conversationId: string; callerId: string }): Initiation {
    const phone = normalizePhone(i.callerId);
    if (phone.length < 10) return { returning: false };
    this.attachCallerPhone(i.conversationId, i.callerId);
    const now = this.deps.now();
    const since = new Date(now.getTime() - RESUME_WINDOW_DAYS * 86400_000).toISOString();
    const hash = this.callerHash(i.callerId);
    // A number that has used its DOB budget is offered nothing, whichever saved quote the guesses were against.
    if (this.repo.resumeFailuresForCaller(hash, since) >= RESUME_MAX_ATTEMPTS) return { returning: false, reason: "resume_locked" };
    const prior = this.repo.latestResumable(hash, i.conversationId, since, RESUME_MAX_ATTEMPTS);
    if (!prior) return { returning: false };
    const token = Array.from({ length: 6 }, () => RESUME_ALPHABET[randomInt(RESUME_ALPHABET.length)]).join("");
    this.repo.createResumeToken({
      token,
      from_quote_id: prior.id,
      conversation_id: i.conversationId,
      caller_hash: this.callerHash(i.callerId),
      expires_at: new Date(now.getTime() + RESUME_TOKEN_TTL_MS).toISOString(),
      created_at: now.toISOString(),
    });
    return { returning: true, token, lastSeen: prior.updated_at, status: prior.status };
  }

  /** Returning caller chose to continue: verify date of birth against the saved quote, then carry it over. */
  resumeQuote(i: { conversationId: string; evalTag: string; resumeCode: string; dateOfBirth: string }): ToolResult {
    if (this.repo.getQuote(i.conversationId)?.consent_status === "declined") return DECLINED();
    const t = this.repo.resumeToken(i.resumeCode.trim().toUpperCase());
    if (!t || t.conversation_id !== i.conversationId) return fail("RESUME_UNAVAILABLE", "There's no saved quote to continue on this call. Start a new quote.");
    // A retry after a success this call missed (tool timeout, double call) used to hear "start a new quote" with the
    // quote already loaded. The code is bound to this conversation, which already verified, so answer the same way.
    if (t.used_at) return this.repo.getQuote(i.conversationId) ? this.resumedPayload(i.conversationId) : fail("RESUME_UNAVAILABLE", "That quote was already picked up. Start a new quote.");
    if (new Date(t.expires_at).getTime() < this.deps.now().getTime()) return fail("RESUME_EXPIRED", "The saved quote can't be reopened now. Start a new quote.");
    // Resuming replaces this call's drivers, vehicles and reports wholesale. If the agent already started fresh
    // (or applied) here, refuse before the DOB check: no attempt burned, nothing on this call lost.
    if (this.repo.hasQuoteData(i.conversationId)) {
      return fail("RESUME_UNAVAILABLE", "This call already has quote details saved, so the saved quote can't be loaded over them. Carry on with the quote on this call.");
    }
    // The budget is per saved quote, not per code: every call mints a fresh code, so a per-code limit alone gave
    // anyone spoofing the number three more DOB guesses per call (audit 2026-10-16).
    const budgetSince = new Date(this.deps.now().getTime() - RESUME_WINDOW_DAYS * 86400_000).toISOString();
    const lockedOut = () =>
      this.repo.resumeFailuresFor(t.from_quote_id) >= RESUME_MAX_ATTEMPTS || this.repo.resumeFailuresForCaller(t.caller_hash, budgetSince) >= RESUME_MAX_ATTEMPTS;
    if (t.failed_attempts >= RESUME_MAX_ATTEMPTS || lockedOut()) {
      return fail("RESUME_LOCKED", "Too many attempts. Start a new quote.");
    }
    const dob = checkDob(i.dateOfBirth, this.deps.now());
    if (!dob.ok) return fail(dob.error, dob.hint);
    const saved = this.repo.drivers(t.from_quote_id).find((d) => d.driver_index === 1);
    // Nothing to verify against is not a wrong answer: never burn an attempt or call a correct DOB a mismatch.
    if (!saved) return fail("RESUME_UNAVAILABLE", "That saved quote doesn't have enough on file to reopen. Start a new quote.");
    // Never reopen a quote whose state is unknown: it would be priced under some other state's rules (review 2026-10-16).
    if (!this.repo.getQuote(t.from_quote_id)?.state) return fail("STATE_UNKNOWN", "That saved quote can't be reopened. Start a new quote.");
    if (saved.dob !== dob.value.dob) {
      this.repo.recordResumeFailure(t.token);
      return lockedOut()
        ? fail("RESUME_LOCKED", "That doesn't match. For security the saved quote is locked; start a new quote.")
        : fail("DOB_MISMATCH", "That date of birth doesn't match the saved quote. Ask once more, or offer to start a new quote.");
    }
    this.repo.resumeInto(t.token, t.from_quote_id, i.conversationId, i.evalTag, this.stampNow());
    // The returning-caller greeting plays the same disclosure, so this call gets its own consent record.
    this.repo.recordConsent(i.conversationId, DISCLOSURE_VERSION);
    const caller = this.repo.callerFor(i.conversationId);
    if (caller) this.repo.attachCaller(i.conversationId, caller.phone, caller.hash);
    this.repo.invalidateQuote(i.conversationId);
    return this.resumedPayload(i.conversationId);
  }

  /** What resume_quote answers once this conversation holds the resumed quote (also on a retry after success). */
  private resumedPayload(conversationId: string): ToolResult {
    const q = this.repo.getQuote(conversationId)!;
    if (!q.state) return STATE_UNKNOWN();
    const drivers = this.repo.drivers(q.id);
    const vehicles = this.repo.vehicles(q.id);
    const cfg = stateConfig(q.state);
    const pending = drivers.filter((d) => !d.license_last4);
    const next = resumeNextStep({
      vehicles: vehicles.length,
      coverageMissing: !q.package || q.pay_in_full === null || (Boolean(cfg.tort) && !q.tort_option) || (Boolean(cfg.pipMedical) && !q.pip_medical),
      licensesPending: pending.length > 0,
      driverNames: drivers.map((d) => d.first_name),
    });
    return {
      ok: true,
      first_name: drivers[0]?.first_name ?? null,
      drivers: drivers.map((d) => d.first_name),
      vehicles: vehicles.map((v) => `${v.year} ${v.make} ${v.model}`),
      package: q.package ? cfg.packages[q.package as PackageId].label : null,
      pay_in_full: q.pay_in_full === null ? null : Boolean(q.pay_in_full),
      tort_option: q.tort_option,
      state: cfg.name,
      ...(cfg.pipMedical
        ? { garaging_city: q.garaging_city ?? null, pip_medical: q.pip_medical ? cfg.pipMedical[q.pip_medical as PipMedical].label : null }
        : {}),
      // What step 5 needs if coverage is still open (start_quote isn't called again on a resumed quote).
      packages_sentence: cfg.packagesSentence,
      tort_choice_required: Boolean(cfg.tort),
      pip_choice_required: Boolean(cfg.pipMedical),
      license_needed_for: pending.map((d) => d.first_name),
      license_needed: pending.map((d) => ({ driver_index: d.driver_index, first_name: d.first_name, license_state: d.license_state })),
      resume_at: next.resumeAt,
      next_step: next.text,
    };
  }

  startQuote(i: {
    conversationId: string; evalTag: string; callerName: string; zip: string; priorInsuranceMonths: number; callerPhone?: string | null;
    garagingCity?: string | null;
  }): ToolResult {
    const existing = this.repo.getQuote(i.conversationId);
    const stop = this.locked(existing);
    if (stop) return stop;
    // Re-running start_quote after an application used to rewrite the applied quote's name, ZIP and territory.
    const z = checkZip(i.zip);
    if (!z.ok) {
      if (z.error === "OUT_OF_STATE") {
        this.repo.upsertOutOfState({ id: i.conversationId, evalTag: i.evalTag, callerName: i.callerName.trim(), zip: i.zip.replace(/\D/g, "").slice(0, 5), createdAt: this.stampNow() });
        this.repo.recordConsent(i.conversationId, DISCLOSURE_VERSION);
      }
      return fail(z.error, z.hint, z.state ? { state: z.state } : {});
    }
    if (i.priorInsuranceMonths < 0 || i.priorInsuranceMonths > 600) return fail("INVALID_PRIOR_INSURANCE", "Ask how many months they've been continuously insured; zero if none.");
    // Michigan bars rating by postal zone (MCL 500.2111(4)(f)): the ZIP only places the car in the state,
    // and the garaging municipality picks the territory.
    let territory = z.territory;
    let garagingCity: string | null = null;
    if (territory === null) {
      const city = i.garagingCity?.trim() ?? "";
      if (!/\p{L}/u.test(city)) {
        return fail(
          "CITY_REQUIRED",
          "Michigan prices by city or township, not ZIP code. Ask what city or township the car is parked in overnight, then call start_quote again with garaging_city.",
          { state: stateConfig(z.state).name },
        );
      }
      territory = territoryForMunicipality(z.state, city).territory;
      garagingCity = city;
    }
    this.repo.upsertQuoteStart({
      id: i.conversationId,
      evalTag: i.evalTag,
      callerName: i.callerName.trim(),
      callerPhone: i.callerPhone ?? null,
      zip: z.zip,
      state: z.state,
      territory,
      priorInsuranceMonths: Math.round(i.priorInsuranceMonths),
      garagingCity,
      createdAt: this.stampNow(),
    });
    // The disclosure plays, uninterruptible, before anything else; giving details after it is the caller's consent to continue.
    this.repo.recordConsent(i.conversationId, DISCLOSURE_VERSION);
    this.repo.invalidateQuote(i.conversationId);
    const caller = this.repo.callerFor(i.conversationId);
    if (caller) this.repo.attachCaller(i.conversationId, caller.phone, caller.hash);
    const cfg = stateConfig(z.state);
    return {
      ok: true,
      zip: z.zip,
      state: cfg.name,
      packages_sentence: cfg.packagesSentence,
      tort_choice_required: Boolean(cfg.tort),
      pip_choice_required: Boolean(cfg.pipMedical),
      next_step: "Collect driver 1 (the caller).",
    };
  }

  saveDriver(i: {
    conversationId: string; driverIndex: number; firstName: string; lastName: string; dateOfBirth: string;
    licenseState: string; licenseNumber?: string | null; yearsLicensed: number; tickets3y: number; atFaultAccidents3y: number; dui3y: boolean;
  }): ToolResult {
    const q = this.repo.getQuote(i.conversationId);
    const stop = this.locked(q);
    if (stop) return stop;
    if (!q || q.territory === null) return fail("QUOTE_NOT_STARTED", "Call start_quote first with the caller's name, ZIP, and prior insurance.");
    if (i.driverIndex < 1 || i.driverIndex > 4) return fail("TOO_MANY_DRIVERS", "This line quotes up to 4 drivers. Offer a transfer to a licensed agent for larger households.");
    const asOf = this.deps.now();
    const dob = checkDob(i.dateOfBirth, asOf);
    if (!dob.ok) return fail(dob.error, dob.hint);
    const yl = checkYearsLicensed(i.yearsLicensed, dob.value.age);
    if (!yl.ok) return fail(yl.error, yl.hint);
    if (i.tickets3y < 0 || i.atFaultAccidents3y < 0) return fail("INVALID_HISTORY", "Ask for the number of tickets and at-fault accidents in the last 3 years.");

    // License not handy: save the driver now (so the quote can be finished later, or resumed on a
    // call back), and order reports once the number arrives. Pending = empty hash and last 4.
    const pendingLicense = !i.licenseNumber || !i.licenseNumber.trim();
    if (pendingLicense) {
      const existing = this.repo.drivers(i.conversationId).find((d) => d.driver_index === i.driverIndex);
      this.repo.upsertDriver({
        quote_id: i.conversationId,
        driver_index: i.driverIndex,
        first_name: i.firstName.trim(),
        last_name: i.lastName.trim(),
        dob: dob.value.dob,
        license_state: i.licenseState.toUpperCase().trim(),
        // Re-saving a driver without a number must not erase one already on file.
        license_hash: existing?.license_hash ?? "",
        license_last4: existing?.license_last4 ?? "",
        years_licensed: Math.round(i.yearsLicensed),
        sr_tickets_3y: Math.round(i.tickets3y),
        sr_at_fault_3y: Math.round(i.atFaultAccidents3y),
        sr_dui_3y: i.dui3y ? 1 : 0,
      });
      this.repo.invalidateQuote(i.conversationId);
      const stillPending = !existing?.license_last4;
      return {
        ok: true,
        driver_index: i.driverIndex,
        age: dob.value.age,
        license_pending: stillPending,
        ...(stillPending ? { next_step: "Carry on with the rest of the quote, then ask for the license number again before pricing." } : {}),
      };
    }

    const lic = checkLicense(i.licenseState, i.licenseNumber!, i.lastName);
    if (!lic.ok) return fail(lic.error, lic.hint);

    // Driver and reports commit together: a driver saved with a license but without its reports was later priced on
    // the no-license stand-in, i.e. on a clean record nobody pulled (review 2026-10-16).
    this.repo.tx(() => {
    this.repo.upsertDriver({
      quote_id: i.conversationId,
      driver_index: i.driverIndex,
      first_name: i.firstName.trim(),
      last_name: i.lastName.trim(),
      dob: dob.value.dob,
      license_state: i.licenseState.toUpperCase().trim(),
      license_hash: createHmac("sha256", this.licenseKey).update(lic.value).digest("hex"),
      license_last4: lic.value.slice(-4),
      years_licensed: Math.round(i.yearsLicensed),
      sr_tickets_3y: Math.round(i.tickets3y),
      sr_at_fault_3y: Math.round(i.atFaultAccidents3y),
      sr_dui_3y: i.dui3y ? 1 : 0,
    });
    this.orderReports(i.conversationId, i.driverIndex, lic.value);
    });
    this.repo.invalidateQuote(i.conversationId);
    return { ok: true, driver_index: i.driverIndex, age: dob.value.age, license_last4: lic.value.slice(-4), warnings: lic.warnings };
  }

  /** Adds the license number to a driver already saved without one (later in the call, or on a call back). Nothing else is re-asked. */
  addLicense(i: { conversationId: string; driverIndex: number; licenseState?: string | null; licenseNumber: string }): ToolResult {
    const q = this.repo.getQuote(i.conversationId);
    const stop = this.locked(q);
    if (stop) return stop;
    if (!q) return fail("QUOTE_NOT_STARTED", "There's no quote on this call yet.");
    const d = this.repo.drivers(q.id).find((x) => x.driver_index === i.driverIndex);
    if (!d) return fail("DRIVER_NOT_FOUND", `There's no driver ${i.driverIndex} on this quote. Use save_driver for a new driver.`);
    const state = (i.licenseState?.trim() || d.license_state).toUpperCase();
    const lic = checkLicense(state, i.licenseNumber, d.last_name);
    if (!lic.ok) return fail(lic.error, lic.hint);
    // One transaction with its reports, like save_driver (review 2026-10-16).
    this.repo.tx(() => {
      this.repo.upsertDriver({
        quote_id: q.id, driver_index: d.driver_index, first_name: d.first_name, last_name: d.last_name, dob: d.dob, license_state: state,
        license_hash: createHmac("sha256", this.licenseKey).update(lic.value).digest("hex"),
        license_last4: lic.value.slice(-4),
        years_licensed: d.years_licensed, sr_tickets_3y: d.sr_tickets_3y, sr_at_fault_3y: d.sr_at_fault_3y, sr_dui_3y: d.sr_dui_3y,
      });
      this.orderReports(q.id, d.driver_index, lic.value);
    });
    this.repo.invalidateQuote(q.id);
    const stillNeeded = this.repo.drivers(q.id).filter((x) => !x.license_last4).map((x) => x.first_name);
    return {
      ok: true,
      driver_index: d.driver_index,
      first_name: d.first_name,
      license_last4: lic.value.slice(-4),
      warnings: lic.warnings,
      license_needed_for: stillNeeded,
      next_step: stillNeeded.length ? `Ask for ${stillNeeded.join(" and ")}'s license number next.` : "All license numbers are in. Call get_quote for the final price.",
    };
  }

  /**
   * One guard for a quote this call can no longer change: declined recording, applied, or handed to a licensed agent.
   * Transferred quotes used to accept new drivers, vehicles, coverage and even a new ZIP behind the human's back, and
   * each tool had its own ALREADY_APPLIED wording (review 2026-10-16).
   */
  private locked(q: QuoteRow | null): ToolResult | null {
    if (q?.consent_status === "declined") return DECLINED();
    if (q?.status === "applied") return this.alreadyApplied(q.id);
    if (q?.status === "transferred") {
      return fail(
        "TRANSFERRED",
        "A licensed agent has this quote now and will call them back at this number, so don't collect, change or re-quote anything. If the transfer didn't connect, apologize and say so.",
      );
    }
    return null;
  }

  /** The caller already applied on this call: the price is locked, and the application number is what they may ask for. */
  private alreadyApplied(quoteId: string): ToolResult {
    const app = this.repo.applicationByQuote(quoteId);
    return fail(
      "ALREADY_APPLIED",
      "An application was already submitted on this call, so the price is locked. Don't re-quote or offer to apply again. If they ask, read application_number slowly.",
      app ? { application_number: app.app_number, spoken: spokenApplicationNumber(app.app_number) } : {},
    );
  }

  /** Reports are ordered at ingestion with the raw license number, which is then discarded. */
  private orderReports(quoteId: string, driverIndex: number, license: string) {
    const reports = pullReports(license);
    for (const kind of ["MVR", "CLUE", "PRIOR"] as const) {
      const payload = kind === "MVR" ? reports.mvr : kind === "CLUE" ? reports.clue : reports.prior;
      this.repo.upsertReport({ quote_id: quoteId, driver_index: driverIndex, kind, source: payload.source, payload_json: JSON.stringify(payload) });
    }
  }

  async saveVehicle(i: {
    conversationId: string; vehicleIndex: number; vin?: string | null; year?: number | null; make?: string | null; model?: string | null;
    usage: Usage | "rideshare"; annualMiles: number; antiTheft?: boolean;
    /** True once a newer save for the same vehicle has started (the HTTP layer tracks this across a tool timeout). */
    isStale?: () => boolean;
  }): Promise<ToolResult> {
    const q = this.repo.getQuote(i.conversationId);
    const stop = this.locked(q);
    if (stop) return stop;
    if (!q || q.territory === null) return fail("QUOTE_NOT_STARTED", "Call start_quote first.");
    if (i.vehicleIndex < 1 || i.vehicleIndex > 4) return fail("TOO_MANY_VEHICLES", "This line quotes up to 4 vehicles. Offer a transfer to a licensed agent.");
    if (!Number.isFinite(i.annualMiles) || i.annualMiles < 0 || i.annualMiles > 150000) return fail("INVALID_MILEAGE", "Ask roughly how many miles a year the car is driven.");

    const warnings: string[] = [];
    let vin: string | null = null;
    let vinVerified = false;
    let year = i.year ?? null;
    let make = i.make?.trim().toUpperCase() || null;
    let model = i.model?.trim() || null;
    let bodyRaw: string | undefined = model ?? undefined;

    if (i.vin && i.vin.trim()) {
      const v = checkVin(i.vin);
      if (!v.ok) {
        if (v.reason === "LENGTH") return fail("VIN_LENGTH", `A VIN is 17 characters; I received ${v.vin.length}: "${spokenVin(v.vin)}". If that differs from what the caller said, fix your transcription; otherwise ask them to read it again in groups of four, or use year, make, and model.`);
        return fail("VIN_CHECK_DIGIT", "That VIN failed its check digit, so a character was misheard. Read back the likely correction and ask the caller to confirm, or re-read the VIN.", {
          heard: spokenVin(v.vin),
          likely_corrections: v.suggestions.map(spokenVin),
        });
      }
      vin = v.vin;
      const d = await this.decode(vin);
      if (d.decoded) {
        vinVerified = true;
        if (make && d.decoded.make !== make) {
          warnings.push(`VERIFY_MISMATCH: the VIN decodes to a ${d.decoded.year} ${d.decoded.make} ${d.decoded.model}, but the caller said ${make}. Confirm which is right.`);
        }
        year = d.decoded.year;
        make = d.decoded.make;
        model = d.decoded.model;
        bodyRaw = d.decoded.bodyClass;
      } else if (d.source === "not_found") {
        // Some ASR swaps (H/8, A/1/J, B/2/K/S...) share a check-digit value and slip past it; the decoder is the second net.
        return fail("VIN_NOT_FOUND", "That VIN doesn't match a known vehicle, so a character was probably misheard. Ask them to read it again in groups of four, or give the year, make, and model instead.", {
          heard: spokenVin(vin),
        });
      } else if (!year || !make || !model) {
        return fail("NEED_YEAR_MAKE_MODEL", "The VIN is valid but the vehicle lookup didn't answer in time. Ask for the year, make, and model.");
      } else {
        warnings.push("VIN not decoded (vehicle service slow); rated on the stated year, make, and model.");
      }
    }
    if (!year || !make || !model) return fail("NEED_YEAR_MAKE_MODEL", "Ask for the vehicle's year, make, and model, or the VIN.");
    const asOf = this.deps.now();
    if (year < 1950 || year > asOf.getUTCFullYear() + 1) return fail("INVALID_YEAR", "Confirm the model year.");

    // No decoded VIN: check the spoken model against what the make actually sold that year (ASR hears "535" for "535i").
    let likelyModels: string[] = [];
    // Only when no VIN was given: after a slow VIN decode a second vPIC call could push the tool past its timeout.
    if (!vin && this.deps.models) {
      const listed = await this.deps.models(make, year).catch(() => null);
      if (listed) {
        const m = matchModel(model, listed);
        if (m.status === "match") model = m.model;
        else if (m.status === "close") {
          likelyModels = m.likely;
          warnings.push(`MODEL_CHECK: ${year} ${make} doesn't list "${model}". Ask which it is (${m.likely.join(" or ")}) and save again with their answer.`);
        }
      }
    }

    // The VIN and model lookups await the network, and a call that outlives the tool timeout keeps running after the
    // agent heard TIMEOUT. Re-check before writing: a newer save for this vehicle, an application, or a recording
    // decline that happened meanwhile all win over this late result.
    // Superseded is an expected outcome, not an error: it counted as a tool failure in ops and alerts (review 2026-10-16).
    if (i.isStale?.()) return { ok: true, superseded: true, vehicle_index: i.vehicleIndex, note: "A newer save for this vehicle replaced this one. Nothing to do." };
    const late = this.locked(this.repo.getQuote(i.conversationId));
    if (late) return late;
    this.repo.upsertVehicle({
      quote_id: i.conversationId,
      vehicle_index: i.vehicleIndex,
      vin,
      vin_verified: vinVerified ? 1 : 0,
      year,
      make,
      model,
      body_class: bodyClassFor(bodyRaw),
      usage: i.usage === "rideshare" ? "business" : i.usage,
      rideshare: i.usage === "rideshare" ? 1 : 0,
      annual_miles: Math.round(i.annualMiles),
      anti_theft: i.antiTheft ? 1 : 0,
    });
    this.repo.invalidateQuote(i.conversationId);
    return { ok: true, vehicle_index: i.vehicleIndex, vehicle: `${year} ${make} ${model}`, vin_verified: vinVerified, warnings, ...(likelyModels.length ? { likely_models: likelyModels } : {}) };
  }

  setCoverage(i: {
    conversationId: string; package: PackageId; payInFull: boolean; tortOption?: TortOption | null;
    pipMedical?: PipMedical | null; pipConfirmed?: boolean | null;
  }): ToolResult {
    const q = this.repo.getQuote(i.conversationId);
    const stop = this.locked(q);
    if (stop) return stop;
    if (!q || q.territory === null) return fail("QUOTE_NOT_STARTED", "Call start_quote first.");
    if (!q.state) return STATE_UNKNOWN();
    const cfg = stateConfig(q.state);
    // A PA policy may not issue until the applicant has had the chance to elect a tort option (75 Pa.C.S. § 1705(a)(4)).
    if (cfg.tort && !i.tortOption) {
      return fail(
        "TORT_OPTION_REQUIRED",
        "Pennsylvania requires a tort choice. Explain in one sentence: limited tort costs less but limits suing for pain and suffering unless the injury is serious; full tort keeps that right. Ask which they want; if they won't choose, use full tort, the state default.",
      );
    }
    const tort = cfg.tort ? i.tortOption! : null;
    // Michigan: the applicant chooses the PIP medical level (MCL 500.3107c); no choice means unlimited (3107c(4)).
    let pip: { level: PipMedical; confirmedAt: string | null } | null = null;
    if (cfg.pipMedical) {
      if (!i.pipMedical) {
        return fail(
          "PIP_CHOICE_REQUIRED",
          "Michigan requires a PIP medical choice. Offer unlimited, 500,000, or 250,000 dollars, and mention lower options if they have Medicare, Medicaid, or qualifying health insurance. Describe them neutrally and never recommend one. If they won't choose, use unlimited, the Michigan default.",
        );
      }
      const restricted = PIP_RESTRICTED[i.pipMedical];
      if (restricted && i.pipConfirmed !== true) {
        return fail(
          "PIP_ELIGIBILITY_CHECK",
          "Ask the caller to confirm the eligibility. If they qualify, read the disclosure word for word and get a yes, then call set_coverage again with pip_confirmed true. If they don't qualify, follow if_not_eligible.",
          restricted,
        );
      }
      pip = { level: i.pipMedical, confirmedAt: restricted ? this.deps.now().toISOString() : null };
    }
    this.repo.setCoverage(i.conversationId, i.package, i.payInFull, tort, pip);
    this.repo.invalidateQuote(i.conversationId);
    const note = cfg.packages[i.package].note;
    return {
      ok: true,
      package: cfg.packages[i.package].label,
      pay_in_full: i.payInFull,
      ...(tort ? { tort_option: tort } : {}),
      ...(pip ? { pip_medical: cfg.pipMedical![pip.level].label } : {}),
      ...(note ? { note } : {}),
    };
  }

  /** Finalizes reports, runs underwriting, and rates — one round trip on the voice path. */
  getQuote(i: { conversationId: string }): ToolResult {
    const q = this.repo.getQuote(i.conversationId);
    // A re-quote after submit used to flip applied back to quoted: every ALREADY_APPLIED guard went quiet and the
    // call back offered the quote again, inviting a second application (audit 2026-10-16, reproduced). Once handed to
    // a licensed agent the quote is theirs: a price here used to flip transferred->quoted behind the human's back.
    const stop = this.locked(q);
    if (stop) return stop;
    if (!q || !q.zip || q.territory === null) return fail("QUOTE_NOT_STARTED", "Call start_quote first.");
    const drivers = this.repo.drivers(q.id);
    const vehicles = this.repo.vehicles(q.id);
    // Never price under a guessed state: NJ, PA and MI rate, require and disclose differently (review 2026-10-16).
    if (!q.state) return STATE_UNKNOWN();
    const state: State = q.state;
    const cfg = stateConfig(state);
    const needsTort = Boolean(cfg.tort) && !q.tort_option;
    const needsPip = Boolean(cfg.pipMedical) && !q.pip_medical;
    const missing = [
      !drivers.length && "at least one driver",
      !vehicles.length && "at least one vehicle",
      !q.package && "a coverage package",
      needsTort && "the tort choice",
      needsPip && "the PIP medical choice",
    ].filter(Boolean);
    if (missing.length) return fail("MISSING_INFO", `Still need ${missing.join(", ")}.`);
    // License numbers still pending: price an ESTIMATE from what the caller told us. Nothing is pulled,
    // nothing is saved as a quote, and there's no quote_hash, so it can't be submitted until the numbers arrive.
    const pending = drivers.filter((d) => !d.license_last4);
    const estimate = pending.length > 0;

    const asOf = this.deps.now();
    // The MCCA amounts are set per period; never price Michigan on a stale assessment.
    if (cfg.mcca) {
      const day = asOf.toISOString().slice(0, 10);
      if (day < cfg.mcca.from || day > cfg.mcca.through) {
        return fail(
          "RATES_UNAVAILABLE",
          "Michigan's catastrophic claims fee for this policy date isn't on file, so a licensed agent needs to finish this one. Follow the transfer procedure with reason other.",
        );
      }
    }
    const reports = this.repo.reports(q.id);
    const found = (idx: number, kind: string) => reports.find((r) => r.driver_index === idx && r.kind === kind);
    // The no-license stand-in is only for a driver with no license yet. A licensed driver missing any report used to be
    // priced on it too, i.e. on a clean record nobody pulled (review 2026-10-16): refuse and hand off instead.
    const unreported = drivers.filter((d) => d.license_last4 && !(["MVR", "CLUE", "PRIOR"] as const).every((k) => found(d.driver_index, k)));
    if (unreported.length) {
      return fail(
        "REPORTS_MISSING",
        "The driving record didn't come through on our side, so this can't be priced. Apologize briefly and follow the transfer procedure with reason other.",
        { driver_index: unreported.map((d) => d.driver_index) },
      );
    }
    const reportsFor = (idx: number): DriverReports => {
      // No license yet: no reports, so the estimate rests on the self-reported record alone.
      if (!found(idx, "MVR")) return NO_REPORTS;
      const get = (kind: string) => JSON.parse(found(idx, kind)!.payload_json);
      return { mvr: get("MVR"), clue: get("CLUE"), prior: get("PRIOR") };
    };
    const merged = drivers.map((d) =>
      mergeRecord({ tickets3y: d.sr_tickets_3y, atFaultAccidents3y: d.sr_at_fault_3y, dui3y: !!d.sr_dui_3y }, reportsFor(d.driver_index), asOf, cfg.merit),
    );
    const discrepancies = merged.flatMap((m, k) => m.discrepancies.map((s) => `${drivers[k]!.first_name}: ${s}`));

    // Prior insurance is verified against the prior-carrier report for driver 1 when available.
    let priorMonths = q.prior_insurance_months ?? 0;
    const prior = reportsFor(drivers[0]!.driver_index).prior;
    if (prior.source === "vendor" && prior.continuousMonths !== null) {
      if (priorMonths >= 6 && prior.continuousMonths < 6) {
        discrepancies.push(`prior insurance: caller said ${priorMonths} months, carrier verification shows ${prior.continuousMonths}`);
      }
      priorMonths = prior.continuousMonths;
    }

    const effectiveYear = asOf.getUTCFullYear();
    const eligibility: Eligibility = checkEligibility(
      merged,
      vehicles.map((v) => ({ modelYear: v.year, rideshareOrCommercial: !!v.rideshare })),
      effectiveYear,
    );
    if (eligibility.status === "REFER") {
      // Recorded either way. An estimate's referral used to leave the quote open, so the next call offered to resume
      // a quote underwriting had already sent to a licensed agent (review 2026-10-16).
      this.repo.saveRated(q.id, { status: "referred", quoteHash: null, sixMonthPremium: null, monthlyPayment: null, ratingJson: null, eligibilityJson: JSON.stringify(eligibility) });
      if (estimate) {
        return {
          ok: true,
          eligibility: "REFER",
          reasons: eligibility.reasons,
          discrepancies: [],
          next_step: "Do not quote a price. Explain briefly that a licensed agent needs to finish this one, then call flag_for_human with reason underwriting_referral and transfer.",
        };
      }
      return {
        ok: true,
        eligibility: "REFER",
        reasons: eligibility.reasons,
        discrepancies,
        next_step: "Do not quote a price. Explain briefly that a licensed agent needs to finish this one, then call flag_for_human with reason underwriting_referral and transfer.",
      };
    }

    const input: RatingInput = {
      state,
      territory: q.territory as Territory,
      drivers: drivers.map((d, k) => ({
        age: ageOn(d.dob, asOf),
        yearsLicensed: d.years_licensed,
        minorViolations3y: merged[k]!.minorViolations3y,
        majorViolations3y: merged[k]!.majorViolations3y,
        atFaultAccidents3y: merged[k]!.atFaultAccidents3y,
      })),
      vehicles: vehicles.map((v) => ({
        modelYear: v.year,
        bodyClass: v.body_class as RatingInput["vehicles"][number]["bodyClass"],
        valueBand: valueBandFor(v.make, effectiveYear - v.year),
        usage: v.usage as Usage,
        annualMiles: v.annual_miles,
        antiTheft: !!v.anti_theft,
      })),
      package: q.package as PackageId,
      priorInsuranceMonths: priorMonths,
      payInFull: !!q.pay_in_full,
      ...(cfg.tort ? { tortOption: (q.tort_option ?? "full") as TortOption, umStacked: true } : {}),
      ...(cfg.pipMedical ? { pipMedical: (q.pip_medical ?? "unlimited") as PipMedical } : {}),
      effectiveYear,
    };
    const result = rate(input);
    const waysToLower = cheaperOptions(input, result.sixMonthPremium, cfg);
    const wayToLowerStep =
      "If the caller reacts to the price (too high, a surprise, can't afford it), don't push the application: offer the biggest saving from ways_to_lower in one sentence with its six-month price, and ask if they'd like to switch. If they do, call set_coverage with the change, then get_quote.";
    // Michigan's PIP level and the MCCA fee ride on the estimate too: the agent answers "are there fees?" from them,
    // and the estimate used to leave them out (review 2026-10-16).
    const miFields =
      cfg.pipMedical && input.pipMedical ? { pip_medical: cfg.pipMedical[input.pipMedical].spoken, mcca_fee_included: result.assessments.reduce((s, a) => s + a.amount, 0) } : {};
    if (estimate) {
      const names = pending.map((d) => d.first_name).join(" and ");
      return {
        ok: true,
        eligibility: "OK",
        estimate: true,
        six_month_premium: result.sixMonthPremium,
        monthly_payment: result.monthlyPayment,
        package: cfg.packages[input.package].spoken,
        ...(input.tortOption ? { tort_option: `${input.tortOption} tort` } : {}),
        ...miFields,
        top_factors: result.topFactors.map((f) => `${f.name} ${f.direction} the price`),
        ways_to_lower: waysToLower,
        license_needed_for: pending.map((d) => d.first_name),
        demo_rates: true,
        next_step: [
          "This is an estimate from what the caller told you; no driving record has been pulled.",
          `Say "Based on what you've told me, your estimate is ..." with the six-month price (and monthly, if they chose monthly) and the top factor, then say the final price needs ${names}'s license number to check the driving record, so it may change once that's done.`,
          `Ask if they have it now. If yes, read it back, save it with add_license, and call get_quote again. If not, say everything is saved and they can call back from this number to get the final price and apply.`,
          wayToLowerStep,
          "Never offer to submit an application on an estimate.",
        ].join(" "),
      };
    }
    // Pennsylvania: a spoken tort choice isn't final until the signed election form (75 Pa.C.S. § 1705), so the
    // caller hears the other option's price too and the specialist can finalize either one.
    const otherTort: TortOption | null = input.tortOption ? (input.tortOption === "limited" ? "full" : "limited") : null;
    const otherTortResult = otherTort ? rate({ ...input, tortOption: otherTort }) : null;
    const quoteHash = createHash("sha256")
      .update(JSON.stringify({ input, premium: result.sixMonthPremium, v: RATE_TABLE_VERSIONS[state] }))
      .digest("hex")
      .slice(0, 10)
      .toUpperCase();
    this.repo.saveRated(q.id, {
      status: "quoted",
      quoteHash,
      sixMonthPremium: result.sixMonthPremium,
      monthlyPayment: result.monthlyPayment,
      ratingJson: JSON.stringify({ input, result, ...(otherTort && otherTortResult ? { otherTort: { option: otherTort, sixMonthPremium: otherTortResult.sixMonthPremium, monthlyPayment: otherTortResult.monthlyPayment } } : {}) }),
      eligibilityJson: JSON.stringify(eligibility),
    });
    return {
      ok: true,
      eligibility: "OK",
      six_month_premium: result.sixMonthPremium,
      monthly_payment: result.monthlyPayment,
      package: cfg.packages[input.package].spoken,
      ...(input.tortOption ? { tort_option: `${input.tortOption} tort` } : {}),
      ...(otherTort && otherTortResult
        ? { other_tort_option: { tort_option: `${otherTort} tort`, six_month_premium: otherTortResult.sixMonthPremium, monthly_payment: otherTortResult.monthlyPayment } }
        : {}),
      ...miFields,
      top_factors: result.topFactors.map((f) => `${f.name} ${f.direction} the price`),
      ways_to_lower: waysToLower,
      discrepancies,
      quote_hash: quoteHash,
      demo_rates: true,
      next_step: [
        discrepancies.length ? "Tell the caller what the reports found (briefly, no blame), then give the price." : "Give the price and the top factor.",
        otherTort ? "Then say once, in one short sentence, what the six-month price would be with the other tort option, as information only, never as a way to save." : "",
        "Then ask if they'd like to submit an application.",
        wayToLowerStep,
        // Eval price-objection, 36b87a9: the caller asked for the other tort after balking and it was switched on the spot,
        // with no fresh trade-off (75 Pa.C.S. § 1705). A spoken switch needs the disclosure again, and never as a saving.
        otherTort ? "Never change the tort choice to lower the price. If the caller asks to switch tort, first re-read the tort trade-off sentence and get a clear choice." : "",
      ].filter(Boolean).join(" "),
    };
  }

  submitApplication(i: { conversationId: string; quoteHash: string; callerConfirmed: boolean; firstName?: string; lastName?: string; email?: string | null }): ToolResult {
    const q = this.repo.getQuote(i.conversationId);
    if (q?.consent_status === "declined") return DECLINED();
    if (!q) return fail("QUOTE_NOT_STARTED", "There's no quote on this call yet.");
    const existing = this.repo.applicationByQuote(q.id);
    if (existing) {
      // Idempotent: webhook retries and double calls return the same application.
      return { ok: true, application_number: existing.app_number, spoken: spokenApplicationNumber(existing.app_number), duplicate: true };
    }
    if (!i.callerConfirmed) return fail("NOT_CONFIRMED", "Read back the price and package and get an explicit yes before submitting.");
    if (q.status === "referred") return fail("REFERRED", "This quote needs a licensed agent. Flag for a human and transfer.");
    const pendingLicenses = this.repo.drivers(q.id).filter((d) => !d.license_last4).map((d) => d.first_name);
    if (pendingLicenses.length) {
      return fail(
        "LICENSE_NEEDED",
        `The price so far is only an estimate. I need ${pendingLicenses.join(" and ")}'s license number to check the driving record before submitting. Ask if they have it now; if not, say everything is saved and they can call back from this number.`,
        { license_needed_for: pendingLicenses },
      );
    }
    if (q.status !== "quoted" || !q.quote_hash) return fail("NO_CURRENT_QUOTE", "Details changed or no price was given yet. Call get_quote again and re-confirm the price.");
    if (!q.state) return STATE_UNKNOWN();
    const state: State = q.state;
    if (i.quoteHash.trim().toUpperCase() !== q.quote_hash) return fail("QUOTE_CHANGED", "The quote changed since it was read to the caller. Call get_quote again and re-confirm the price.");
    if (i.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.email)) return fail("INVALID_EMAIL", "Ask them to spell the email address, or skip it.");
    // Speech recognition mangles names ("Harar" came through as Ferrar, Harari, Harer). The caller
    // confirms a letter-by-letter spell-back before submitting; that spelling becomes the name of record.
    const first = i.firstName?.trim() ?? "";
    const last = i.lastName?.trim() ?? "";
    if (!first || !last) return fail("NAME_NOT_CONFIRMED", "Spell the applicant's first and last name back letter by letter, get a yes, then submit with that spelling.");
    const nameOk = /^[\p{L}][\p{L}' .-]*$/u;
    if (!nameOk.test(first) || !nameOk.test(last)) return fail("INVALID_NAME", "Names can only contain letters, spaces, apostrophes, periods, and hyphens. Confirm the spelling again.");
    // The rename rides in the application's transaction: renaming first left driver 1 renamed with no application
    // whenever numbering failed (audit 2026-10-16).

    for (let attempt = 0; attempt < 5; attempt++) {
      const appNumber = (this.deps.appNumber ?? newApplicationNumber)();
      if (this.repo.application(appNumber)) continue;
      const st = stateConfig(state);
      const pendingRequirements = [
        st.tort && "Signed Pennsylvania tort election form (75 Pa.C.S. § 1705)",
        st.pipMedical && "Signed Michigan PIP selection form (MCL 500.3107e)",
        st.pipMedical && q.pip_medical && PIP_RESTRICTED[q.pip_medical as PipMedical] && "Proof of qualifying health coverage for the PIP election",
      ].filter((x): x is string => Boolean(x));
      const app = this.repo.createApplication({
        app_number: appNumber,
        quote_id: q.id,
        quote_hash: q.quote_hash,
        six_month_premium: q.six_month_premium!,
        email: i.email ?? null,
        applicant_name: first + " " + last,
        pending_requirements: pendingRequirements.length ? JSON.stringify(pendingRequirements) : null,
        created_at: this.stampNow(),
      }, { first, last });
      // Michigan: the PIP choice only takes effect on the state's selection form (MCL 500.3107e(2)).
      const mi = st.pipMedical;
      const proof = q.pip_medical ? PIP_RESTRICTED[q.pip_medical as PipMedical] : undefined;
      return {
        ok: true,
        application_number: app.app_number,
        spoken: spokenApplicationNumber(app.app_number),
        applicant: app.applicant_name,
        next_step: mi
          ? `Read the application number slowly. Say a specialist will follow up to finalize, including Michigan's PIP selection form to sign${proof ? " and proof of coverage" : ""}, and that coverage is NOT active yet.`
          : st.tort
            ? "Read the application number slowly. Say a specialist will follow up to finalize, including Pennsylvania's tort election form to sign, and that coverage is NOT active yet."
            : "Read the application number slowly, say a specialist will follow up to finalize, and that coverage is NOT active yet.",
      };
    }
    return fail("APP_NUMBER_EXHAUSTED", "Something went wrong issuing the number. Offer a transfer to an agent.");
  }

  /**
   * Anyone who has (or guesses) a seven-digit number used to hear its premium and package. Details now need the
   * applicant's last name, matched against driver 1 (the spelling confirmed at submit). Without it (the previous agent
   * never sends one) the caller only learns the application exists and its status (review 2026-10-16).
   */
  lookupApplication(i: { applicationNumber: string; lastName?: string | null }): ToolResult {
    const n = normalizeApplicationNumber(i.applicationNumber);
    if (!n) return fail("INVALID_APPLICATION_NUMBER", "That number didn't pass its check digit. Ask the caller to read all seven digits again.");
    const app = this.repo.application(n);
    if (!app) return fail("NOT_FOUND", "No application with that number. Ask them to read it again.");
    const status = "received, pending specialist review";
    const given = i.lastName?.trim().toLowerCase() ?? "";
    const onFile = this.repo.drivers(app.quote_id).find((d) => d.driver_index === 1)?.last_name.trim().toLowerCase() ?? "";
    if (!given || given !== onFile) {
      return {
        ok: true,
        application_number: app.app_number,
        status,
        next_step: given
          ? "That last name doesn't match the application, so share only that it's received and pending review. For anything more, offer a licensed agent."
          : "Say it's received and pending specialist review. To share its price or package, ask for the applicant's last name and look it up again with it.",
      };
    }
    const q = this.repo.getQuote(app.quote_id)!;
    return { ok: true, application_number: app.app_number, status, six_month_premium: app.six_month_premium, package: q.package, submitted_at: app.created_at };
  }

  flagForHuman(i: { conversationId: string; evalTag: string; reason: TransferReason; summary?: string }): ToolResult {
    this.repo.ensureQuote(i.conversationId, i.evalTag, this.stampNow());
    // A recording decline is never overwritten (the owed-callback alert keys on it), so a later reason is dropped.
    // It used to vanish silently; ops now sees it as an event row (review 2026-10-16). ok:true keeps it out of error counts.
    const prior = this.repo.getQuote(i.conversationId)?.transfer_reason;
    if (prior === "declined_recording" && i.reason !== "declined_recording") {
      this.repo.logEvent({ quote_id: i.conversationId, tool: "flag_for_human", ok: true, error: `DROPPED_REASON:${i.reason}`, ms: 0 });
    }
    this.repo.markTransferred(i.conversationId, i.reason);
    if (i.reason === "declined_recording") {
      this.repo.recordConsentDeclined(i.conversationId, DISCLOSURE_VERSION);
      return {
        ok: true,
        next_step: "Don't ask for anything else. Say a licensed agent will call them back at this number, thank them, and call end_call. Do not transfer.",
      };
    }
    return { ok: true, next_step: "Tell the caller you're connecting them now, then mention this call is still being recorded, then call transfer_to_number." };
  }
}
