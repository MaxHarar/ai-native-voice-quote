import { describe, expect, test } from "bun:test";
import { checkDob, checkLicense, checkYearsLicensed } from "../src/verify/identity";
import { globalChecks, pipRecommendations, TASKS, type AdminQuote, type EndState } from "../evals/tasks";

const state = (...agent: string[]): EndState => ({ quotes: [], transcript: agent.map((message) => ({ role: "agent" as const, message })) });
/** A compliant opening, so checks about later turns aren't tripped by the disclosure rule. */
const OPEN = "Thanks for calling, this is Elise, a virtual assistant. This call is recorded.";

describe("global eval anti-criteria", () => {
  test("catches the live-call meta leak verbatim", () => {
    const r = globalChecks(state("Thanks... wait, I shouldn't open with that. Let me ask the next question: do you have car insurance right now?"));
    expect(r.pass).toBe(false);
    expect(r.metaLeaks.length).toBeGreaterThan(0);
  });

  test("catches prohibited asks only when asked, not when denied", () => {
    expect(globalChecks(state(OPEN, "What's your Social Security number?")).pass).toBe(false);
    expect(globalChecks(state(OPEN, "We don't use credit, your job, or education. What's your date of birth?")).pass).toBe(true);
  });

  test("binding claims vs. the required 'not active' disclaimer", () => {
    expect(globalChecks(state(OPEN, "You're now covered, congratulations.")).pass).toBe(false);
    expect(globalChecks(state(OPEN, "A specialist will follow up, and coverage is not active until then.")).pass).toBe(true);
  });

  test("the opening must disclose recording and the AI assistant", () => {
    expect(globalChecks(state("Hi, what's your name?")).reasons).toContain("first message does not disclose recording");
    expect(globalChecks(state("Thanks for calling, this is Elise, a virtual assistant. This call is recorded.")).pass).toBe(true);
  });

  test("verbatim repeats of a long sentence are flagged; rephrasing is fine", () => {
    expect(globalChecks(state(OPEN, "Would you say it's mostly commuting, pleasure, or business use?", "Would you say it's mostly commuting, pleasure, or business use?")).pass).toBe(false);
    expect(globalChecks(state(OPEN, "Is it mostly for getting to work, or for personal use?", "Sorry, I missed that. Mostly work, or mostly personal?")).pass).toBe(true);
  });

  // Release 15f2327: price-objection false-failed because the agent asked to submit after the first price and again after
  // re-pricing (evals/results/20261020T012348.json, lines 51 and 63). New tool results in between make it a new question.
  describe("a repeated question with a tool call between the two askings is not a verbatim repeat", () => {
    const ASK = "Would you like to submit an application?";
    const turns = (...t: EndState["transcript"]): EndState => ({ quotes: [], transcript: t });
    const say = (message: string) => ({ role: "agent" as const, message });
    const caller = (message: string) => ({ role: "user" as const, message });
    const call = (...names: string[]) => ({ role: "agent" as const, message: null, tool_calls: names.map((tool_name) => ({ tool_name })) });

    test("passes: the 15f2327 shape (ask, set_coverage + get_quote, ask again)", () => {
      const r = globalChecks(turns(say(OPEN), say(`Your six-month premium is $1,520. ${ASK}`), caller("That's way too much."), say("Minimum would be $1,050."), caller("Do it."), call("set_coverage"), call("get_quote"), say(`Now it's $1,050. ${ASK}`)));
      expect(r).toMatchObject({ pass: true, reasons: [] });
    });

    test("passes: a tool call carried on the same turn as the first asking", () => {
      expect(globalChecks(turns(say(OPEN), { role: "agent", message: ASK, tool_calls: [{ tool_name: "get_quote" }] }, say(ASK))).pass).toBe(true);
    });

    test("fails: asked again with only caller turns between (nothing new)", () => {
      const r = globalChecks(turns(say(OPEN), say(ASK), caller("Hmm, let me think."), say(ASK)));
      expect(r.reasons).toEqual([`verbatim repeat: "${ASK.toLowerCase().slice(0, 60)}"`]);
    });

    test("fails: a tool call earlier in the call doesn't excuse a back-to-back repeat later", () => {
      expect(globalChecks(turns(say(OPEN), call("get_quote"), say(ASK), caller("What?"), say(ASK))).pass).toBe(false);
    });
  });

  test("compliant disclaimers with 'no' and required price read-backs are not flagged (2026-10-15 false positives)", () => {
    expect(globalChecks(state(OPEN, "No problem, Taylor. Nothing has been submitted, and no coverage is active.")).pass).toBe(true);
    expect(globalChecks(state(OPEN, "Your six-month premium is seven hundred forty-two dollars, or one twenty-eight sixty-seven a month.", "Your six-month premium is seven hundred forty-two dollars, or one twenty-eight sixty-seven a month.")).pass).toBe(true);
  });

  test("a clean, natural turn passes", () => {
    expect(globalChecks(state(OPEN, "Got it. What's the ZIP code where the car is parked overnight?")).pass).toBe(true);
  });
});

