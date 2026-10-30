import { describe, expect, test } from "bun:test";
import { openDb, Repo } from "../src/db";
import { QuoteService } from "../src/service";

// Root cause of the "after 30 days" flake (36b87a9 pinned it in test/journeys.test.ts): created_at defaulted to SQLite's
// real clock while the resume window and retention compare it with the service's injected now(). A test with a pinned
// clock then depended on the day the suite ran. Every created_at the service windows on must come from its clock.
// The pinned date is years from today, so a row stamped by SQLite's clock can never match it by accident.

const PINNED = new Date("2020-03-04T05:06:07.890Z");
const PHONE = "+12155550199";

function build() {
  const repo = new Repo(openDb(":memory:"));
  const service = new QuoteService({ repo, now: () => PINNED, decode: async () => ({ decoded: null, source: "timeout" }), licenseKey: "clock-key" });
  return { repo, service };
}
const createdAt = (repo: Repo, table: string, where: string, id: string) =>
  (repo.db.query(`SELECT created_at FROM ${table} WHERE ${where}=?`).get(id) as { created_at: string } | null)?.created_at;

describe("created_at follows the service clock, not SQLite's", () => {
  test("quotes (start_quote, out-of-state, flag_for_human) and call_bindings", () => {
    const { repo, service } = build();
    service.initiation({ conversationId: "conv_a", callerId: PHONE });
    expect(createdAt(repo, "call_bindings", "conversation_id", "conv_a")).toBe(PINNED.toISOString());

    expect(service.startQuote({ conversationId: "conv_a", evalTag: "unit", callerName: "Pat Doe", zip: "08540", priorInsuranceMonths: 24 }).ok).toBe(true);
    expect(createdAt(repo, "quotes", "id", "conv_a")).toBe(PINNED.toISOString());

    service.startQuote({ conversationId: "conv_oos", evalTag: "unit", callerName: "Pat Doe", zip: "10001", priorInsuranceMonths: 24 });
    expect(createdAt(repo, "quotes", "id", "conv_oos")).toBe(PINNED.toISOString());

    service.flagForHuman({ conversationId: "conv_flag", evalTag: "unit", reason: "caller_requested", summary: "wants a person" });
    expect(createdAt(repo, "quotes", "id", "conv_flag")).toBe(PINNED.toISOString());
  });

  test("resume_tokens, the resumed quote, and applications", async () => {
    const { repo, service } = build();
    const C = { conversationId: "conv_first" };
    service.initiation({ conversationId: "conv_first", callerId: PHONE });
    service.startQuote({ ...C, evalTag: "unit", callerName: "Max Harar", zip: "18947", priorInsuranceMonths: 24 });
    service.saveDriver({ ...C, driverIndex: 1, firstName: "Max", lastName: "Harar", dateOfBirth: "1990-10-06", licenseState: "PA", licenseNumber: "8765 4321", yearsLicensed: 7, tickets3y: 0, atFaultAccidents3y: 0, dui3y: false });
    await service.saveVehicle({ ...C, vehicleIndex: 1, year: 2018, make: "Toyota", model: "Camry", usage: "commute", annualMiles: 12000 });
    service.setCoverage({ ...C, package: "recommended", payInFull: false, tortOption: "full" });
    expect(service.getQuote(C).ok).toBe(true);

    const offer = service.initiation({ conversationId: "conv_second", callerId: PHONE });
    if (!offer.returning) throw new Error("expected a resume offer");
    expect(createdAt(repo, "resume_tokens", "token", offer.token)).toBe(PINNED.toISOString());
    expect(service.resumeQuote({ conversationId: "conv_second", evalTag: "unit", resumeCode: offer.token, dateOfBirth: "1990-10-06" }).ok).toBe(true);
    expect(createdAt(repo, "quotes", "id", "conv_second")).toBe(PINNED.toISOString());

    const q = service.getQuote({ conversationId: "conv_second" }) as { ok: true; quote_hash: string };
    expect(service.submitApplication({ conversationId: "conv_second", quoteHash: q.quote_hash, callerConfirmed: true, firstName: "Max", lastName: "Harar" }).ok).toBe(true);
    expect(createdAt(repo, "applications", "quote_id", "conv_second")).toBe(PINNED.toISOString());
  });

  test("a later re-start never moves created_at (the resume window starts at the first call)", () => {
    let t = PINNED;
    const repo = new Repo(openDb(":memory:"));
    const service = new QuoteService({ repo, now: () => t, licenseKey: "clock-key" });
    service.startQuote({ conversationId: "conv_a", evalTag: "unit", callerName: "Pat Doe", zip: "08540", priorInsuranceMonths: 24 });
    t = new Date(PINNED.getTime() + 86400_000);
    service.startQuote({ conversationId: "conv_a", evalTag: "unit", callerName: "Pat Doe", zip: "08540", priorInsuranceMonths: 24 });
    expect(createdAt(repo, "quotes", "id", "conv_a")).toBe(PINNED.toISOString());
  });
});
