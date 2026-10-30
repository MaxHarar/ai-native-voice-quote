import { describe, expect, test } from "bun:test";
import { openDb, Repo } from "../src/db";
import { Alerter, alertSettingsFrom, DEFAULT_ALERT_TIMING } from "../src/ops/alerts";
import { Scheduler } from "../src/ops/scheduler";
import { createFieldCipher } from "../src/security/crypto";
import { clientIp, SlidingWindowLimiter } from "../src/security/rateLimit";
import { renderOpsIndex } from "../src/server/ops";
import { fetchAudio, fetchConversation } from "../src/server/transcript";
import { QuoteService } from "../src/service";

describe("alert settings from config", () => {
  test("enables each channel only when fully configured", () => {
    const base = { quietHours: [22, 7] as [number, number] };
    expect(alertSettingsFrom(base)).toMatchObject({ disabled: false, telegram: undefined, voice: undefined, ...DEFAULT_ALERT_TIMING });
    expect(alertSettingsFrom({ ...base, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" }).telegram).toEqual({ token: "t", chatId: "1" });
    expect(alertSettingsFrom({ ...base, TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "x", ALERT_VOICE_FROM: "+1", ALERT_VOICE_TO: "+2" }).voice).toEqual({ accountSid: "AC", authToken: "x", from: "+1", to: "+2" });
    expect(alertSettingsFrom({ ...base, TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "x" }).voice).toBeUndefined();
    expect(alertSettingsFrom({ ...base, ALERTS_DISABLED: "1" }).disabled).toBe(true);
    expect(alertSettingsFrom({ ...base, ALERTS_DISABLED: "true" }).disabled).toBe(true);
  });

  test("a failed phone-call request is reported, not thrown", async () => {
    const repo = new Repo(openDb(":memory:"));
    const net = (async (url: string | URL) => new Response("{}", { status: String(url).includes("twilio") ? 500 : 200 })) as unknown as typeof fetch;
    const a = new Alerter(repo, { ...alertSettingsFrom({ quietHours: null, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1", TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "x", ALERT_VOICE_FROM: "+1", ALERT_VOICE_TO: "+2" }) }, () => new Date("2026-10-15T15:00:00Z"), net, () => {});
    expect((await a.send({ key: "k", severity: "critical", title: "t" })).channels).toEqual(["telegram"]);
  });
});

describe("rate limiter internals", () => {
  test("sweep drops expired keys and keeps live ones", () => {
    let t = 0;
    const l = new SlidingWindowLimiter(() => t);
    l.hit("a", 10, 1000);
    t = 500;
    l.hit("b", 10, 1000);
    expect(l.size).toBe(2);
    t = 1200;
    l.sweep(1000);
    expect(l.size).toBe(1);
    expect(l.count("b", 1000)).toBe(1);
  });

  test("reports retry-after when over the limit", () => {
    let t = 0;
    const l = new SlidingWindowLimiter(() => t);
    l.hit("k", 1, 10_000);
    t = 4000;
    expect(l.hit("k", 1, 10_000)).toMatchObject({ allowed: false, retryAfterSecs: 6 });
  });

  test("client IP: first X-Forwarded-For hop, then X-Real-IP, then unknown", () => {
    expect(clientIp((h) => ({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" })[h])).toBe("203.0.113.5");
    expect(clientIp((h) => ({ "x-real-ip": "198.51.100.7" })[h])).toBe("198.51.100.7");
    expect(clientIp(() => undefined)).toBe("unknown");
  });
});

describe("field cipher helpers", () => {
  test("isEncrypted distinguishes ciphertext from legacy plaintext", () => {
    const c = createFieldCipher(Buffer.alloc(32, 3).toString("base64"));
    expect(c.isEncrypted(c.encrypt("x"))).toBe(true);
    expect(c.isEncrypted("1988-03-02")).toBe(false);
    expect(() => createFieldCipher(Buffer.alloc(8).toString("base64"))).toThrow(/32 bytes/);
    expect(() => createFieldCipher(Buffer.alloc(32).toString("base64"), Buffer.alloc(8).toString("base64"))).toThrow(/PREVIOUS/);
  });
});

describe("scheduler lifecycle", () => {
  test("start registers timers and stop clears them; retention records its run", () => {
    const repo = new Repo(openDb(":memory:"));
    const alerter = new Alerter(repo, alertSettingsFrom({ quietHours: null, ALERTS_DISABLED: "1" }));
    const s = new Scheduler({ repo, alerter, limiter: new SlidingWindowLimiter(), retention: { mode: "dry-run", liveDays: 30, evalDays: 7 }, backupRetentionDays: 14, canaryExpected: false, canaryMaxSilenceHours: 3, log: () => {} });
    s.start();
    s.stop();
    expect(s.retention().mode).toBe("dry-run");
    expect(JSON.parse(repo.getMeta("retention_last")!).mode).toBe("dry-run");
  });

  test("without a backup store or an expected canary, those jobs are no-ops", async () => {
    const repo = new Repo(openDb(":memory:"));
    const alerter = new Alerter(repo, alertSettingsFrom({ quietHours: null, ALERTS_DISABLED: "1" }));
    const s = new Scheduler({ repo, alerter, limiter: new SlidingWindowLimiter(), retention: { mode: "dry-run", liveDays: 30, evalDays: 7 }, backupRetentionDays: 14, canaryExpected: false, canaryMaxSilenceHours: 3, log: () => {} });
    expect(await s.backupIfDue()).toBeNull();
    expect(await s.deadManCheck()).toBe(false);
    expect(await s.toolErrorSpike()).toBe(0);
  });
});

describe("conversation fetch edge cases", () => {
  const ok = (body: unknown, status = 200) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

  test("non-call ids, missing keys and 404s return null; network failures are unavailable", async () => {
    expect(await fetchConversation("sim_eval-x", "key", ok({}))).toBeNull();
    expect(await fetchConversation("conv_1", undefined, ok({}))).toBeNull();
    expect(await fetchConversation("conv_1", "key", ok("nope", 404))).toBeNull();
    // A network failure isn't "gone": the page offers a retry instead of the retention message.
    expect((await fetchConversation("conv_1", "key", (async () => { throw new Error("down"); }) as unknown as typeof fetch))?.unavailable).toBe(true);
  });

  test("tool result summaries handle errors, plain strings, and empty transcripts", async () => {
    const c = (await fetchConversation(
      "conv_1",
      "key",
      ok({ transcript: [{ role: "agent", message: "x", tool_results: [{ tool_name: "get_quote", is_error: true, result_value: JSON.stringify({ ok: false, error: "MISSING_INFO" }) }, { tool_name: "end_call", result_value: "plain text result" }, { tool_name: "odd", result_value: "{not json" }] }] }),
    ))!;
    expect(c.turns[0]!.results.map((r) => r.summary)).toEqual(["MISSING_INFO", "plain text result", "{not json"]);
    expect((await fetchConversation("conv_2", "key", ok({})))!.turns).toEqual([]);
  });

  test("audio streams only for real calls", async () => {
    expect(await fetchAudio("sim_x", "key", ok("x"))).toBeNull();
    expect(await fetchAudio("conv_1", undefined, ok("x"))).toBeNull();
    expect(await fetchAudio("conv_1", "key", ok("missing", 404))).toBeNull();
    const res = await fetchAudio("conv_1", "key", ok("mp3-bytes"));
    expect(await res!.text()).toBe("mp3-bytes");
  });
});

describe("ops index with live call outcomes", () => {
  test("renders calls with policy-check badges, alerts, access log, and system status", () => {
    const repo = new Repo(openDb(":memory:"));
    repo.upsertCall({ conversation_id: "conv_a", agent_id: "a", kind: "call", status: "done", is_test: 0, source: "twilio", started_at: null, duration_secs: 126, termination_reason: "end_call tool", error: null, caller_phone: "+10000000000", call_successful: "success", evaluation_json: JSON.stringify({ no_binding_claims: "success", concise_turns: "failure", other: null }), cost: 1 });
    repo.insertAlert({ key: "k", severity: "warning", title: "Policy check failed", detail: null, channels: "telegram", created_at: "2026-10-15T15:00:00.000Z" });
    repo.logAccess({ ip: "1.1.1.1", method: "GET", path: "/ops", status: 200, principal: "ops:max", request_id: "r" });
    repo.setMeta("backup_last", JSON.stringify({ at: "2026-10-15T07:00:00.000Z", bytes: 20480, quotes: 3 }));
    repo.setMeta("retention_last", JSON.stringify({ at: "2026-10-15T06:00:00.000Z", mode: "dry-run" }));
    repo.setMeta("canary_last_heartbeat", "2026-10-15T14:17:00.000Z");
    const html = renderOpsIndex(repo, {});
    expect(html).toContain("2m 06s");
    expect(html).toContain("✓");
    expect(html).toContain("✗");
    expect(html).toContain("Policy check failed");
    expect(html).toContain("ops:max");
    expect(html).toContain("20 KB");
    expect(html).toContain("dry-run");
  });

  test("eval-run views hide live-only sections", () => {
    const repo = new Repo(openDb(":memory:"));
    const html = renderOpsIndex(repo, { tag: "eval-20261015T000000" });
    expect(html).not.toContain("Live calls");
    expect(html).toContain("eval run");
  });
});

describe("service validation codes", () => {
  // Several of these sit behind the HTTP schema (negative counts, prior months), so they're driven on the service directly.
  const driver = { conversationId: "conv_v", driverIndex: 1, firstName: "Sarah", lastName: "Smith", dateOfBirth: "1988-03-02", licenseState: "NJ", licenseNumber: "S10000000000001", yearsLicensed: 20, tickets3y: 0, atFaultAccidents3y: 0, dui3y: false };
  const vehicle = { conversationId: "conv_v", vehicleIndex: 1, year: 2020, make: "Toyota", model: "Camry", usage: "commute" as const, annualMiles: 12000 };
  const start = { conversationId: "conv_v", evalTag: "unit", callerName: "Sarah Smith", zip: "08540", priorInsuranceMonths: 24 };
  const cases: [code: string, run: (s: QuoteService) => unknown][] = [
    ["TOO_MANY_DRIVERS", (s) => s.saveDriver({ ...driver, driverIndex: 5 })],
    ["TOO_MANY_DRIVERS", (s) => s.saveDriver({ ...driver, driverIndex: 0 })],
    ["TOO_MANY_VEHICLES", (s) => s.saveVehicle({ ...vehicle, vehicleIndex: 5 })],
    ["INVALID_HISTORY", (s) => s.saveDriver({ ...driver, tickets3y: -1 })],
    ["INVALID_HISTORY", (s) => s.saveDriver({ ...driver, atFaultAccidents3y: -1 })],
    ["INVALID_PRIOR_INSURANCE", (s) => s.startQuote({ ...start, priorInsuranceMonths: -1 })],
    ["INVALID_PRIOR_INSURANCE", (s) => s.startQuote({ ...start, priorInsuranceMonths: 601 })],
    ["INVALID_MILEAGE", (s) => s.saveVehicle({ ...vehicle, annualMiles: 150001 })],
    ["INVALID_MILEAGE", (s) => s.saveVehicle({ ...vehicle, annualMiles: Number.NaN })],
    ["INVALID_YEAR", (s) => s.saveVehicle({ ...vehicle, year: 1949 })],
    ["INVALID_YEAR", (s) => s.saveVehicle({ ...vehicle, year: 2028 })],
    ["VIN_LENGTH", (s) => s.saveVehicle({ ...vehicle, vin: "1HGCM8263" })],
    ["NEED_YEAR_MAKE_MODEL", (s) => s.saveVehicle({ ...vehicle, year: null })],
    ["NEED_YEAR_MAKE_MODEL", (s) => s.saveVehicle({ ...vehicle, model: "  " })],
    ["INVALID_APPLICATION_NUMBER", (s) => s.lookupApplication({ applicationNumber: "ANA-1234567" })],
    ["INVALID_APPLICATION_NUMBER", (s) => s.lookupApplication({ applicationNumber: "12345" })],
    ["INVALID_ZIP", (s) => s.startQuote({ ...start, zip: "0854" })],
    ["INVALID_ZIP", (s) => s.startQuote({ ...start, zip: "ABCDE" })],
  ];

  for (const [i, [code, run]] of cases.entries()) {
    test(`${code} (case ${i + 1})`, async () => {
      const repo = new Repo(openDb(":memory:"));
      const s = new QuoteService({ repo, now: () => new Date("2026-10-15T15:00:00Z"), decode: async () => ({ decoded: null, source: "timeout" }), licenseKey: "k" });
      expect(s.startQuote(start).ok).toBe(true);
      const before = { quote: repo.getQuote("conv_v"), drivers: repo.drivers("conv_v"), vehicles: repo.vehicles("conv_v") };
      const r = (await run(s)) as { ok: boolean; error?: string; hint?: string };
      expect({ ok: r.ok, error: r.error }).toEqual({ ok: false, error: code });
      expect(r.hint).toEqual(expect.any(String));
      // A refused input saves nothing.
      expect({ quote: repo.getQuote("conv_v"), drivers: repo.drivers("conv_v"), vehicles: repo.vehicles("conv_v") }).toEqual(before);
    });
  }
});