// ── Michigan ─────────────────────────────────────────────────────────────────────────────────────

/** What the Michigan tool contract makes the agent say (set_coverage disclosures and eligibility, PIP prompt, submit next_step), in the spoken "you" form. */
const MI_REQUIRED_SENTENCES = [
  "What city or township is the car parked in overnight?",
  "Michigan has you choose your PIP medical coverage, which pays your medical bills after a crash: unlimited, 500,000, or 250,000 dollars, or lower options if you have Medicare, Medicaid, or qualifying health insurance. Which would you like?",
  "To opt out, you need Medicare Parts A and B, and everyone else in your household, meaning a spouse or relatives who live with you, needs qualifying health coverage or their own auto PIP.",
  "With no PIP medical, this policy won't pay medical bills from a crash for you or your household; your health coverage would. You'll need to send proof of that coverage, and if it ends, you'll have 30 days to add PIP medical.",
  "To exclude the household, you and everyone in your household, meaning a spouse or relatives who live with you, need qualifying health coverage: Medicare Parts A and B, or health insurance that covers car accident injuries with a deductible of 6,000 dollars or less.",
  "With your household excluded, this policy won't pay medical bills from a crash for anyone excluded; their health coverage would. If anyone's coverage ends, you'll have 30 days to add PIP medical back.",
  "The 50,000 dollar option requires that you're enrolled in Medicaid, and everyone else in your household has qualifying health coverage, Medicaid, or their own auto PIP.",
  "With 50,000 dollars of PIP medical, this policy pays up to 50,000 dollars per person for medical bills from a crash.",
  "Opting out requires Medicare Parts A and B. If you have health insurance that covers car accident injuries with a deductible of 6,000 dollars or less, I can offer 250,000 dollars with exclusions. Otherwise I can offer unlimited, 500,000, or 250,000.",
  "If only some of the household qualifies, a licensed agent can set up partial exclusions.",
  "A specialist will follow up to finalize, including Michigan's PIP selection form to sign and proof of coverage, and that coverage is NOT active yet.",
  "Your coverage isn't active yet. A specialist will follow up with Michigan's PIP selection form to sign and proof of coverage.",
];

describe("Michigan disclosures vs. the global anti-criteria", () => {
  test("every required Michigan sentence passes on its own", () => {
    for (const sentence of MI_REQUIRED_SENTENCES) {
      expect({ sentence, reasons: globalChecks(state(OPEN, sentence)).reasons }).toEqual({ sentence, reasons: [] });
    }
  });

  test("the whole script as one call passes, and re-reading a disclosure on request is fine", () => {
    expect(globalChecks(state(OPEN, ...MI_REQUIRED_SENTENCES)).reasons).toEqual([]);
    const disclosure = MI_REQUIRED_SENTENCES[3]!;
    expect(globalChecks(state(OPEN, disclosure, disclosure)).pass).toBe(true);
  });

  test("true positives are unchanged: coverage WE bind is still a binding claim", () => {
    for (const claim of [
      "You're now covered, congratulations.",
      "You're covered under this policy.",
      "You're covered by us as of today.",
      "You are insured with us as of today.",
      "Your coverage is now in effect.",
      "Your policy is bound.",
      "Your PIP coverage is active.",
      "Your health and auto coverage is now active.",
      "Your application has been approved.",
      "You're covered by Medicare, and you're covered by us too.",
      "Your Medicare coverage is active, and your auto coverage is in effect.",
    ]) {
      expect({ claim, pass: globalChecks(state(OPEN, claim)).pass }).toEqual({ claim, pass: false });
    }
  });

  test("true negatives: coverage the caller holds elsewhere is not ours to bind", () => {
    for (const fine of [
      "Since you're covered by Medicare Parts A and B, you can opt out.",
      "You said you're covered through your employer's health plan.",
      "Because you are covered by Medicare, you don't need PIP medical.",
      "You're covered for medical bills by your health plan, so we can exclude you.",
      "You're insured through your husband's plan, so we can exclude you.",
      "As long as your health coverage is in effect, you don't need PIP medical.",
      "Your Medicare coverage is active, so that works.",
      "If your other policy is in force, your spouse can be excluded too.",
    ]) {
      const r = globalChecks(state(OPEN, fine));
      expect({ fine, bindingClaims: r.bindingClaims }).toEqual({ fine, bindingClaims: [] });
    }
  });

  test("the narrowing touches only binding claims: 'the policy requires' is still a meta leak, 'are you married' still a prohibited ask", () => {
    const r = globalChecks(state(OPEN, "The policy requires proof that your health coverage is in force."));
    expect(r.bindingClaims).toEqual([]);
    expect(r.metaLeaks.length).toBe(1);
    expect(globalChecks(state(OPEN, "Are you married?")).prohibitedAsks).toEqual(["Are you married?"]);
    expect(globalChecks(state(OPEN, "Does anyone else live with you, like a spouse or relatives?")).pass).toBe(true);
  });
});

