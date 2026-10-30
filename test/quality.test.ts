import { beforeEach, describe, expect, test } from "bun:test";
import { FIRST_MESSAGE, TOOLS } from "../agent/config";
import { buildAgentBody } from "../agent/deploy";
import { openDb, Repo } from "../src/db";
import { DISCLOSURE_VERSION, RECORDING_DISCLOSURE } from "../src/disclosure";
import { rate } from "../src/rating/engine";
import { createApp, TOOL_SCHEMAS } from "../src/server/app";
import { RETURNING_FIRST_MESSAGE } from "../src/server/initiation";
import { QuoteService } from "../src/service";

// Loop iteration 5: turn-taking for short answers, recording consent, PA tort finality.

const renderedBody = () => buildAgentBody(["tool_x"], undefined);

describe("turn-taking for short answers (ISC-114)", () => {
  // The audio A/B refuted patient eagerness and skip_turn (ISA ISC-112, ISC-113); these pin the measured config.
  test("turn eagerness stays normal, and there is no skip_turn tool to go silent on noise", async () => {
    const body = await renderedBody();
    expect(body.conversation_config.turn.turn_eagerness).toBe("normal");
    expect((body.conversation_config.agent.prompt.built_in_tools as Record<string, unknown>).skip_turn).toBeUndefined();
    expect(body.conversation_config.agent.prompt.prompt).not.toContain("skip_turn");
  });

  test("the policy forbids answering for the caller after a filler-only turn", async () => {
    const prompt = (await renderedBody()).conversation_config.agent.prompt.prompt;
    expect(prompt).toContain('says only a filler sound ("uh", "um", "hmm") or asks for a moment, say just "No rush." and wait.');
    expect(prompt).toContain("Never answer for them, guess what they meant, or move to the next question until they actually answer.");
  });
});

describe("recording disclosure and consent (ISC-120 to ISC-123)", () => {
  test("both first messages carry the one shared disclosure", () => {
    expect(FIRST_MESSAGE).toContain(RECORDING_DISCLOSURE);
    expect(RETURNING_FIRST_MESSAGE).toContain(RECORDING_DISCLOSURE);
    expect(DISCLOSURE_VERSION).toMatch(/^[0-9a-f]{12}$/);
  });

  test("declined_recording is a hand-off reason on both sides of the wire", () => {
    const flag = TOOLS.find((t) => t.name === "flag_for_human")!;
    expect(flag.properties.reason?.enum).toContain("declined_recording");
    expect(TOOL_SCHEMAS.flag_for_human.shape.reason.options).toContain("declined_recording");
  });

  test("the policy scripts the decline path, and it never transfers or keeps collecting", async () => {
    const prompt = (await renderedBody()).conversation_config.agent.prompt.prompt;
    expect(prompt).toContain("If the caller says they don't want to be recorded, don't ask for or repeat anything else.");
    expect(prompt).toContain("Never transfer a caller who declined recording.");
  });

  test("the transfer line restates that the call is recorded", async () => {
    const prompt = (await renderedBody()).conversation_config.agent.prompt.prompt;
    expect(prompt).toContain('"Let me connect you with a licensed agent now; this call is still being recorded."');
  });
});

