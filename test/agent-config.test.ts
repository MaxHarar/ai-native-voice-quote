import { describe, expect, test } from "bun:test";
import { FIRST_MESSAGE, TOOLS } from "../agent/config";
import { buildAgentBody } from "../agent/deploy";
import { stateConfig } from "../src/rating/rateTable";
import { TOOL_SCHEMAS, evalTagFor } from "../src/server/app";
import { renderPolicy } from "../src/policy";

// Regression guard for the 2026-10-15 outage: a tool bound the custom dynamic variable `eval_tag`,
// which live phone calls never carry, so ElevenLabs refused to start every inbound call
// ("Missing required dynamic variables in tools: {'eval_tag'}", code 1008).

describe("agent config is safe for live phone calls", () => {
  test("tools bind only system__* dynamic variables", () => {
    for (const t of TOOLS) {
      for (const [name, prop] of Object.entries(t.properties)) {
        if (prop.dynamic_variable) expect(`${t.name}.${name}=${prop.dynamic_variable}`).toMatch(/=system__/);
        expect(Boolean(prop.dynamic_variable) && Boolean(prop.description)).toBe(false); // mutually exclusive in the API
      }
    }
  });

  test("every required tool parameter is defined", () => {
    for (const t of TOOLS) for (const r of t.required) expect(Object.keys(t.properties)).toContain(r);
  });

  test("prompt and first message contain no unresolved {{variables}}", async () => {
    const body = await buildAgentBody(["tool_x"], undefined);
    const prompt = body.conversation_config.agent.prompt.prompt;
    const unresolved = [...`${prompt}\n${FIRST_MESSAGE}`.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]!).filter((v) => !v.startsWith("system__"));
    expect(unresolved).toEqual([]);
  });

  test("no custom dynamic-variable placeholders are relied on", async () => {
    const body = await buildAgentBody(["tool_x"], undefined);
    expect(JSON.stringify(body)).not.toContain("dynamic_variable_placeholders");
  });
});

describe("eval tag is derived server-side", () => {
  test("simulation ids carry the tag; live ids are 'live'", () => {
    expect(evalTagFor("sim_eval-20261015T002759-happy-path-t1")).toBe("eval-20261015T002759-happy-path-t1");
    expect(evalTagFor("conv_4901m4yfv4nqf9vtm7tfpevtrjyy")).toBe("live");
    expect(evalTagFor("conv_x", "unit")).toBe("unit");
  });
});

describe("turn-taking safety nets (2026-10-15 stall)", () => {
  test("pending speech is re-transcribed at the turn timeout, and slow responses get a filler", async () => {
    const turn = (await buildAgentBody(["tool_x"], undefined)).conversation_config.turn as Record<string, any>;
    expect(turn.retranscribe_on_turn_timeout).toBe(true);
    expect(turn.turn_timeout).toBe(10);
    expect(turn.soft_timeout_config).toMatchObject({ timeout_seconds: 3, message: "One moment." });
  });
});

describe("Pennsylvania support in the agent definition", () => {
  test("set_coverage accepts an optional limited/full tort option", () => {
    const t = TOOLS.find((x) => x.name === "set_coverage")!;
    expect(t.properties.tort_option?.enum).toEqual(["limited", "full"]);
    expect(t.required).not.toContain("tort_option");
  });

  test("policy covers all three states and the PA tort script", async () => {
    const body = await buildAgentBody(["tool_x"], undefined);
    const prompt = body.conversation_config.agent.prompt.prompt;
    expect(prompt).toContain("New Jersey, Pennsylvania, or Michigan");
    expect(prompt).toContain("Limited tort costs less but limits your right to sue");
    expect(prompt).toContain("use full tort, the Pennsylvania default");
  });

  // Eval price-objection, release 36b87a9: after balking, the caller asked for limited tort (its price had just been
  // read out) and Elise switched on the spot, with no fresh trade-off (75 Pa.C.S. § 1705): tort moved to save money.
  test("policy keeps tort out of price objections and re-reads the trade-off before a caller-requested switch", async () => {
    const prompt = (await buildAgentBody(["tool_x"], undefined)).conversation_config.agent.prompt.prompt;
    expect(prompt).toContain("Offer only options from `ways_to_lower`; never change a tort choice the caller made to lower the price.");
    expect(prompt).toContain("If the caller asks to switch tort, first re-read the tort sentence from step 5 and get a clear choice.");
    expect(prompt).toContain("as information only, never as a way to save");
  });
});