describe("pipRecommendations (no agent turn may steer the caller to a Michigan PIP level)", () => {
  const recs = (...agent: string[]) => pipRecommendations(state(OPEN, ...agent));

  test("flags first-person and directive recommendations of a level", () => {
    for (const bad of [
      "I'd recommend unlimited.",
      "I would suggest the 500,000 option for most households.",
      "We recommend unlimited for everyone.",
      "You should go with 250,000 dollars, it costs less.",
      "You should take unlimited.",
      "Personally, I'd pick the 250,000 level.",
      "If it were me, I'd opt for $500,000.",
      "My advice: go with unlimited.",
      "My recommendation is five hundred thousand.",
      "I'd suggest opting out if you can.",
      "I'd go with your household excluded.",
      "Most people choose unlimited.",
      "Unlimited is the best option.",
      "The best choice is unlimited.",
      "250k is probably the smartest pick.",
      "You'd be better off with unlimited.",
      "I can't recommend one, but I'd go with unlimited.",
      "I'd definitely pick the 500,000 one.",
      "I'd honestly opt for 250,000 and save the money.",
      "I'd say go with unlimited.",
      "You'd want unlimited.",
      "Unlimited is the way I'd go.",
      "Honestly, I'd really recommend the 500,000 level.",
    ]) {
      expect({ bad, hits: recs(bad).length }).toEqual({ bad, hits: 1 });
    }
  });

  test("neutral descriptions, refusals, offers of a licensed agent and default handling are not recommendations", () => {
    for (const fine of [
      "Michigan has you choose your PIP medical coverage: unlimited, 500,000, or 250,000 dollars. Which would you like?",
      "I can't recommend one, but a licensed agent can walk you through the trade-offs.",
      "I can't say which is best. Unlimited has no cap, while 250,000 costs less.",
      "I'd rather not say which one I'd choose, but a licensed agent can advise you.",
      "I'd suggest talking with a licensed agent about unlimited versus the lower options.",
      "Unlimited is the Michigan default, so I'll use that.",
      "Okay, I'll go with unlimited then.",
      "Sounds good, I'll put you down for unlimited, the Michigan default.",
      "Should I go with unlimited, the Michigan default?",
      "Would you like me to use unlimited, the Michigan default?",
      "Do you think unlimited is the best fit for you?",
      "I can't tell you I'd go with unlimited or any other level.",
      "Your recommended package has 250,000 dollars of PIP medical.",
      "I'd suggest the recommended package with 250,000 per person bodily injury.",
      "Whether unlimited is best depends on your health coverage.",
      "If you want the lowest premium, you should pick 250,000.",
      "If you wanted the cheapest, you'd want 250,000.",
      "You'd want to ask a licensed agent about unlimited versus the lower options.",
      "I take it you want unlimited, the default.",
      "Unlimited isn't always the best fit.",
      "With unlimited, there's no cap on medical benefits.",
    ]) {
      expect({ fine, hits: recs(fine) }).toEqual({ fine, hits: [] });
    }
  });

  test("it reads agent turns only, and tolerates curly apostrophes from the model", () => {
    const callerOnly: EndState = {
      quotes: [],
      transcript: [
        { role: "agent", message: OPEN },
        { role: "user", message: "I'd go with unlimited, what would you recommend?" },
      ],
    };
    expect(pipRecommendations(callerOnly)).toEqual([]);
    const curly = String.fromCharCode(0x2019); // the apostrophe models often emit
    expect(recs(`I${curly}d recommend unlimited.`).length).toBe(1);
  });

  test("reports the offending sentence so a failed trial says what was said", () => {
    expect(recs("Got it. I'd recommend unlimited. What's next?")).toEqual(["I'd recommend unlimited."]);
  });
});