describe("consent record and tort finality (HTTP)", () => {
  const SECRET = "test-secret-test-secret-123456";
  const AUTH = { authorization: "Basic " + Buffer.from("max:pw-pw-pw-pw").toString("base64") };
  let repo: Repo;
  let app: ReturnType<typeof createApp>;
  const C = { conversation_id: "conv_q5_1", eval_tag: "unit" };
  const call = async (tool: string, body: Record<string, unknown>) =>
    (await (await app.request(`/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": SECRET }, body: JSON.stringify(body) })).json()) as any;

  beforeEach(() => {
    repo = new Repo(openDb(":memory:"));
    app = createApp({ repo, service: new QuoteService({ repo, now: () => new Date("2026-10-14T15:00:00Z"), decode: async () => ({ decoded: null, source: "timeout" }), licenseKey: "k" }), toolSecret: SECRET, opsUser: "max", opsPassword: "pw-pw-pw-pw" });
  });

  async function quotePa(tort: "limited" | "full") {
    expect((await call("start_quote", { ...C, caller_name: "Max Harar", zip: "18940", prior_insurance_months: 36 })).ok).toBe(true);
    expect((await call("save_driver", { ...C, driver_index: 1, first_name: "Max", last_name: "Harar", date_of_birth: "1996-04-12", license_state: "PA", license_number: "1234 5678", years_licensed: 5, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false })).ok).toBe(true);
    expect((await call("save_vehicle", { ...C, vehicle_index: 1, year: 2015, make: "BMW", model: "535i", usage: "commute", annual_miles: 15000 })).ok).toBe(true);
    expect((await call("set_coverage", { ...C, package: "minimum", pay_in_full: false, tort_option: tort })).ok).toBe(true);
    return call("get_quote", C);
  }

  test("start_quote records which disclosure the caller heard and that they continued", async () => {
    await call("start_quote", { ...C, caller_name: "Max Harar", zip: "18940", prior_insurance_months: 36 });
    const q = repo.getQuote(C.conversation_id)!;
    expect(q.consent_version).toBe(DISCLOSURE_VERSION);
    expect(q.consent_status).toBe("continued");
    expect(q.consent_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("a decline is recorded, says end the call, and every collecting tool is refused afterwards", async () => {
    const r = await call("flag_for_human", { ...C, reason: "declined_recording", summary: "Caller declined recording." });
    expect(r.ok).toBe(true);
    expect(r.next_step).toContain("call end_call");
    expect(r.next_step).toContain("Do not transfer");
    expect(r.next_step).not.toContain("transfer_to_number");
    let q = repo.getQuote(C.conversation_id)!;
    expect(q).toMatchObject({ consent_status: "declined", consent_version: DISCLOSURE_VERSION, transfer_reason: "declined_recording", status: "transferred" });
    // The server, not just the prompt, refuses to collect after a decline (review finding 2).
    for (const [tool, body] of [
      ["start_quote", { caller_name: "Max Harar", zip: "18940", prior_insurance_months: 36 }],
      ["save_driver", { driver_index: 1, first_name: "Max", last_name: "Harar", date_of_birth: "1996-04-12", license_state: "PA", license_number: "1234 5678", years_licensed: 5, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false }],
      ["save_vehicle", { vehicle_index: 1, vin: "", year: 2015, make: "BMW", model: "535i", usage: "commute", annual_miles: 15000 }],
      ["set_coverage", { package: "minimum", pay_in_full: false, tort_option: "limited" }],
      ["get_quote", {}],
      ["submit_application", { quote_hash: "ABCDEF1234", caller_confirmed: true, first_name: "Max", last_name: "Harar" }],
      ["resume_quote", { resume_code: "ABCDEFGH", date_of_birth: "1996-04-12" }],
    ] as const) {
      const r = await call(tool, { ...C, ...body });
      expect(`${tool}:${r.error}`).toBe(`${tool}:RECORDING_DECLINED`);
    }
    q = repo.getQuote(C.conversation_id)!;
    expect(q.consent_status).toBe("declined");
    expect(q.caller_name).toBeNull();
    expect(repo.drivers(C.conversation_id)).toEqual([]);
  });

  test("other hand-offs remind the agent to restate the recording", async () => {
    const r = await call("flag_for_human", { ...C, reason: "caller_requested", summary: "Wants a person." });
    expect(r.next_step).toContain("still being recorded");
  });

  test("a PA quote also prices the other tort option, and only the tort lines differ", async () => {
    const limited = await quotePa("limited");
    expect(limited.ok).toBe(true);
    expect(limited.other_tort_option.tort_option).toBe("full tort");
    expect(limited.other_tort_option.six_month_premium).toBeGreaterThan(limited.six_month_premium);
    expect(limited.next_step).toContain("other tort option");
    // The other-tort price is informational; it must never become the answer to a price objection (eval price-objection, 36b87a9).
    expect(limited.next_step).toContain("as information only, never as a way to save");
    expect(limited.next_step).toContain("Never change the tort choice to lower the price");
    expect(limited.next_step).toContain("If the caller asks to switch tort, first re-read the tort trade-off sentence and get a clear choice");
    const stored = JSON.parse(repo.getQuote(C.conversation_id)!.rating_json!);
    expect(stored.otherTort.option).toBe("full");
    expect(stored.otherTort.sixMonthPremium).toBe(rate({ ...stored.input, tortOption: "full" }).sixMonthPremium);
  });

  test("a PA application records the tort form requirement and the summary shows both prices", async () => {
    const q = await quotePa("limited");
    const sub = await call("submit_application", { ...C, quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Max", last_name: "Harar" });
    expect(sub.ok).toBe(true);
    expect(sub.next_step).toContain("tort election form");
    const app_ = repo.applicationByQuote(C.conversation_id)!;
    expect(JSON.parse(app_.pending_requirements!)).toEqual(["Signed Pennsylvania tort election form (75 Pa.C.S. § 1705)"]);
    const html = await (await app.request(`/q/${sub.application_number}`, { headers: AUTH })).text();
    expect(html).toContain("Tort options");
    expect(html).toContain("Limited tort <span class=\"label\">· chosen on the call</span>");
    expect(html).toContain("Full tort</td>");
    expect(html).toContain("Needed before issue");
    expect(html).toContain("The choice is final only on the signed Pennsylvania tort election form.");
  });

  test("NJ quotes carry no tort alternative and no pending requirements", async () => {
    await call("start_quote", { ...C, caller_name: "Sarah Smith", zip: "08540", prior_insurance_months: 36 });
    await call("save_driver", { ...C, driver_index: 1, first_name: "Sarah", last_name: "Smith", date_of_birth: "1985-03-02", license_state: "NJ", license_number: "S 1000 0000 0000 01", years_licensed: 20, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false });
    await call("save_vehicle", { ...C, vehicle_index: 1, year: 2020, make: "Toyota", model: "Camry", usage: "commute", annual_miles: 12000 });
    await call("set_coverage", { ...C, package: "recommended", pay_in_full: true });
    const q = await call("get_quote", C);
    expect(q.ok).toBe(true);
    expect(q.other_tort_option).toBeUndefined();
    const sub = await call("submit_application", { ...C, quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Sarah", last_name: "Smith" });
    expect(repo.applicationByQuote(C.conversation_id)!.pending_requirements ?? null).toBeNull();
    const html = await (await app.request(`/q/${sub.application_number}`, { headers: AUTH })).text();
    expect(html).not.toContain("Tort options");
    expect(html).not.toContain("Needed before issue");
  });
});

describe("eval anti-check: nothing after a recording decline (ISC-122)", () => {
  const { afterDecline } = require("../evals/tasks") as typeof import("../evals/tasks");
  const decline = { tool_name: "flag_for_human", params_as_json: '{"conversation_id":"x","reason":"declined_recording","summary":"no"}' };
  test("collecting or transferring after the decline fails the call", () => {
    expect(afterDecline([{ role: "agent", message: "ok", tool_calls: [decline] }, { role: "agent", message: null, tool_calls: [{ tool_name: "save_driver" }, { tool_name: "transfer_to_number" }, { tool_name: "end_call" }] }])).toEqual([
      "save_driver after a recording decline",
      "transfer_to_number after a recording decline",
    ]);
  });
  test("ending the call after the decline passes, and collecting before it is fine", () => {
    expect(afterDecline([{ role: "agent", message: null, tool_calls: [{ tool_name: "start_quote" }, decline, { tool_name: "end_call" }] }])).toEqual([]);
    expect(afterDecline([{ role: "agent", message: null, tool_calls: [{ tool_name: "start_quote" }] }])).toEqual([]);
  });
});

describe("year/make/model check against vPIC (ISC-126)", () => {
  const { matchModel } = require("../src/verify/vpic") as typeof import("../src/verify/vpic");
  const BMW_2015 = ["528i", "535i", "535d", "550i", "M5", "X3", "C 650 GT"];
  test("matching: exact (any case or punctuation), close (suffix, one typo), unknown", () => {
    expect(matchModel("535I", BMW_2015)).toEqual({ status: "match", model: "535i" });
    expect(matchModel("f150", ["F-150", "F-250"])).toEqual({ status: "match", model: "F-150" });
    expect(matchModel("GLC", ["GLC-Class", "GLE-Class"])).toEqual({ status: "match", model: "GLC-Class" });
    expect(matchModel("535", BMW_2015)).toEqual({ status: "close", likely: ["535d", "535i"] });
    expect(matchModel("Camery", ["Camry", "Corolla"])).toEqual({ status: "close", likely: ["Camry"] });
    expect(matchModel("GLE 350", ["GLE-Class", "G-Class"])).toEqual({ status: "close", likely: ["GLE-Class"] });
    expect(matchModel("Accord", BMW_2015)).toEqual({ status: "unknown" });
  });

  const SECRET = "test-secret-test-secret-123456";
  const C = { conversation_id: "conv_ymm", eval_tag: "unit" };
  const setup = (models: (make: string, year: number) => Promise<string[] | null>) => {
    const repo = new Repo(openDb(":memory:"));
    const app = createApp({ repo, service: new QuoteService({ repo, now: () => new Date("2026-10-14T15:00:00Z"), decode: async () => ({ decoded: null, source: "timeout" }), models, licenseKey: "k" }), toolSecret: SECRET, opsUser: "max", opsPassword: "pw-pw-pw-pw" });
    const call = async (tool: string, body: Record<string, unknown>) =>
      (await (await app.request(`/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": SECRET }, body: JSON.stringify(body) })).json()) as any;
    return { repo, call };
  };
  const vehicle = (model: string) => ({ ...C, vehicle_index: 1, vin: "", year: 2015, make: "BMW", model, usage: "commute", annual_miles: 15000 });

  test("an unlisted model saves and returns the likely models to confirm", async () => {
    const { repo, call } = setup(async () => BMW_2015);
    await call("start_quote", { ...C, caller_name: "Max Harar", zip: "18940", prior_insurance_months: 36 });
    const r = await call("save_vehicle", vehicle("535"));
    expect(r.ok).toBe(true);
    expect(r.likely_models).toEqual(["535d", "535i"]);
    expect(r.warnings.join(" ")).toContain("MODEL_CHECK");
    expect(repo.vehicles(C.conversation_id)[0]!.model).toBe("535");
    const again = await call("save_vehicle", vehicle("535i"));
    expect(again.likely_models).toBeUndefined();
    expect(repo.vehicles(C.conversation_id)[0]!.model).toBe("535i");
  });

  test("a listed model is stored with vPIC's spelling", async () => {
    const { repo, call } = setup(async () => ["F-150", "Mustang"]);
    await call("start_quote", { ...C, caller_name: "Max Harar", zip: "18940", prior_insurance_months: 36 });
    expect((await call("save_vehicle", { ...vehicle("f150"), make: "Ford", year: 2019 })).vehicle).toBe("2019 FORD F-150");
    expect(repo.vehicles(C.conversation_id)[0]!.model).toBe("F-150");
  });

  test("vPIC down or slow never blocks the save", async () => {
    for (const models of [async () => null, async () => { throw new Error("timeout"); }]) {
      const { call } = setup(models as never);
      await call("start_quote", { ...C, caller_name: "Max Harar", zip: "18940", prior_insurance_months: 36 });
      const r = await call("save_vehicle", vehicle("535"));
      expect(r.ok).toBe(true);
      expect(r.likely_models).toBeUndefined();
    }
  });

  test("with a VIN, a slow decode never triggers a second vPIC call (review finding 3)", async () => {
    let modelCalls = 0;
    const repo = new Repo(openDb(":memory:"));
    const app = createApp({ repo, service: new QuoteService({ repo, now: () => new Date("2026-10-14T15:00:00Z"), decode: async () => ({ decoded: null, source: "timeout" }), models: async () => (modelCalls++, ["535i"]), licenseKey: "k" }), toolSecret: SECRET, opsUser: "max", opsPassword: "pw-pw-pw-pw" });
    const call = async (tool: string, body: Record<string, unknown>) =>
      (await (await app.request(`/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": SECRET }, body: JSON.stringify(body) })).json()) as any;
    await call("start_quote", { ...C, caller_name: "Max Harar", zip: "18940", prior_insurance_months: 36 });
    const r = await call("save_vehicle", { ...vehicle("535"), vin: "1HGC M826 33A0 04352" });
    expect(r.ok).toBe(true);
    expect(r.likely_models).toBeUndefined();
    expect(modelCalls).toBe(0);
  });

  test("the policy tells the agent how to confirm likely_models", async () => {
    expect((await renderedBody()).conversation_config.agent.prompt.prompt).toContain('If the tool returns `likely_models`, ask which one it is, for example "Is that the 535i or the 535d?"');
  });
});

describe("ops console shows the consent record (ISC-121)", () => {
  const { renderOpsQuote } = require("../src/server/ops") as typeof import("../src/server/ops");
  test("continued and declined both render with the disclosure version", () => {
    const repo = new Repo(openDb(":memory:"));
    const service = new QuoteService({ repo, now: () => new Date("2026-10-14T15:00:00Z"), decode: async () => ({ decoded: null, source: "timeout" }), licenseKey: "k" });
    service.startQuote({ conversationId: "conv_ok", evalTag: "unit", callerName: "Max Harar", zip: "18940", priorInsuranceMonths: 36 });
    service.flagForHuman({ conversationId: "conv_no", evalTag: "unit", reason: "declined_recording", summary: "Declined." });
    expect(renderOpsQuote(repo, "conv_ok", {})!).toContain(`disclosed, caller continued`);
    const declined = renderOpsQuote(repo, "conv_no", {})!;
    expect(declined).toContain(`<span class="warning">caller declined</span>`);
    expect(declined).toContain(`disclosure ${DISCLOSURE_VERSION}`);
  });
});

describe("modelsForMakeYear (vPIC model list fetch)", () => {
  const { modelsForMakeYear } = require("../src/verify/vpic") as typeof import("../src/verify/vpic");
  const respond = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  test("maps aliases, dedupes names, and caches per make and year", async () => {
    const urls: string[] = [];
    const f = (async (u: string | URL) => (urls.push(String(u)), new Response(JSON.stringify({ Results: [{ Model_Name: "GLC-Class" }, { Model_Name: "GLC-Class" }, { Model_Name: " GLE-Class " }, {}] })))) as unknown as typeof fetch;
    expect(await modelsForMakeYear("Mercedes", 2031, f)).toEqual(["GLC-Class", "GLE-Class"]);
    expect(await modelsForMakeYear("mercedes", 2031, f)).toEqual(["GLC-Class", "GLE-Class"]);
    expect(urls).toEqual(["https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/mercedes-benz/modelyear/2031?format=json"]);
  });
  test("an HTTP error, an empty list, or a network failure is null", async () => {
    expect(await modelsForMakeYear("Acme", 2032, respond({}, 503))).toBeNull();
    expect(await modelsForMakeYear("Acme", 2033, respond({ Results: [] }))).toBeNull();
    expect(await modelsForMakeYear("Acme", 2034, (async () => { throw new Error("down"); }) as unknown as typeof fetch)).toBeNull();
  });
});
