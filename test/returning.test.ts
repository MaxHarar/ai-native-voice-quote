import { describe, expect, test } from "bun:test";
import { buildAgentBody } from "../agent/deploy";
import { openDb, Repo } from "../src/db";
import { renderPolicy } from "../src/policy";
import { createFieldCipher } from "../src/security/crypto";
import { SlidingWindowLimiter } from "../src/security/rateLimit";
import { createApp } from "../src/server/app";
import { RETURNING_FIRST_MESSAGE } from "../src/server/initiation";
import { QuoteService, RESUME_MAX_ATTEMPTS } from "../src/service";

const SECRET = "test-secret-test-secret-123456";
const INIT = "initiation-secret-initiation-secret";
const PHONE = "+12155550147";

function build(nowRef: { t: Date } = { t: new Date("2026-10-15T15:00:00Z") }) {
  const repo = new Repo(openDb(":memory:"), createFieldCipher(Buffer.alloc(32, 5).toString("base64")));
  const service = new QuoteService({ repo, now: () => nowRef.t, decode: async () => ({ decoded: null, source: "timeout" }), licenseKey: "lookup-key" });
  const app = createApp({ repo, service, toolSecret: SECRET, initiationSecret: INIT, limiter: new SlidingWindowLimiter(), now: () => nowRef.t, fetchMeta: async () => null, fetchTranscript: async () => null, log: () => {} });
  const tool = async (name: string, body: Record<string, unknown>) =>
    (await (await app.request(`/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": SECRET }, body: JSON.stringify(body) })).json()) as Record<string, any>;
  const initiate = async (conversationId: string, callerId = PHONE, secret = INIT) =>
    app.request("/webhooks/elevenlabs/initiation", {
      method: "POST",
      headers: { "content-type": "application/json", "x-initiation-secret": secret },
      body: JSON.stringify({ caller_id: callerId, agent_id: "agent_x", called_number: "+16095550100", call_sid: "CA1", conversation_id: conversationId }),
    });
  return { repo, service, app, tool, initiate, nowRef };
}

/** First call: caller gets a price but hangs up before applying. */
async function firstCall(h: ReturnType<typeof build>, id = "conv_first") {
  expect((await h.initiate(id)).status).toBe(200);
  const C = { conversation_id: id };
  await h.tool("start_quote", { ...C, caller_name: "Max Harar", zip: "18947", prior_insurance_months: 24 });
  await h.tool("save_driver", { ...C, driver_index: 1, first_name: "Max", last_name: "Harar", date_of_birth: "2001-03-15", license_state: "PA", license_number: "8765 4321", years_licensed: 7, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false });
  await h.tool("save_vehicle", { ...C, vehicle_index: 1, year: 2020, make: "Toyota", model: "Camry", usage: "commute", annual_miles: 12000 });
  await h.tool("set_coverage", { ...C, package: "recommended", pay_in_full: false, tort_option: "limited" });
  return h.tool("get_quote", C);
}

/** Returns the resume code embedded in the override prompt. */
async function returningCode(res: Response): Promise<string> {
  const body = (await res.json()) as { conversation_config_override?: { agent: { prompt: { prompt: string } } } };
  return body.conversation_config_override!.agent.prompt.prompt.match(/resume_code "([A-Z0-9]+)"/)![1]!;
}

describe("call-start webhook", () => {
  test("auth: wrong secret is 401; with no secret configured the endpoint serves defaults", async () => {
    const h = build();
    expect((await h.initiate("conv_x", PHONE, "wrong-wrong-wrong-wrong-wrong")).status).toBe(401);
    const off = createApp({ repo: h.repo, toolSecret: SECRET, log: () => {} });
    const res = await off.request("/webhooks/elevenlabs/initiation", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: "conversation_initiation_client_data", dynamic_variables: {} });
  });

  test("a first-time caller gets the agent's defaults, and the number is bound to the conversation", async () => {
    const h = build();
    const body = (await (await h.initiate("conv_new")).json()) as Record<string, unknown>;
    expect(body).toEqual({ type: "conversation_initiation_client_data", dynamic_variables: {} });
    expect(h.repo.callerFor("conv_new")?.phone).toBe(PHONE);
  });

  test("malformed bodies never break the call", async () => {
    const h = build();
    for (const body of ["not json", "{}", JSON.stringify({ caller_id: "anonymous", conversation_id: "conv_a" })]) {
      const res = await h.app.request("/webhooks/elevenlabs/initiation", { method: "POST", headers: { "x-initiation-secret": INIT }, body });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { conversation_config_override?: unknown }).conversation_config_override).toBeUndefined();
    }
  });

  test("a returning caller with an unfinished quote gets the welcome-back opening and a resume code", async () => {
    const h = build();
    await firstCall(h);
    const res = await h.initiate("conv_second");
    const body = (await res.json()) as { dynamic_variables: object; conversation_config_override: { agent: { first_message: string; prompt: { prompt: string } } } };
    expect(body.dynamic_variables).toEqual({});
    expect(body.conversation_config_override.agent.first_message).toBe(RETURNING_FIRST_MESSAGE);
    expect(body.conversation_config_override.agent.first_message).toContain("recorded");
    expect(body.conversation_config_override.agent.prompt.prompt).toContain("## This call: returning caller");
    // The override must not leak any saved detail; resume_quote reveals it only after DOB verification.
    expect(body.conversation_config_override.agent.prompt.prompt).not.toContain("Camry");
    expect(body.conversation_config_override.agent.prompt.prompt).not.toContain("2002");
  });

  test("no policy drift: the override is the agent's exact default prompt plus the call section", async () => {
    const h = build();
    await firstCall(h);
    const body = (await (await h.initiate("conv_second")).json()) as { conversation_config_override: { agent: { prompt: { prompt: string } } } };
    const agentPrompt = (await buildAgentBody(["tool_x"], undefined)).conversation_config.agent.prompt.prompt;
    expect(body.conversation_config_override.agent.prompt.prompt.startsWith(agentPrompt)).toBe(true);
    expect(agentPrompt).toBe(await renderPolicy());
  });

  test("not returning: applied, transferred, older than 30 days, or a different number", async () => {
    const h = build();
    const q = await firstCall(h);
    expect(((await (await h.initiate("conv_other_number", "+12675550199")).json()) as { conversation_config_override?: unknown }).conversation_config_override).toBeUndefined();
    await h.tool("submit_application", { conversation_id: "conv_first", quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Max", last_name: "Harar" });
    expect(((await (await h.initiate("conv_after_apply")).json()) as { conversation_config_override?: unknown }).conversation_config_override).toBeUndefined();

    const h2 = build();
    await firstCall(h2);
    h2.nowRef.t = new Date("2026-11-20T15:00:00Z");
    expect(((await (await h2.initiate("conv_much_later")).json()) as { conversation_config_override?: unknown }).conversation_config_override).toBeUndefined();
  });

  test("the caller's number is attached to quotes from the post-call path too", async () => {
    const h = build();
    await h.tool("start_quote", { conversation_id: "conv_nohook", caller_name: "Max Harar", zip: "08540", prior_insurance_months: 3 });
    h.service.attachCallerPhone("conv_nohook", PHONE);
    expect(h.repo.getQuote("conv_nohook")!.caller_phone).toBe(PHONE);
    expect(h.repo.getQuote("conv_nohook")!.caller_hash).toBe(h.service.callerHash("(215) 555-0147"));
  });
});

describe("only verifiable quotes are offered (2026-10-15 live bug)", () => {
  test("a quote abandoned before any driver was saved is not offered, so a correct DOB is never called a mismatch", async () => {
    const h = build();
    await h.initiate("conv_partial");
    await h.tool("start_quote", { conversation_id: "conv_partial", caller_name: "Max Verur", zip: "19123", prior_insurance_months: 36 });
    // Caller didn't have the license number and hung up: no driver saved.
    const body = (await (await h.initiate("conv_callback")).json()) as { conversation_config_override?: unknown };
    expect(body.conversation_config_override).toBeUndefined();
  });

  test("defensive: a code pointing at a driverless quote is unavailable and burns no attempt", async () => {
    const h = build();
    await firstCall(h);
    const code = await returningCode(await h.initiate("conv_second"));
    h.repo.db.exec("DELETE FROM drivers WHERE quote_id = 'conv_first'");
    expect((await h.tool("resume_quote", { conversation_id: "conv_second", resume_code: code, date_of_birth: "2001-03-15" })).error).toBe("RESUME_UNAVAILABLE");
    expect(h.repo.resumeToken(code)!.failed_attempts).toBe(0);
  });
});

describe("caller hash backfill", () => {
  test("older quotes with a caller number become recognizable, once", async () => {
    const h = build();
    await firstCall(h);
    h.repo.db.exec("UPDATE quotes SET caller_hash = NULL");
    expect(h.repo.backfillCallerHashes((p) => h.service.callerHash(p))).toBe(1);
    expect(h.repo.backfillCallerHashes((p) => h.service.callerHash(p))).toBe(0);
    expect(((await (await h.initiate("conv_after_backfill")).json()) as { conversation_config_override?: unknown }).conversation_config_override).toBeDefined();
  });
});

describe("resume_quote", () => {
  test("verified resume carries everything over and requires a fresh price", async () => {
    const h = build();
    const first = await firstCall(h);
    const code = await returningCode(await h.initiate("conv_second"));
    const r = await h.tool("resume_quote", { conversation_id: "conv_second", resume_code: code, date_of_birth: "2001-03-15" });
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ first_name: "Max", vehicles: ["2020 TOYOTA Camry"], package: "Recommended", tort_option: "limited", state: "Pennsylvania" });
    expect(JSON.stringify(r)).not.toContain("2001-03-15");
    const q = h.repo.getQuote("conv_second")!;
    expect(q).toMatchObject({ zip: "18947", state: "PA", tort_option: "limited", package: "recommended", status: "open", quote_hash: null });
    expect(h.repo.drivers("conv_second")[0]).toMatchObject({ first_name: "Max", dob: "2001-03-15", license_last4: "4321" });
    expect(h.repo.vehicles("conv_second").length).toBe(1);
    expect(h.repo.reports("conv_second").length).toBe(3);
    expect(h.repo.getQuote("conv_first")!.resumed_into).toBe("conv_second");
    // Fresh price, same inputs → same premium; then the normal confirmed-name submit.
    const again = await h.tool("get_quote", { conversation_id: "conv_second" });
    expect(again.six_month_premium).toBe(first.six_month_premium);
    const app = await h.tool("submit_application", { conversation_id: "conv_second", quote_hash: again.quote_hash, caller_confirmed: true, first_name: "Max", last_name: "Harar" });
    expect(app.application_number).toMatch(/^ANA-\d{7}$/);
  });

  test("wrong dates of birth lock the code after the third miss", async () => {
    const h = build();
    await firstCall(h);
    const code = await returningCode(await h.initiate("conv_second"));
    for (let i = 1; i < RESUME_MAX_ATTEMPTS; i++) expect((await h.tool("resume_quote", { conversation_id: "conv_second", resume_code: code, date_of_birth: "1990-01-01" })).error).toBe("DOB_MISMATCH");
    expect((await h.tool("resume_quote", { conversation_id: "conv_second", resume_code: code, date_of_birth: "1990-01-01" })).error).toBe("RESUME_LOCKED");
    expect((await h.tool("resume_quote", { conversation_id: "conv_second", resume_code: code, date_of_birth: "2001-03-15" })).error).toBe("RESUME_LOCKED");
    expect(h.repo.drivers("conv_second").length).toBe(0);
  });

  test("codes are bound to their conversation, single-use, and expire", async () => {
    const h = build();
    await firstCall(h);
    const code = await returningCode(await h.initiate("conv_second"));
    expect((await h.tool("resume_quote", { conversation_id: "conv_intruder", resume_code: code, date_of_birth: "2001-03-15" })).error).toBe("RESUME_UNAVAILABLE");
    expect((await h.tool("resume_quote", { conversation_id: "conv_second", resume_code: code, date_of_birth: "2001-03-15" })).ok).toBe(true);
    // Single-use across calls; on the call that used it a retry is idempotent (review 2026-10-16), copying nothing again.
    expect((await h.tool("resume_quote", { conversation_id: "conv_second", resume_code: code, date_of_birth: "2001-03-15" })).ok).toBe(true);
    expect(h.repo.drivers("conv_second").length).toBe(1);
    // The resumed quote is no longer offered on the next call.
    expect(((await (await h.initiate("conv_third")).json()) as { conversation_config_override?: { agent: { prompt: { prompt: string } } } }).conversation_config_override?.agent.prompt.prompt ?? "").not.toContain("conv_first");

    const h2 = build();
    await firstCall(h2);
    const code2 = await returningCode(await h2.initiate("conv_late"));
    h2.nowRef.t = new Date(h2.nowRef.t.getTime() + 31 * 60_000);
    expect((await h2.tool("resume_quote", { conversation_id: "conv_late", resume_code: code2, date_of_birth: "2001-03-15" })).error).toBe("RESUME_EXPIRED");
  });

  test("the agent definition allows exactly the overrides this feature needs", async () => {
    const body = await buildAgentBody(["tool_x"], undefined);
    expect(body.platform_settings.overrides).toEqual({
      enable_conversation_initiation_client_data_from_webhook: true,
      conversation_config_override: { agent: { first_message: true, prompt: { prompt: true } } },
    });
  });
});

describe("consent on resumed calls (review finding 1)", () => {
  test("a resumed call gets its own consent record", async () => {
    const { DISCLOSURE_VERSION } = await import("../src/disclosure");
    const h = build();
    await firstCall(h);
    const code = await returningCode(await h.initiate("conv_second"));
    expect((await h.tool("resume_quote", { conversation_id: "conv_second", resume_code: code, date_of_birth: "2001-03-15" })).ok).toBe(true);
    expect(h.repo.getQuote("conv_second")).toMatchObject({ consent_status: "continued", consent_version: DISCLOSURE_VERSION });
  });

  test("the consent record is the resumed call's own: set without start_quote, and the first call's record is untouched", async () => {
    const h = build();
    await firstCall(h);
    const firstConsent = h.repo.getQuote("conv_first")!.consent_at;
    expect(firstConsent).toBeTruthy();
    const code = await returningCode(await h.initiate("conv_second"));
    // Before resuming there is no quote (and so no consent) on the new conversation.
    expect(h.repo.getQuote("conv_second")).toBeNull();
    expect((await h.tool("resume_quote", { conversation_id: "conv_second", resume_code: code, date_of_birth: "2001-03-15" })).ok).toBe(true);
    expect(h.repo.getQuote("conv_second")!.consent_at).toBeTruthy();
    expect(h.repo.getQuote("conv_first")!.consent_at).toBe(firstConsent);
  });
});

describe("which quotes are offered on a call back", () => {
  const offered = async (h: ReturnType<typeof build>, id: string) =>
    ((await (await h.initiate(id)).json()) as { conversation_config_override?: unknown }).conversation_config_override !== undefined;

  test("a quote underwriting referred is never offered (a licensed agent finishes it)", async () => {
    const h = build();
    await h.initiate("conv_first");
    const C = { conversation_id: "conv_first" };
    await h.tool("start_quote", { ...C, caller_name: "Max Harar", zip: "18947", prior_insurance_months: 24 });
    await h.tool("save_driver", { ...C, driver_index: 1, first_name: "Max", last_name: "Harar", date_of_birth: "2001-03-15", license_state: "PA", license_number: "8765 4321", years_licensed: 7, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: true });
    await h.tool("save_vehicle", { ...C, vehicle_index: 1, year: 2020, make: "Toyota", model: "Camry", usage: "commute", annual_miles: 12000 });
    await h.tool("set_coverage", { ...C, package: "recommended", pay_in_full: false, tort_option: "limited" });
    expect((await h.tool("get_quote", C)).eligibility).toBe("REFER");
    expect(h.repo.getQuote("conv_first")!.status).toBe("referred");
    expect(await offered(h, "conv_second")).toBe(false);
  });

  test("the 30-day window: a quote started 29 days ago is offered, one started 31 days ago is not", async () => {
    for (const [days, expected] of [[29, true], [31, false]] as const) {
      const h = build();
      await firstCall(h);
      const created = new Date(h.nowRef.t.getTime() - days * 86400_000).toISOString();
      h.repo.db.query("UPDATE quotes SET created_at=? WHERE id='conv_first'").run(created);
      expect({ days, offered: await offered(h, `conv_${days}`) }).toEqual({ days, offered: expected });
    }
  });

  test("characterization: start_quote after a successful resume keeps the carried drivers, vehicles and coverage", async () => {
    // Current behaviour, pinned so a change is deliberate: start_quote only rewrites the quote header
    // (name, ZIP, state, territory, prior months) and voids the price; nothing collected is dropped.
    const h = build();
    const first = await firstCall(h);
    const code = await returningCode(await h.initiate("conv_second"));
    expect((await h.tool("resume_quote", { conversation_id: "conv_second", resume_code: code, date_of_birth: "2001-03-15" })).ok).toBe(true);
    const drivers = h.repo.drivers("conv_second");
    const vehicles = h.repo.vehicles("conv_second");

    const again = await h.tool("start_quote", { conversation_id: "conv_second", caller_name: "Max Harar", zip: "18947", prior_insurance_months: 24 });
    expect(again).toMatchObject({ ok: true, state: "Pennsylvania" });
    expect(h.repo.drivers("conv_second")).toEqual(drivers);
    expect(h.repo.vehicles("conv_second")).toEqual(vehicles);
    expect(h.repo.reports("conv_second").length).toBe(3);
    expect(h.repo.getQuote("conv_second")).toMatchObject({ package: "recommended", tort_option: "limited", pay_in_full: 0, status: "open", quote_hash: null });
    // Same inputs, so the re-priced quote matches the first call's.
    expect((await h.tool("get_quote", { conversation_id: "conv_second" })).six_month_premium).toBe(first.six_month_premium);

    // Moving the car to New Jersey also keeps everything, including the now-irrelevant PA tort election on the row.
    expect((await h.tool("start_quote", { conversation_id: "conv_second", caller_name: "Max Harar", zip: "08540", prior_insurance_months: 24 })).state).toBe("New Jersey");
    expect(h.repo.drivers("conv_second").length).toBe(1);
    expect(h.repo.getQuote("conv_second")).toMatchObject({ state: "NJ", tort_option: "limited" });
    const nj = await h.tool("get_quote", { conversation_id: "conv_second" });
    expect(nj.ok).toBe(true);
    expect(nj.tort_option).toBeUndefined();
  });
});