describe("Michigan support in the agent definition", () => {
  const renderedPrompt = async () => (await buildAgentBody(["tool_x"], undefined)).conversation_config.agent.prompt.prompt;

  test("start_quote declares an optional garaging_city string", () => {
    const t = TOOLS.find((x) => x.name === "start_quote")!;
    expect(t.properties.garaging_city?.type).toBe("string");
    expect(t.required).not.toContain("garaging_city");
  });

  test("set_coverage declares optional pip_medical (enum = the Michigan PIP levels) and pip_confirmed (boolean)", () => {
    const t = TOOLS.find((x) => x.name === "set_coverage")!;
    const levels = Object.keys(stateConfig("MI").pipMedical!);
    expect(t.properties.pip_medical?.type).toBe("string");
    expect([...(t.properties.pip_medical?.enum ?? [])].sort()).toEqual([...levels].sort());
    expect(t.properties.pip_confirmed?.type).toBe("boolean");
    expect(t.required).not.toContain("pip_medical");
    expect(t.required).not.toContain("pip_confirmed");
  });

  // zod objects strip unknown keys, so contract.test.ts still passes when the server forgets a field the agent sends;
  // the value would then be dropped silently. This pins the declarations themselves.
  test("the server schemas declare every Michigan param the agent sends", () => {
    expect(Object.keys(TOOL_SCHEMAS.start_quote.shape)).toContain("garaging_city");
    expect(Object.keys(TOOL_SCHEMAS.set_coverage.shape)).toEqual(expect.arrayContaining(["pip_medical", "pip_confirmed"]));
  });

  test("policy scripts the PIP choice, the eligibility check, and the unlimited default", async () => {
    const prompt = await renderedPrompt();
    expect(prompt).toContain(
      "Michigan has you choose your PIP medical coverage, which pays your medical bills after a crash: unlimited, 500,000, or 250,000 dollars, or lower options if you have Medicare, Medicaid, or qualifying health insurance. Which would you like?",
    );
    expect(prompt).toContain("PIP_ELIGIBILITY_CHECK");
    expect(prompt).toContain("`pip_confirmed` true");
    expect(prompt).toContain("`if_not_eligible`");
    expect(prompt).toContain("use unlimited, the Michigan default");
  });

  // MCL 500.3109a(2)(a): the $250k exclusion needs health insurance other than Medicare; Medicare Parts A and B use the opt-out.
  test("policy maps Medicare to the opt-out and non-Medicare household insurance to the exclusion", async () => {
    const prompt = await renderedPrompt();
    expect(prompt).toContain("opt_out for Medicare Parts A and B");
    expect(prompt).toContain("250k_excluded for health insurance other than Medicare, covering the whole household");
    expect(prompt).toContain("50k for Medicaid");
    expect(prompt).not.toContain("qualifying health insurance that covers");
  });

  // The server owns the eligibility and disclosure wording (deductible cap is indexed every July 1), so the policy only points at it.
  test("policy points at the server's eligibility text instead of restating its dollar figures", async () => {
    const prompt = await renderedPrompt();
    expect(prompt).toContain("the reply's `eligibility`");
    expect(prompt).toContain("read the `disclosure` word for word");
    expect(prompt).not.toMatch(/\b6,\d{3}\b/);
  });

  test("policy asks for the garaging city and remembers the PIP flag", async () => {
    const prompt = await renderedPrompt();
    expect(prompt).toContain("CITY_REQUIRED");
    expect(prompt).toContain("What city or township is the car parked in overnight?");
    expect(prompt).toContain("`garaging_city`");
    expect(prompt).toContain("`pip_choice_required`");
    expect(prompt).toContain("New Jersey, Pennsylvania, and Michigan cars");
  });

  test("policy covers the fee, the read-back, and the PIP advice hand-off", async () => {
    const prompt = await renderedPrompt();
    expect(prompt).toContain("`mcca_fee_included`");
    expect(prompt).toContain("the PIP medical choice (Michigan)");
    expect(prompt).toContain("which PIP medical level is right for them");
    expect(prompt).toContain("`start_quote` says the car is garaged out of state");
  });

  test("policy tells Michigan callers the license format and no stale two-state wording remains", async () => {
    const prompt = await renderedPrompt();
    expect(prompt).toContain('Michigan: "the letter and twelve digits"');
    expect(prompt).not.toContain("New Jersey and Pennsylvania");
    expect(prompt).not.toContain("New Jersey or Pennsylvania");
    expect(prompt).not.toContain("garaged outside New Jersey");
  });
});

describe("voice and persona", () => {
  // The voice and the name the agent introduces itself with must match. A voice with live moderation enabled
  // (e.g. the library voice Caroline) is rejected by ElevenLabs for agents with a 400 at deploy time.
  test("policy covers the fix-wave replies: lookup last name, ALREADY_APPLIED, TRANSFERRED, RESUME_UNAVAILABLE (review 2026-10-16)", async () => {
    const policy = await renderPolicy();
    expect(policy).toMatch(/lookup_application.*last name|last name.*lookup_application/);
    expect(policy).toContain("ALREADY_APPLIED");
    expect(policy).toContain("TRANSFERRED");
    expect(policy).toContain("RESUME_UNAVAILABLE");
    // Hints are instructions, never codes to speak; the policy's own rule still forbids reading codes aloud.
    expect(policy).toContain("Never read error codes");
    const lookup = TOOLS.find((t) => t.name === "lookup_application")!;
    expect(lookup.required).toEqual(expect.arrayContaining(["conversation_id", "application_number", "last_name"]));
    expect(lookup.properties.conversation_id!.dynamic_variable).toBe("system__conversation_id");
  });

  test("the agent speaks as Elise with Elise's voice", async () => {
    const body = await buildAgentBody(["tool_x"], undefined);
    expect(body.conversation_config.tts.voice_id).toBe("EST9Ui6982FZPSi7gCHi");
    expect(body.conversation_config.agent.first_message).toContain("this is Elise, a virtual assistant");
    expect(JSON.stringify(body)).not.toMatch(/Caroline|Lily/);
  });
});