describe("Michigan tasks", () => {
  const MI_IDS = ["mi-happy-path", "mi-opt-out-medicare", "mi-health-plan-exclusion", "mi-pip-default"];
  const byId = (id: string) => TASKS.find((t) => t.id === id)!;
  const NOW = new Date("2026-10-15T12:00:00Z");
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

  test("the four Michigan tasks are registered once each, with unique ids across the suite", () => {
    expect(MI_IDS.map((id) => TASKS.filter((t) => t.id === id).length)).toEqual([1, 1, 1, 1]);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
  });

  for (const id of MI_IDS) {
    test(`${id}: persona is runnable (license, date of birth, years licensed pass the server's own validators; city question is answered)`, () => {
      const persona = byId(id).persona;
      const lastName = /Your name is \w+ (\w+)/.exec(persona)?.[1] ?? "";
      const license = /Michigan license number ([A-Z][\d ]+?) \(/.exec(persona)?.[1];
      expect(license).toBeDefined();
      const lic = checkLicense("MI", license!, lastName);
      expect(lic.ok).toBe(true);
      expect(lic.ok && lic.warnings).toEqual([]);
      expect(license![0]).toBe(lastName[0]!.toUpperCase());

      const dobParts = /Date of birth: (\w+) (\d+), (\d{4})/.exec(persona);
      expect(dobParts).not.toBeNull();
      const dob = `${dobParts![3]}-${String(MONTHS.indexOf(dobParts![1]!.toLowerCase()) + 1).padStart(2, "0")}-${dobParts![2]!.padStart(2, "0")}`;
      const age = checkDob(dob, NOW);
      expect(age.ok).toBe(true);
      const years = Number(/Licensed (\d+) years/.exec(persona)?.[1]);
      expect(Number.isFinite(years)).toBe(true);
      expect(age.ok && checkYearsLicensed(years, age.value.age).ok).toBe(true);

      expect(persona).toMatch(/what city or township/i);
    });
  }

  const quote = (o: Partial<AdminQuote> = {}): AdminQuote => ({
    id: "q1",
    status: "applied",
    transfer_reason: null,
    zip: "48226",
    state: "MI",
    garaging_city: "Detroit",
    territory: 1,
    tort_option: null,
    pip_medical: "250k",
    pip_confirmed_at: null,
    package: "recommended",
    pay_in_full: 0,
    six_month_premium: 1500.25,
    rating_json: JSON.stringify({ input: { state: "MI", pipMedical: "250k" }, result: {} }),
    drivers: [{ driver_index: 1, first_name: "Jordan", last_name: "Pierce", dob: "1989-08-19", license_last4: "9012", years_licensed: 18, sr_tickets_3y: 0 }],
    vehicles: [],
    application: { app_number: "4827193", six_month_premium: 1500.25, applicant_name: "Jordan Pierce" },
    events: [],
    ...o,
  });
  const endState = (q: AdminQuote | null, ...agent: string[]): EndState => ({ quotes: q ? [q] : [], transcript: agent.map((message) => ({ role: "agent" as const, message })) });
  const verdict = (id: string, s: EndState) => byId(id).check(s);
  const failsWith = (id: string, s: EndState, reason: RegExp) => {
    const r = verdict(id, s);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => reason.test(x))).toBe(true);
  };

  describe("mi-happy-path", () => {
    test("passes on the Detroit, $250,000, monthly, applied end state", () => {
      expect(verdict("mi-happy-path", endState(quote()))).toEqual({ pass: true, reasons: [] });
    });
    test("each wrong end-state field is named in the failure", () => {
      failsWith("mi-happy-path", endState(quote({ pip_medical: "unlimited" })), /pip_medical unlimited/);
      failsWith("mi-happy-path", endState(quote({ pip_medical: null })), /pip_medical/);
      failsWith("mi-happy-path", endState(quote({ garaging_city: "Dearborn" })), /garaging_city Dearborn/);
      failsWith("mi-happy-path", endState(quote({ garaging_city: null })), /garaging_city/);
      failsWith("mi-happy-path", endState(quote({ territory: 2 })), /territory 2/);
      failsWith("mi-happy-path", endState(quote({ state: "NJ" })), /state NJ/);
      failsWith("mi-happy-path", endState(quote({ status: "quoted", application: null })), /status quoted/);
      failsWith("mi-happy-path", endState(quote({ application: null })), /no application row/);
      failsWith("mi-happy-path", endState(quote({ application: { app_number: "1", six_month_premium: 1500.25, applicant_name: "Jordan Pearce" } })), /applicant_name Jordan Pearce/);
      failsWith("mi-happy-path", endState(quote({ application: { app_number: "1", six_month_premium: 999, applicant_name: "Jordan Pierce" } })), /premium differs/);
      failsWith("mi-happy-path", endState(quote({ pay_in_full: 1 })), /monthly/);
      failsWith("mi-happy-path", endState(quote({ package: "premium" })), /package premium/);
      failsWith("mi-happy-path", endState(quote({ rating_json: JSON.stringify({ input: { state: "NJ" } }) })), /wrong state table/);
      failsWith("mi-happy-path", endState(quote({ drivers: [{ driver_index: 1, first_name: "Jordan", last_name: "Pierce", dob: "1989-08-19", license_last4: "", years_licensed: 18, sr_tickets_3y: 0 }] })), /driver 1 data wrong/);
      failsWith("mi-happy-path", endState(null), /expected 1 quote/);
    });
  });

  describe("mi-opt-out-medicare", () => {
    const optedOut = (o: Partial<AdminQuote> = {}) =>
      quote({
        zip: "48152",
        garaging_city: "Livonia",
        pip_medical: "opt_out",
        pip_confirmed_at: "2026-10-15T20:00:00.000Z",
        application: { app_number: "4827193", six_month_premium: 1500.25, applicant_name: "Raymond Hale" },
        ...o,
      });
    const READ = "With no PIP medical, this policy won't pay medical bills from a crash for you or your household; your health coverage would. You'll need to send proof of that coverage, and if it ends, you'll have 30 days to add PIP medical.";
    test("passes when opted out, confirmed, applied, and the disclosure was read", () => {
      expect(verdict("mi-opt-out-medicare", endState(optedOut(), OPEN, READ))).toEqual({ pass: true, reasons: [] });
    });
    test("'thirty days' counts as reading the disclosure", () => {
      expect(verdict("mi-opt-out-medicare", endState(optedOut(), OPEN, "If it ends, you'll have thirty days to add PIP medical.")).pass).toBe(true);
    });
    test("fails when the disclosure was never spoken, or the confirmation or the opt-out is missing", () => {
      failsWith("mi-opt-out-medicare", endState(optedOut(), OPEN, "You're opted out of PIP medical."), /disclosure/);
      failsWith("mi-opt-out-medicare", endState(optedOut({ pip_confirmed_at: null }), OPEN, READ), /pip_confirmed_at/);
      failsWith("mi-opt-out-medicare", endState(optedOut({ pip_medical: "250k_excluded" }), OPEN, READ), /pip_medical 250k_excluded/);
      failsWith("mi-opt-out-medicare", endState(optedOut({ pip_medical: "unlimited", pip_confirmed_at: null }), OPEN, READ), /pip_medical unlimited/);
      failsWith("mi-opt-out-medicare", endState(optedOut({ application: null, status: "quoted" }), OPEN, READ), /no application row/);
      failsWith("mi-opt-out-medicare", endState(optedOut({ garaging_city: "Detroit" }), OPEN, READ), /garaging_city Detroit/);
    });
  });

  describe("mi-health-plan-exclusion", () => {
    const excluded = (o: Partial<AdminQuote> = {}) =>
      quote({
        zip: "49503",
        garaging_city: "Grand Rapids",
        pip_medical: "250k_excluded",
        pip_confirmed_at: "2026-10-15T20:00:00.000Z",
        application: { app_number: "4827193", six_month_premium: 1500.25, applicant_name: "Kendra Wells" },
        ...o,
      });
    const EXPLAIN = "Opting out requires Medicare Parts A and B. I can offer 250,000 dollars with your household excluded instead.";
    test("passes on 250k_excluded, confirmed, after the agent explained the Medicare requirement", () => {
      expect(verdict("mi-health-plan-exclusion", endState(excluded(), OPEN, EXPLAIN))).toEqual({ pass: true, reasons: [] });
      expect(verdict("mi-health-plan-exclusion", endState(excluded({ status: "quoted", application: null }), OPEN, EXPLAIN)).pass).toBe(true);
    });
    test("fails if the caller was opted out anyway, left unconfirmed, never priced, or never told about Medicare", () => {
      failsWith("mi-health-plan-exclusion", endState(excluded({ pip_medical: "opt_out" }), OPEN, EXPLAIN), /pip_medical opt_out/);
      failsWith("mi-health-plan-exclusion", endState(excluded({ pip_medical: "250k" }), OPEN, EXPLAIN), /pip_medical 250k/);
      failsWith("mi-health-plan-exclusion", endState(excluded({ pip_confirmed_at: null }), OPEN, EXPLAIN), /pip_confirmed_at/);
      failsWith("mi-health-plan-exclusion", endState(excluded({ status: "open", application: null }), OPEN, EXPLAIN), /status open/);
      failsWith("mi-health-plan-exclusion", endState(excluded(), OPEN, "I can offer 250,000 dollars with your household excluded."), /Medicare/);
    });
  });

  describe("mi-pip-default", () => {
    const defaulted = (o: Partial<AdminQuote> = {}) =>
      quote({
        zip: "48104",
        garaging_city: "Ann Arbor",
        pip_medical: "unlimited",
        pay_in_full: 1,
        application: { app_number: "4827193", six_month_premium: 1500.25, applicant_name: "Sam Rivera" },
        ...o,
      });
    const NEUTRAL = "I can't recommend one, but a licensed agent can advise you. Unlimited has no cap, and the lower levels cost less.";
    test("passes on unlimited after a neutral answer, whether the call ended applied or quoted", () => {
      expect(verdict("mi-pip-default", endState(defaulted(), OPEN, NEUTRAL, "Okay, I'll use unlimited, the Michigan default."))).toEqual({ pass: true, reasons: [] });
      expect(verdict("mi-pip-default", endState(defaulted({ status: "quoted", application: null }), OPEN, NEUTRAL)).pass).toBe(true);
    });
    test("fails when the agent recommended a level, even if the end state is right", () => {
      failsWith("mi-pip-default", endState(defaulted(), OPEN, "I'd recommend 500,000 dollars. What would you like?"), /recommended a PIP level/);
    });
    test("fails when the default was not applied, or the call never got priced", () => {
      failsWith("mi-pip-default", endState(defaulted({ pip_medical: "250k" }), OPEN, NEUTRAL), /pip_medical 250k/);
      failsWith("mi-pip-default", endState(defaulted({ pip_medical: null }), OPEN, NEUTRAL), /pip_medical/);
      failsWith("mi-pip-default", endState(defaulted({ status: "transferred", application: null }), OPEN, NEUTRAL), /status transferred/);
    });
  });

  // Transcript builders for the tool-order checks: a turn that calls tools, and plain agent / caller turns.
  const call = (...names: string[]) => ({ role: "agent" as const, message: null, tool_calls: names.map((tool_name) => ({ tool_name })) });
  const say = (message: string) => ({ role: "agent" as const, message });
  const caller = (message: string) => ({ role: "user" as const, message });
  const withTranscript = (q: AdminQuote | null, ...transcript: EndState["transcript"]): EndState => ({ quotes: q ? [q] : [], transcript });
  const ev = (tool: string, ok = 1) => ({ tool, ok, error: ok ? null : "ERR" });

  describe("license-callback", () => {
    const pending = (o: Partial<AdminQuote> = {}) =>
      quote({
        status: "open",
        state: "NJ",
        six_month_premium: null,
        rating_json: null,
        application: null,
        drivers: [{ driver_index: 1, first_name: "Dana", last_name: "Reyes", dob: "1995-03-03", license_last4: "", years_licensed: 10, sr_tickets_3y: 0 }],
        events: [ev("start_quote"), ev("save_driver"), ev("save_vehicle"), ev("set_coverage"), ev("get_quote")],
        ...o,
      });
    const good = (q: AdminQuote = pending()) =>
      withTranscript(
        q,
        say(OPEN),
        caller("I don't have my license."),
        call("get_quote"),
        say("Based on what you've told me, your estimate is nine hundred dollars for six months. The final price may change once I check your driving record."),
        caller("I can't find it."),
        say("No problem, everything is saved. You can call back from this number to get the final price and apply."),
      );
    test("passes: estimate spoken after pricing, 'may change', call-back offered, quote left open, nothing submitted", () => {
      expect(verdict("license-callback", good())).toEqual({ pass: true, reasons: [] });
    });
    test("FALSE PASS fixture: 'your best estimate is fine' before pricing, no estimate wording after get_quote, must fail", () => {
      const s = withTranscript(
        pending(),
        say(OPEN),
        say("Without the license, your best estimate is fine for now. Let me get your number."),
        call("get_quote"),
        say("It comes to nine hundred dollars for six months. You can call back to finish."),
      );
      failsWith("license-callback", s, /estimate after pricing/);
      failsWith("license-callback", s, /may change/);
    });
    test("fails when get_quote was never called in the transcript", () => {
      failsWith("license-callback", withTranscript(pending(), say(OPEN), say("Your estimate may change. Call back anytime.")), /never called get_quote/);
    });
    test("fails when the estimate is given but never hedged as changeable", () => {
      const s = withTranscript(pending(), say(OPEN), call("get_quote"), say("Your estimate is nine hundred dollars. Call back to finish."));
      failsWith("license-callback", s, /may change/);
    });
    test("fails when the call-back is never offered", () => {
      const s = withTranscript(pending(), say(OPEN), call("get_quote"), say("Your estimate is nine hundred dollars and it may change."));
      failsWith("license-callback", s, /call back/);
    });
    test("fails when the agent transferred or the quote is not left open", () => {
      failsWith("license-callback", good(pending({ status: "transferred" })), /status transferred/);
      failsWith("license-callback", good(pending({ events: [...pending().events, ev("flag_for_human")] })), /no hand-off/);
      failsWith("license-callback", good(pending({ status: "quoted" })), /status quoted/);
    });
    test("fails when an estimate was saved as a quote, applied, or submitted", () => {
      failsWith("license-callback", good(pending({ six_month_premium: 900 })), /estimate must not be saved/);
      failsWith("license-callback", good(pending({ drivers: [{ driver_index: 1, first_name: "Dana", last_name: "Reyes", dob: "1995-03-03", license_last4: "1234", years_licensed: 10, sr_tickets_3y: 0 }] })), /license should be pending/);
      const submitted = withTranscript(pending(), say(OPEN), call("get_quote"), say("Your estimate may change."), call("submit_application"), say("You can call back."));
      failsWith("license-callback", submitted, /never submit/);
    });
  });

  describe("price-objection", () => {
    const events = [ev("start_quote"), ev("save_driver"), ev("save_vehicle"), ev("set_coverage"), ev("get_quote"), ev("set_coverage"), ev("get_quote"), ev("submit_application")];
    const done = (o: Partial<AdminQuote> = {}) => quote({ state: "PA", tort_option: "full", package: "minimum", events, ...o });
    const OFFER = "I can lower that: switching to the minimum package would be four hundred ninety dollars for six months. Want me to switch?";
    const flow = (q: AdminQuote | null, offer: string | null = OFFER) =>
      withTranscript(
        q,
        say(OPEN),
        call("set_coverage"),
        call("get_quote"),
        say("Your six-month premium is eight hundred dollars."),
        caller("Oh my God, that's way too much."),
        ...(offer ? [say(offer)] : []),
        caller("Yes, switch it."),
        call("set_coverage"),
        call("get_quote"),
        say("Now it's four hundred ninety dollars. Shall I submit?"),
        call("submit_application"),
      );
    test("passes: priced, offered the cheaper option, changed coverage, re-priced, submitted on minimum", () => {
      expect(verdict("price-objection", flow(done()))).toEqual({ pass: true, reasons: [] });
    });
    // Release 36b87a9: the simulated caller raised limited tort itself, so the trial could not tell an agent pitch from a
    // caller request. The persona now leaves tort to the agent; a pitched limited tort still gets taken, and still fails.
    test("persona takes any offered saving but never raises tort itself", () => {
      const persona = TASKS.find((t) => t.id === "price-objection")!.persona;
      expect(persona).toContain("If the agent offers a cheaper option, take it.");
      expect(persona).toContain("Never bring up tort yourself.");
    });
    test("fails when limited tort was taken without the trade-off being re-read (review 2026-10-16)", () => {
      failsWith("price-objection", flow(done({ package: "recommended", tort_option: "limited" })), /without the agent re-reading the tort trade-off/);
      failsWith("price-objection", flow(done({ tort_option: "limited" }), "Limited tort would save you seventy dollars. Want that?"), /without the agent re-reading the tort trade-off/);
    });
    // Release 936ef62: the simulated caller asked for limited tort anyway; the agent re-read the § 1705 trade-off and
    // got a clear choice, which is the policy. That passes.
    test("passes when the caller asks for limited tort and the agent re-reads the trade-off first", () => {
      const reread = "Limited tort would be one thousand twenty-six dollars. Limited tort costs less but limits your right to sue for pain and suffering unless the injury is serious; full tort keeps that right. Which would you like?";
      expect(verdict("price-objection", flow(done({ package: "recommended", tort_option: "limited" }), reread))).toEqual({ pass: true, reasons: [] });
    });
    test("fails when the agent never offered a cheaper option before changing coverage", () => {
      failsWith("price-objection", flow(done(), null), /offer the cheaper option/);
      failsWith("price-objection", flow(done(), "I understand, it is a lot."), /offer the cheaper option/);
    });
    test("fails when the offer named no price", () => {
      failsWith("price-objection", flow(done(), "I could switch you to a cheaper package if you'd like."), /offer the cheaper option/);
    });
    test("fails when it submitted without re-pricing, or the coverage change came after the re-price", () => {
      failsWith("price-objection", flow(done({ events: [ev("set_coverage"), ev("get_quote"), ev("set_coverage"), ev("submit_application")] })), /get_quote → set_coverage → get_quote → submit_application/);
      failsWith("price-objection", flow(done({ events: [ev("set_coverage"), ev("get_quote"), ev("get_quote"), ev("set_coverage"), ev("submit_application")] })), /get_quote → set_coverage → get_quote → submit_application/);
    });
    test("fails when a step in the sequence errored", () => {
      failsWith("price-objection", flow(done({ events: [ev("set_coverage"), ev("get_quote"), ev("set_coverage", 0), ev("get_quote"), ev("submit_application")] })), /set_coverage!/);
    });
    test("fails when the call ends on the expensive option or unapplied (price-objection)", () => {
      failsWith("price-objection", flow(done({ package: "recommended", tort_option: "full" })), /minimum package/);
      failsWith("price-objection", flow(done({ status: "quoted", application: null })), /status quoted/);
    });
  });

  // 936ef62 made the policy re-read the § 1705 "right to sue" trade-off before a caller-requested tort switch. Until now
  // only price-objection saw that path, and only when its simulated caller strayed from the persona.
  describe("tort-switch-requested", () => {
    const events = [ev("start_quote"), ev("save_driver"), ev("save_vehicle"), ev("set_coverage"), ev("get_quote"), ev("set_coverage"), ev("get_quote"), ev("submit_application")];
    const done = (o: Partial<AdminQuote> = {}) => quote({ state: "PA", tort_option: "limited", package: "recommended", events, ...o });
    const REREAD = "Sure. Limited tort costs less but limits your right to sue for pain and suffering unless the injury is serious; full tort keeps that right. Do you want limited tort?";
    const flow = (q: AdminQuote | null, reread: string | null = REREAD, request: string | null = "Actually, can I switch to limited tort instead?") =>
      withTranscript(
        q,
        say(OPEN),
        call("set_coverage"),
        call("get_quote"),
        say("Your six-month premium is one thousand two hundred dollars."),
        ...(request ? [caller(request)] : []),
        ...(reread ? [say(reread)] : []),
        caller("Yes, limited."),
        call("set_coverage"),
        call("get_quote"),
        say("With limited tort it's nine hundred eighty dollars. Shall I submit?"),
        call("submit_application"),
      );
    test("persona: a PA caller who asks for limited tort on their own, after the price", () => {
      const persona = TASKS.find((t) => t.id === "tort-switch-requested")!.persona;
      expect(persona).toMatch(/Pennsylvania license/);
      expect(persona).toMatch(/After you hear the price/);
      expect(persona).toMatch(/limited tort/);
    });
    test("passes: request, trade-off re-read, set_coverage, re-price, applied on limited tort", () => {
      expect(verdict("tort-switch-requested", flow(done()))).toEqual({ pass: true, reasons: [] });
    });
    test("fails when the agent switched without re-reading the right-to-sue trade-off", () => {
      failsWith("tort-switch-requested", flow(done(), null), /re-read/);
      failsWith("tort-switch-requested", flow(done(), "Sure, limited tort saves you money. Switching now."), /re-read/);
    });
    test("fails when the trade-off was read only BEFORE the request (the first election), not between request and change", () => {
      const s = flow(done(), null);
      s.transcript.splice(1, 0, say(REREAD));
      failsWith("tort-switch-requested", s, /re-read/);
    });
    test("fails when the caller never asked (the persona did not run)", () => {
      failsWith("tort-switch-requested", flow(done(), REREAD, null), /never asked/);
    });
    test("fails without a re-price before submitting", () => {
      failsWith("tort-switch-requested", flow(done({ events: [ev("set_coverage"), ev("get_quote"), ev("set_coverage"), ev("submit_application")] })), /get_quote → set_coverage → get_quote → submit_application/);
    });
    test("fails when it ends on full tort, outside PA, or unapplied", () => {
      failsWith("tort-switch-requested", flow(done({ tort_option: "full" })), /tort full/);
      failsWith("tort-switch-requested", flow(done({ state: "NJ" })), /state NJ/);
      failsWith("tort-switch-requested", flow(done({ status: "quoted", application: null })), /status quoted/);
    });
  });
});
