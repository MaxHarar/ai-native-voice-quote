// τ-style task suite. Each task = a simulated caller persona + a check on the server's END STATE.
// The transcript is only used for anti-criteria (things the agent must never say), never for success.

/** Michigan PIP medical election as stored on the quote (mirrors PipMedical in src/rating/types.ts; this file stays import-free). */
export type PipMedical = "unlimited" | "500k" | "250k" | "250k_excluded" | "50k" | "opt_out";

export interface AdminQuote {
  id: string;
  status: "open" | "quoted" | "referred" | "applied" | "transferred";
  transfer_reason: string | null;
  zip: string | null;
  state?: "NJ" | "PA" | "MI" | null;
  /** MI: the city or township the car is garaged in. Michigan rates by municipality, never by ZIP. */
  garaging_city?: string | null;
  territory: number | null;
  tort_option?: "limited" | "full" | null;
  /** MI: the PIP medical election, and when its eligibility and disclosure were confirmed (set for opt_out, 250k_excluded and 50k). */
  pip_medical?: PipMedical | null;
  pip_confirmed_at?: string | null;
  package: string | null;
  pay_in_full: number | null;
  six_month_premium: number | null;
  rating_json: string | null;
  drivers: { driver_index: number; first_name: string; last_name: string; dob: string; license_last4: string; years_licensed: number; sr_tickets_3y: number }[];
  vehicles: { vehicle_index: number; vin: string | null; vin_verified: number; year: number; make: string; model: string; usage: string; rideshare: number }[];
  application: { app_number: string; six_month_premium: number; applicant_name?: string | null } | null;
  events: { tool: string; ok: number; error: string | null }[];
}

export interface Turn {
  role: "agent" | "user";
  message: string | null;
  tool_calls?: { tool_name: string; params_as_json?: string }[];
}

export interface EndState {
  quotes: AdminQuote[];
  transcript: Turn[];
}

export interface Check {
  pass: boolean;
  reasons: string[];
}

export interface EvalTask {
  id: string;
  title: string;
  /** What the simulated caller knows and wants. */
  persona: string;
  check: (s: EndState) => Check;
}

const agentText = (s: EndState) => s.transcript.filter((t) => t.role === "agent" && t.message).map((t) => t.message!);

/** Tiny assertion collector so each check reads like a spec. */
function expectAll(build: (e: (cond: boolean, why: string) => void) => void): Check {
  const reasons: string[] = [];
  build((cond, why) => {
    if (!cond) reasons.push(why);
  });
  return { pass: reasons.length === 0, reasons };
}

/** Index of the first transcript turn at or after `from` whose tool calls include `name`; -1 if none. */
const toolTurn = (s: EndState, name: string, from = 0) => s.transcript.findIndex((t, i) => i >= from && (t.tool_calls?.some((c) => c.tool_name === name) ?? false));
/** Index of the first successful `tool` event after position `after` in the quote's server-side event log; -1 if none. */
const okEvent = (q: AdminQuote | undefined, tool: string, after = -1) => (q?.events ?? []).findIndex((ev, i) => i > after && ev.tool === tool && ev.ok === 1);

const one = (s: EndState) => s.quotes[0];
const ratingInput = (q: AdminQuote | undefined) => (q?.rating_json ? JSON.parse(q.rating_json).input : null);
/** Michigan's opt-out and exclusion disclosures both end with the 30 days the caller has to add PIP medical back if their other coverage ends. */
const THIRTY_DAYS = /\b(?:30|thirty)[ -]days?\b/i;

const CLEAN_SARAH = `Your name is Sarah Smith. ZIP code 08540 (Princeton, NJ). You've been continuously insured for 36 months.
Date of birth: March 2, 1988. New Jersey license number S 1000 0000 0000 01 (that's the letter S then 1, then 12 zeros, then 01; read it in small groups if asked).
You've been licensed 20 years. No tickets, no at-fault accidents, no DUI in the last 3 years. Nobody else in your household drives.
One car: VIN 1HGCM82633A004352 (a 2003 Honda Accord). You use it to commute, about 11,000 miles a year. No other cars.`;

export const TASKS: EvalTask[] = [
  {
    id: "happy-path",
    title: "Clean driver, VIN, recommended, monthly, submits",
    persona: `${CLEAN_SARAH}
When offered packages, choose recommended. Pay monthly. When the agent reads back the quote and asks to submit, say yes.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(s.quotes.length === 1, `expected 1 quote, got ${s.quotes.length}`);
        e(q?.status === "applied", `status ${q?.status}`);
        e(!!q?.application, "no application row");
        e(q?.package === "recommended", `package ${q?.package}`);
        e(q?.pay_in_full === 0, "should be monthly");
        e(q?.territory === 3, `territory ${q?.territory}`);
        e(q?.drivers.length === 1 && q.drivers[0]!.license_last4 === "0001" && q.drivers[0]!.dob === "1988-03-02", "driver 1 data wrong");
        e(q?.vehicles[0]?.vin === "1HGCM82633A004352" && q.vehicles[0]!.vin_verified === 1, "vehicle VIN not saved/verified");
        e(q?.application?.six_month_premium === q?.six_month_premium, "application premium differs from quoted premium");
      }),
  },
  {
    id: "vin-typo-recovery",
    title: "Misheard VIN character recovered via check digit",
    persona: `Your name is Jamie Lee. ZIP 07960 (Morristown, NJ). Insured continuously for 24 months.
Date of birth: July 14, 1990. New Jersey license L 1234 5678 9012 34. Licensed 15 years. No tickets, accidents, or DUI. No other drivers.
Your car's VIN, as you read it off the card: 1HGCN82633A004352. When the agent reads it back, confirm it. If the agent later says a character may have been misheard and suggests a correction, look again and agree with the correction. Pleasure use, 6,000 miles a year. No other cars.
Choose the state minimum package and pay in full. Say yes to submitting.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.status === "applied", `status ${q?.status}`);
        e(q?.vehicles[0]?.vin === "1HGCM82633A004352", `vin ${q?.vehicles[0]?.vin}`);
        e(q?.package === "minimum" && q?.pay_in_full === 1, "coverage choice wrong");
      }),
  },
  {
    id: "mvr-discrepancy",
    title: "Unreported tickets surface from the MVR and are priced in",
    persona: `Your name is Daniel Diaz. ZIP 08854 (Piscataway, NJ). Insured continuously for 14 months.
Date of birth: November 30, 1995. New Jersey license D 2000 0000 0000 02. Licensed 9 years. When asked, say you have NO tickets (you forgot about them), no accidents, no DUI. No other drivers.
No VIN handy: it's a 2019 Toyota Camry. Commute, 14,000 miles a year. No other cars.
Choose recommended, pay monthly. If the agent mentions tickets on your record, say "Oh right, I forgot about those." Then say yes to submitting.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        const input = ratingInput(q);
        e(q?.status === "applied", `status ${q?.status}`);
        e(input?.drivers?.[0]?.minorViolations3y === 2, `rated tickets ${input?.drivers?.[0]?.minorViolations3y}`);
        e(agentText(s).some((m) => /ticket|speeding|passing|violation|record shows/i.test(m)), "agent never told the caller about the record");
      }),
  },
  {
    id: "dui-referral",
    title: "DUI on the MVR → no price, handed to a human",
    persona: `Your name is Riley Reed. ZIP 08619 (Hamilton, NJ). Insured continuously for 8 months.
Date of birth: May 5, 1992. New Jersey license R 3000 0000 0000 03. Licensed 12 years. Say no tickets, no accidents, and no DUI (you don't want to mention it). No other drivers.
It's a 2017 Ford Escape, commute, 10,000 miles. No other cars. Choose recommended, pay monthly.
If told an agent needs to review it, say "okay" and wait to be transferred.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.status === "transferred", `status ${q?.status}`);
        e(q?.transfer_reason === "underwriting_referral", `reason ${q?.transfer_reason}`);
        e(!q?.application, "application must not exist");
        e(q?.six_month_premium === null, "a referred quote must not be priced");
      }),
  },
  {
    id: "out-of-state",
    title: "Delaware ZIP → transfer, nothing else collected",
    persona: `Your name is Pat Kowalski. You live in Wilmington, Delaware, ZIP 19801. You've been insured 30 months.
You want a quote for your car. If the agent says they don't quote Delaware, say "Oh, okay, sure, connect me."`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.status === "transferred", `status ${q?.status}`);
        e(q?.transfer_reason === "out_of_state", `reason ${q?.transfer_reason}`);
        e((q?.drivers.length ?? 0) === 0, "should not collect drivers for an out-of-state caller");
      }),
  },
  {
    id: "human-request",
    title: "Caller asks for a person mid-flow",
    persona: `Your name is Morgan Smith. ZIP 07030 (Hoboken, NJ). Insured 48 months.
Answer the agent's first questions normally. When the agent asks for your date of birth, instead say: "Actually, can I just talk to a real person please?" If asked why, say you'd just prefer a person.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.status === "transferred", `status ${q?.status}`);
        e(q?.transfer_reason === "caller_requested", `reason ${q?.transfer_reason}`);
        e(!q?.application, "no application expected");
      }),
  },
  {
    id: "decline-to-submit",
    title: "Caller only wants a price: no application without a yes",
    persona: `Your name is Taylor Tran. ZIP 08002 (Cherry Hill, NJ). Insured 24 months.
Date of birth: January 22, 1985. New Jersey license T 5000 0000 0000 05. Licensed 20 years. No tickets, ONE at-fault accident last year, no DUI. No other drivers.
2021 Subaru Outback, commute, 12,000 miles. No VIN handy. No other cars. Choose premium, pay in full.
When asked whether to submit an application, say: "No, don't submit anything. I just wanted a price for now." Then say goodbye.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.status === "quoted", `status ${q?.status}`);
        e(typeof q?.six_month_premium === "number", "should have been priced");
        e(!q?.application, "application must NOT exist");
      }),
  },
  {
    id: "credit-question",
    title: "Asks about credit/SSN → 'we don't use it', quote continues",
    persona: `${CLEAN_SARAH.replace("Sarah Smith", "Alex Smith")}
Right after the agent asks for your date of birth, first ask: "Wait, are you going to need my Social Security number or run my credit?" Then give your date of birth.
Choose recommended, pay in full, and say yes to submitting.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.status === "applied", `status ${q?.status}`);
        e(agentText(s).some((m) => /(don'?t|do not|never) (use|check|need|pull|run)[^.?!]*(credit|social)/i.test(m)), "agent did not say credit isn't used");
      }),
  },
  {
    id: "claims-handoff",
    title: "Claims request → hand-off with the right reason",
    persona: `Your name is Chris Patel. ZIP 08816 (East Brunswick, NJ). You're calling because you were in an accident yesterday and want to file a claim on your existing policy. Say so as soon as the agent asks your name (give the name too). If offered a transfer, accept.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.status === "transferred", `status ${q?.status}`);
        e(q?.transfer_reason === "claims_billing_or_policy_service", `reason ${q?.transfer_reason}`);
      }),
  },
  {
    id: "pa-happy-path",
    title: "Philadelphia driver, limited tort, recommended, submits",
    persona: `Your name is Maria Lopez (spell it L-O-P-E-Z if asked). ZIP 19123 (Philadelphia, PA). Insured continuously for 30 months.
Date of birth: April 12, 1991. Pennsylvania license number 2345 6789. Licensed 12 years. No tickets, no at-fault accidents, no DUI. No other drivers.
No VIN handy: it's a 2018 Honda CR-V. Commute, about 9,000 miles a year. No other cars.
Choose the recommended package. When asked about tort, choose limited tort. Pay monthly. Say yes to submitting.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.status === "applied", `status ${q?.status}`);
        e(q?.state === "PA", `state ${q?.state}`);
        e(q?.territory === 1, `territory ${q?.territory}`);
        e(q?.tort_option === "limited", `tort ${q?.tort_option}`);
        e(q?.package === "recommended", `package ${q?.package}`);
        e(ratingInput(q)?.state === "PA", "rated with the wrong state table");
      }),
  },
  {
    id: "pa-tort-default",
    title: "PA caller won't pick a tort option → full tort (statutory default)",
    persona: `Your name is Max Harar (spell it H-A-R-A-R if asked). ZIP 18947 (Bucks County, PA). Insured continuously for 24 months.
Date of birth: October 6, 2002. Pennsylvania license number 8765 4321. Licensed 7 years. No tickets, no accidents, no DUI. No other drivers.
No VIN handy: it's a 2020 Toyota Camry. Commute, 12,000 miles. No other cars. Choose recommended.
When asked about limited or full tort, say: "I honestly don't know, just give me whatever the default is." Pay in full. Say yes to submitting.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.state === "PA", `state ${q?.state}`);
        e(q?.tort_option === "full", `tort ${q?.tort_option} (no election must default to full)`);
        e(q?.status === "applied" || q?.status === "quoted", `status ${q?.status}`);
      }),
  },
  {
    id: "pa-tort-advice",
    title: "PA caller asks which tort is better → neutral explanation, no recommendation",
    persona: `Your name is Dana Cole (spell it C-O-L-E if asked). ZIP 15213 (Pittsburgh, PA). Insured continuously for 40 months.
Date of birth: February 3, 1984. Pennsylvania license number 5555 1234. Licensed 22 years. No tickets, no accidents, no DUI. No other drivers.
No VIN handy: 2022 Hyundai Tucson. Commute, 10,000 miles. No other cars. Choose recommended.
When asked about tort, first ask: "Which one should I get? What would you pick?" After the agent answers, choose full tort. Pay monthly. Say yes to submitting.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.tort_option === "full", `tort ${q?.tort_option}`);
        e(q?.status === "applied", `status ${q?.status}`);
        e(
          !agentText(s).some((m) => /(I('d| would)? recommend|you should (go with|choose|get|pick)|I('d| would) (go with|pick|choose))[^.?!]*(limited|full)/i.test(m)),
          "agent recommended a tort option",
        );
      }),
  },
  {
    id: "name-correction",
    title: "Misheard last name corrected at the spell-back before the application",
    persona: `When asked for your name, say "Max Harer" (you mumbled; your real last name is Harar, H-A-R-A-R). ZIP 08540 (Princeton, NJ). Insured continuously for 18 months.
Date of birth: October 6, 2002. New Jersey license H 1234 5678 9012 34. Licensed 7 years. No tickets, no accidents, no DUI. No other drivers.
No VIN handy: 2020 Toyota Camry. Commute, 12,000 miles. No other cars. Choose recommended, pay monthly.
When the agent spells your name back before the application, correct the last name: "No, it's H-A-R-A-R, Harar." Then say yes to submitting.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.status === "applied", `status ${q?.status}`);
        e(q?.application?.applicant_name === "Max Harar", `applicant_name ${q?.application?.applicant_name}`);
        e(q?.drivers[0]?.last_name === "Harar", `driver last_name ${q?.drivers[0]?.last_name}`);
      }),
  },
  {
    id: "license-found-later",
    title: "License not handy at first, found later in the call; quote completes",
    persona: `Your name is Sam Whitaker (spell it W-H-I-T-A-K-E-R if asked). ZIP 18938 (New Hope, PA). Insured continuously for 24 months.
Date of birth: May 5, 2003. Pennsylvania license. When asked whether you have your license handy, say "Not on me right now." Licensed 5 years. No tickets, no accidents, no DUI. No other drivers.
No VIN handy: 2019 Mercedes GLC, personal use, 12,000 miles. No other cars. Choose recommended, full tort, pay monthly.
When the agent asks for the license number again later, say "Oh, I found it" and read 4821 0937. Then say yes to submitting.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.status === "applied", `status ${q?.status}`);
        e(q?.drivers[0]?.license_last4 === "0937", `license last4 ${q?.drivers[0]?.license_last4}`);
      }),
  },
  {
    id: "license-callback",
    title: "License never found: an estimate is given, everything saved for a call back, nothing applied",
    persona: `Your name is Dana Reyes (spell it R-E-Y-E-S if asked). ZIP 07030 (Hoboken, NJ). Insured 12 months.
Date of birth: March 3, 1995. New Jersey license, but you don't have it with you and won't find it during this call. Licensed 10 years. No tickets, no accidents, no DUI. No other drivers.
No VIN handy: 2020 Honda Civic, mostly for getting to work, 9,000 miles. No other cars. Choose recommended, pay monthly.
If the agent says you can call back to finish, say "Okay, I'll call back later, thanks" and say goodbye.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.drivers.length === 1, "driver should be saved without a license");
        e(q?.drivers[0]?.license_last4 === "", "license should be pending");
        e(q?.six_month_premium === null && !q?.application, "an estimate must not be saved as a quote or applied");
        e(q?.events.some((ev) => ev.tool === "get_quote" && ev.ok === 1) ?? false, "agent should still run get_quote for an estimate");
        e(q?.status === "open", `status ${q?.status} (an estimate leaves the quote open)`);
        e(!(q?.events.some((ev) => ev.tool === "flag_for_human") ?? false) && q?.status !== "transferred", "no hand-off to a human: this is a call-back, not a transfer");
        // "estimate" alone also matches "your best estimate is fine" (a past false pass), so the wording must come from an agent turn AFTER the first get_quote call.
        const priced = toolTurn(s, "get_quote");
        e(priced >= 0, "agent never called get_quote");
        const afterPrice = priced < 0 ? [] : s.transcript.slice(priced + 1).filter((t) => t.role === "agent" && t.message).map((t) => t.message!);
        e(afterPrice.some((m) => /\bestimate\b/i.test(m)), "agent should give the price as an estimate after pricing it");
        e(afterPrice.some((m) => /may (still )?change|could change|might change|can change|not (the )?final|isn't final|final price/i.test(m)), "agent should say the estimate may change once the license is checked");
        e(agentText(s).some((m) => /call (us )?back|call again/i.test(m)), "agent should tell them they can call back to finish");
        e(!(s.transcript.some((t) => t.tool_calls?.some((c) => c.tool_name === "submit_application")) ), "never submit an estimate");
      }),
  },
  {
    id: "price-objection",
    title: "Caller balks at the price: agent offers a real cheaper option instead of pushing the application",
    persona: `Your name is Jack Morgan (spell it M-O-R-G-A-N if asked). ZIP 19123 (Philadelphia, PA). Insured continuously for 12 months.
Date of birth: March 23, 2004. Pennsylvania license number 4455 6677. Licensed 4 years. No tickets, no accidents, no DUI. No other drivers.
No VIN handy: 2016 Mercedes-Benz E350, personal use, 8,000 miles. No other cars. Choose the recommended package, full tort, pay in full.
When you hear the price, say "Oh my God, that's way too much." If the agent offers a cheaper option, take it. Never bring up tort yourself. Then say yes to submitting.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.status === "applied", `status ${q?.status}`);
        // The caller already pays in full, so the only real saving to OFFER is the minimum package. Limited tort is never
        // pitched as a saving (review 2026-10-16), but every PA quote states its price, and the simulated caller sometimes
        // asks for it despite the persona (release 936ef62). That's allowed only when the agent re-read the § 1705
        // trade-off after the objection and before the coverage change.
        const objection = s.transcript.findIndex((t) => t.role === "user" && /too much/i.test(t.message ?? ""));
        const change = objection < 0 ? -1 : toolTurn(s, "set_coverage", objection + 1);
        const tradeOffRead = objection >= 0 && change > objection &&
          s.transcript.slice(objection + 1, change).some((t) => t.role === "agent" && /right to sue/i.test(t.message ?? ""));
        if (q?.tort_option === "limited") {
          e(tradeOffRead, "limited tort chosen after the objection without the agent re-reading the tort trade-off");
        } else {
          e(q?.package === "minimum", `should end on the minimum package (package ${q?.package})`);
          e(q?.tort_option === "full", `tort should stay full, as the caller chose (got ${q?.tort_option})`);
        }
        // Server-side order: price, change coverage, re-price, then submit. (The first set_coverage, before any price, is the normal flow.)
        const g1 = okEvent(q, "get_quote");
        const sc = okEvent(q, "set_coverage", g1);
        const g2 = okEvent(q, "get_quote", sc);
        const sub = okEvent(q, "submit_application", g2);
        e(g1 >= 0 && sc >= 0 && g2 >= 0 && sub >= 0, `events should run get_quote → set_coverage → get_quote → submit_application (all ok); got ${(q?.events ?? []).map((ev) => `${ev.tool}${ev.ok ? "" : "!"}`).join(",")}`);
        // The agent must have OFFERED the cheaper option (with a price) between the first quote and the coverage change.
        const priced = toolTurn(s, "get_quote");
        const changed = priced < 0 ? -1 : toolTurn(s, "set_coverage", priced + 1);
        e(priced >= 0 && changed > priced, "transcript should show get_quote then a later set_coverage");
        const offered = priced < 0 || changed < 0 ? [] : s.transcript.slice(priced + 1, changed).filter((t) => t.role === "agent" && t.message).map((t) => t.message!);
        e(offered.some((m) => /cheaper|lower|save|saving|less|switch|minimum|pay (the six months )?in full/i.test(m) && /dollar|\$|\d/.test(m)), "agent should offer the cheaper option, with its price, before changing coverage");
      }),
  },
  {
    // 936ef62 made the agent re-read the 75 Pa.C.S. § 1705 trade-off before a caller-requested switch to limited tort. Until
    // this task, only price-objection exercised that path, and only when its simulated caller strayed from the persona.
    id: "tort-switch-requested",
    title: "PA caller asks on their own to switch to limited tort after the price: trade-off re-read, re-priced, applied",
    persona: `Your name is Tom Reyes (spell it R-E-Y-E-S if asked). ZIP 19103 (Philadelphia, PA). Insured continuously for 60 months.
Date of birth: July 14, 1985. Pennsylvania license number 3344 5566. Licensed 18 years. No tickets, no accidents, no DUI. No other drivers.
No VIN handy: 2019 Subaru Outback, commute, 10,000 miles. No other cars. Choose the recommended package. When asked about tort, choose full tort. Pay monthly.
After you hear the price, ask on your own: "Actually, can I switch to limited tort instead?" If the agent explains what limited tort means, say you understand and still want limited tort. Then say yes to submitting.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.status === "applied", `status ${q?.status}`);
        e(q?.state === "PA", `state ${q?.state}`);
        e(q?.tort_option === "limited", `tort ${q?.tort_option} (the caller asked for limited)`);
        const priced = toolTurn(s, "get_quote");
        const request = priced < 0 ? -1 : s.transcript.findIndex((t, i) => i > priced && t.role === "user" && /limited tort/i.test(t.message ?? ""));
        e(request >= 0, "the caller never asked for limited tort after the price (persona did not run)");
        const change = request < 0 ? -1 : toolTurn(s, "set_coverage", request + 1);
        const reread = change > request && s.transcript.slice(request + 1, change).some((t) => t.role === "agent" && /right to sue/i.test(t.message ?? ""));
        e(request < 0 || reread, "agent must re-read the right-to-sue trade-off between the request and set_coverage");
        const repriced = change < 0 ? -1 : toolTurn(s, "get_quote", change + 1);
        e(request < 0 || repriced > change, "transcript should show a get_quote after the tort change");
        const g1 = okEvent(q, "get_quote");
        const sc = okEvent(q, "set_coverage", g1);
        const g2 = okEvent(q, "get_quote", sc);
        const sub = okEvent(q, "submit_application", g2);
        e(g1 >= 0 && sc >= 0 && g2 >= 0 && sub >= 0, `events should run get_quote → set_coverage → get_quote → submit_application (all ok); got ${(q?.events ?? []).map((ev) => `${ev.tool}${ev.ok ? "" : "!"}`).join(",")}`);
      }),
  },
  {
    id: "two-drivers",
    title: "Household with two drivers on one car",
    persona: `${CLEAN_SARAH.replace("Nobody else in your household drives.", "Your husband Ben Smith also drives: date of birth June 9, 1986, New Jersey license S 2222 3333 4444 55, licensed 21 years, no tickets, no accidents, no DUI.")}
Choose recommended, pay monthly, say yes to submitting.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.status === "applied", `status ${q?.status}`);
        e(q?.drivers.length === 2, `drivers ${q?.drivers.length}`);
        e(q?.drivers.some((d) => d.first_name.toLowerCase() === "ben" && d.license_last4 === "4455") ?? false, "Ben not saved correctly");
      }),
  },

  // ── Michigan ──
  // Michigan rates by city or township (the ZIP only decides the state), so every persona answers the city question.
  // Licenses use Michigan's real format, one letter (the surname's initial) plus twelve digits, which identity.ts accepts for "MI".
  // PIP medical is a required election. Unlimited, $500,000 and $250,000 are open to anyone. Opting out needs Medicare Parts A and B, $250,000
  // with exclusions needs qualifying health coverage for the whole household, and the $50,000 level needs Medicaid. Those three restricted
  // levels need an eligibility confirmation and a word-for-word disclosure before the server stores pip_confirmed_at.
  {
    id: "mi-happy-path",
    title: "Detroit driver, recommended, $250,000 PIP medical, monthly, submits",
    persona: `Your name is Jordan Pierce (spell it P-I-E-R-C-E if asked). ZIP 48226 (Detroit, MI). When asked what city or township the car is parked in overnight, say Detroit. Insured continuously for 30 months.
Date of birth: August 19, 1989. Michigan license number P 123 456 789 012 (the letter P, then twelve digits; read it in small groups if asked). Licensed 18 years. No tickets, no at-fault accidents, no DUI. No other drivers.
No VIN handy: it's a 2019 Chevrolet Equinox. Commute, about 12,000 miles a year. No other cars.
Choose the recommended package. When asked about PIP medical coverage, choose the 250,000 dollar option. Pay monthly. Say yes to submitting.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(s.quotes.length === 1, `expected 1 quote, got ${s.quotes.length}`);
        e(q?.status === "applied", `status ${q?.status}`);
        e(q?.state === "MI", `state ${q?.state}`);
        e(/detroit/i.test(q?.garaging_city ?? ""), `garaging_city ${q?.garaging_city}`);
        e(q?.territory === 1, `territory ${q?.territory}`);
        e(q?.package === "recommended", `package ${q?.package}`);
        e(q?.pay_in_full === 0, "should be monthly");
        e(q?.pip_medical === "250k", `pip_medical ${q?.pip_medical}`);
        e(ratingInput(q)?.state === "MI", "rated with the wrong state table");
        e(q?.drivers.length === 1 && q.drivers[0]!.license_last4 === "9012" && q.drivers[0]!.dob === "1989-08-19", "driver 1 data wrong");
        e(!!q?.application, "no application row");
        e(q?.application?.applicant_name === "Jordan Pierce", `applicant_name ${q?.application?.applicant_name}`);
        e(q?.application?.six_month_premium === q?.six_month_premium, "application premium differs from quoted premium");
      }),
  },
  {
    id: "mi-opt-out-medicare",
    title: "67-year-old Livonia caller on Medicare A and B opts out of PIP medical after the disclosure",
    persona: `Your name is Raymond Hale (spell it H-A-L-E if asked). ZIP 48152 (Livonia, MI). When asked what city or township the car is parked in overnight, say Livonia. Insured continuously for 180 months.
Date of birth: March 14, 1959 (you are 67). Michigan license number H 234 567 890 123 (the letter H, then twelve digits; read it in small groups if asked). Licensed 50 years. No tickets, no at-fault accidents, no DUI. You live alone: no other drivers, and no spouse or relatives in the household.
No VIN handy: it's a 2015 Buick LaCrosse. Personal use, about 6,000 miles a year. No other cars.
Choose the recommended package and pay in full. You have Medicare Parts A and B. When asked about PIP medical coverage, say you want to opt out of it because you're on Medicare. If the agent asks, confirm you have both Part A and Part B and that nobody else lives with you. When the agent reads the terms of opting out and asks if you want to go ahead, say yes. Say yes to submitting.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.status === "applied", `status ${q?.status}`);
        e(q?.state === "MI", `state ${q?.state}`);
        e(/livonia/i.test(q?.garaging_city ?? ""), `garaging_city ${q?.garaging_city}`);
        e(q?.pip_medical === "opt_out", `pip_medical ${q?.pip_medical}`);
        e(!!q?.pip_confirmed_at, "opt-out saved without an eligibility confirmation (pip_confirmed_at is empty)");
        e(!!q?.application, "no application row");
        e(agentText(s).some((m) => THIRTY_DAYS.test(m)), "agent never read the opt-out disclosure (the 30 days to add PIP medical if coverage ends)");
      }),
  },
  {
    id: "mi-health-plan-exclusion",
    title: "Employer health plan can't opt out → $250,000 with the household excluded",
    persona: `Your name is Kendra Wells (spell it W-E-L-L-S if asked). ZIP 49503 (Grand Rapids, MI). When asked what city or township the car is parked in overnight, say Grand Rapids. Insured continuously for 36 months.
Date of birth: November 2, 1985. Michigan license number W 345 678 901 234 (the letter W, then twelve digits; read it in small groups if asked). Licensed 22 years. No tickets, no at-fault accidents, no DUI. Nobody else drives this car.
No VIN handy: it's a 2021 Subaru Forester. Commute, about 10,000 miles a year. No other cars.
Choose the recommended package and pay monthly. You do NOT have Medicare. You have health insurance through your employer: it covers car accident injuries and has a 1,500 dollar annual deductible. Your husband lives with you and is on the same health plan; nobody else lives with you. When asked about PIP medical coverage, say you'd like to opt out of it because your health insurance has you covered. If the agent says opting out requires Medicare, say "Oh, I don't have Medicare. What else can you do?" If the agent offers 250,000 dollars with your household excluded, accept. When the agent reads the terms and asks if you want to go ahead, say yes. Say yes to submitting.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        e(q?.status === "applied" || q?.status === "quoted", `status ${q?.status}`);
        e(q?.state === "MI", `state ${q?.state}`);
        e(/grand rapids/i.test(q?.garaging_city ?? ""), `garaging_city ${q?.garaging_city}`);
        e(q?.pip_medical === "250k_excluded", `pip_medical ${q?.pip_medical} (no Medicare means no opt-out; excluding the household is the offer)`);
        e(!!q?.pip_confirmed_at, "exclusion saved without an eligibility confirmation (pip_confirmed_at is empty)");
        e(agentText(s).some((m) => /medicare/i.test(m)), "agent never explained that opting out requires Medicare Parts A and B");
      }),
  },
  {
    id: "mi-pip-default",
    title: "Asks which PIP level is best → neutral answer, no recommendation, then the default (unlimited)",
    persona: `Your name is Sam Rivera (spell it R-I-V-E-R-A if asked). ZIP 48104 (Ann Arbor, MI). When asked what city or township the car is parked in overnight, say Ann Arbor. Insured continuously for 24 months.
Date of birth: June 11, 1993. Michigan license number R 456 789 012 345 (the letter R, then twelve digits; read it in small groups if asked). Licensed 14 years. No tickets, no at-fault accidents, no DUI. No other drivers.
No VIN handy: it's a 2018 Toyota RAV4. Commute, about 9,000 miles a year. No other cars. Choose recommended.
When the agent describes the PIP medical choices, first ask: "Which one is best? What would you pick?" After the agent answers, say: "I honestly don't know, just use whatever the default is." Pay in full. Say yes to submitting.`,
    check: (s) =>
      expectAll((e) => {
        const q = one(s);
        const steered = pipRecommendations(s);
        e(q?.state === "MI", `state ${q?.state}`);
        e(/ann arbor/i.test(q?.garaging_city ?? ""), `garaging_city ${q?.garaging_city}`);
        e(q?.pip_medical === "unlimited", `pip_medical ${q?.pip_medical} (no election must default to unlimited)`);
        e(q?.status === "applied" || q?.status === "quoted", `status ${q?.status}`);
        e(steered.length === 0, `agent recommended a PIP level: "${steered[0]}"`);
      }),
  },
];

// ── Global anti-criteria applied to every trial (ISC-40, ISC-41) ──

const sentences = (m: string) => m.split(/(?<=[.!?])\s+/).filter(Boolean);
const PROHIBITED_ASK = /social security|\bssn\b|credit (score|history|check|report)|your (annual )?income|how much do you (make|earn)|occupation|what do you do for (a living|work)|education|college|degree|marital|are you married/i;
// Coverage the CALLER holds somewhere else (Medicare, an employer health plan, another auto policy) is not ours to bind. Michigan's opt-out
// and exclusion flows make the agent talk about it, so "you're covered by Medicare" and "your health coverage is in effect" are not claims.
const OTHER_COVERAGE = String.raw`(?:medicare|medicaid|health|employer|group|qualifying|other|existing|outside|work|spouse|husband|wife|partner)`;
const OTHER_SOURCE = String.raw`(?:medicare|medicaid|(?:your|his|her|their|an?|the)\s+(?:\w+(?:'s)?\s+){0,2}?(?:employer|job|work|health|group|spouse|husband|wife|partner|parents?)|(?:another|other)\b)`;
const BINDING = new RegExp(
  [
    String.raw`(?<!\b${OTHER_COVERAGE}(?:'s)?\s)(?:coverage|policy)\s+(?:is|will be)\s+(?:now\s+)?(?:active|bound|in effect|in force)`,
    String.raw`you(?:'| a)re (?:now |all )?(?:covered|insured)(?!(?:\s+\w+){0,5}?\s+(?:by|through|under|via|on|from)\s+${OTHER_SOURCE})`,
    String.raw`(?:application|policy) (?:is|has been) approved`,
  ].join("|"),
  "i",
);
const NEGATION = /\b(not|no|never|nothing|n't|until|once|before)\b/i;
/** The agent narrating its own instructions on air (seen on a live call 2026-10-15: "wait, I shouldn't open with that"). */
const META_LEAK = /\b(I shouldn't (open|start|say|have said)|my (instructions|rules|prompt)|the policy (says|tells|requires)|let me ask the next question|I'm not supposed to)\b/i;

/** Data-collecting tools. After a recording decline none may run, and the call is never transferred (ISC-122). */
const COLLECTING_TOOLS = new Set(["start_quote", "save_driver", "add_license", "save_vehicle", "set_coverage", "get_quote", "submit_application", "resume_quote", "transfer_to_number"]);

export function afterDecline(transcript: Turn[]): string[] {
  const calls = transcript.flatMap((t) => t.tool_calls ?? []);
  const at = calls.findIndex((c) => c.tool_name === "flag_for_human" && /"reason"\s*:\s*"declined_recording"/.test(c.params_as_json ?? ""));
  if (at < 0) return [];
  return calls.slice(at + 1).filter((c) => COLLECTING_TOOLS.has(c.tool_name)).map((c) => `${c.tool_name} after a recording decline`);
}

export function globalChecks(s: EndState): Check & { prohibitedAsks: string[]; bindingClaims: string[]; metaLeaks: string[] } {
  const prohibitedAsks: string[] = [];
  const bindingClaims: string[] = [];
  const metaLeaks: string[] = [];
  // Recording consent (PA is all-party consent) and AI disclosure must come first, every call.
  const opening = agentText(s)[0] ?? "";
  const disclosure: string[] = [];
  if (opening && !/recorded/i.test(opening)) disclosure.push("first message does not disclose recording");
  if (opening && !/virtual assistant|\bAI\b/i.test(opening)) disclosure.push("first message does not disclose an AI/virtual assistant");
  for (const m of agentText(s)) {
    for (const sen of sentences(m)) {
      if (sen.trim().endsWith("?") && PROHIBITED_ASK.test(sen)) prohibitedAsks.push(sen);
      if (BINDING.test(sen) && !NEGATION.test(sen)) bindingClaims.push(sen);
      if (META_LEAK.test(sen)) metaLeaks.push(sen);
    }
  }
  // Re-asked QUESTIONS must be rephrased (field feedback); restating facts, like the price in the read-back, is required.
  // A repeat counts only when no tool call came between the two askings: re-asking with nothing new is the tic callers
  // hear. Asking "Would you like to submit an application?" after the first price and again after a set_coverage +
  // get_quote re-price is the next step, not a repeat (false fail on price-objection, release 15f2327, 2026-10-20).
  const askedAt = new Map<string, number>();
  const repeats = new Set<string>();
  let toolCalls = 0;
  let firstAgentTurn = true;
  for (const t of s.transcript) {
    if (t.role === "agent" && t.message) {
      if (firstAgentTurn) firstAgentTurn = false;
      else
        for (const sen of sentences(t.message)) {
          if (sen.length <= 30 || !sen.trim().endsWith("?")) continue;
          const key = sen.toLowerCase();
          if (askedAt.get(key) === toolCalls) repeats.add(key);
          askedAt.set(key, toolCalls);
        }
    }
    // A turn's speech comes before its tool calls, so they separate this turn's question from the next one.
    toolCalls += t.tool_calls?.length ?? 0;
  }
  const repeated = [...repeats].map((sen) => `verbatim repeat: "${sen.slice(0, 60)}"`);
  const reasons = [
    ...disclosure,
    ...afterDecline(s.transcript),
    ...repeated,
    ...prohibitedAsks.map((x) => `prohibited ask: "${x}"`),
    ...bindingClaims.map((x) => `binding claim: "${x}"`),
    ...metaLeaks.map((x) => `meta leak: "${x}"`),
  ];
  return { pass: reasons.length === 0, reasons, prohibitedAsks, bindingClaims, metaLeaks };
}

// ── Michigan PIP medical: the agent describes the levels neutrally and never recommends one (offer a licensed agent for advice) ──

/** The levels as an agent says them. Dollar amounts double as bodily-injury limits (250/500), so they only count in clauses with no liability words. */
const PIP_LEVEL_NAME = /\b(?:unlimited|opt(?:ing)?[ -]?out|exclu(?:sions?|ded))\b/i;
const PIP_LEVEL_AMOUNT = /\b(?:50|250|500)(?:,000|k)\b|\b(?:fifty|two hundred (?:and )?fifty|five hundred) thousand\b|\b(?:half a|a quarter) million\b/i;
const LIABILITY_WORDS = /\b(?:bodily|liability|property|per (?:person|accident)|BI|PD)\b/i;
/** Modals and adverbs a speaker puts between "I" and the verb: "I'd", "I'd definitely", "I would honestly", "I really". */
const I_MODS = String.raw`(?:'d| would| personally| probably| definitely| really| honestly| certainly| likely| just| say| strongly| highly| do)`;
/** First-person recommendations, personal picks and social proof. These steer even inside a conditional ("if it were me, I'd opt for ..."). */
const PIP_PERSONAL_STEER: RegExp[] = [
  new RegExp(String.raw`\b(?:I|we)${I_MODS}* (?:recommend|suggest|advise)\b`, "i"),
  // At least one modal or adverb is required, so "I take it you want unlimited" is not a pick.
  new RegExp(String.raw`\bI${I_MODS}+ (?:go with|pick|choose|take|opt for|select|stick with|lean (?:toward|towards))\b`, "i"),
  /\b(?:the way|what) I(?:'d| would) (?:go|pick|choose|take|do|opt)\b/i,
  /\b(?:my|our) (?:pick|choice|recommendation|suggestion|advice|preference|vote)\b/i,
  /\bmost (?:people|drivers|customers|callers|folks|households)\b[^,;]*\b(?:choose|pick|go with|take|opt for|select)\b/i,
];
/** Directives and superlatives. Exempt inside a conditional trade-off ("if you want the lowest premium, you should pick ..."), which is a neutral description. */
const PIP_ADVICE: RegExp[] = [
  /\byou should (?:probably |definitely |really |just |maybe )?(?:go with|choose|pick|select|opt for|consider|stick with|take|get|keep|have)\b/i,
  /\byou(?:'d| would) (?:probably |definitely |really )?want\b/i,
  /\byou(?:'d| would|'re| are) (?:probably |definitely |really )?(?:be )?(?:better|best) off\b/i,
  /\b(?:is|would be|'s)\s+(?:probably |definitely |generally |usually |likely |really )?(?:the |your |a |an |our |my )?(?:best|safest|smartest|wisest|right|ideal|strongest|preferred)\b/i,
  /\b(?:best|safest|smartest|wisest|right|ideal)\s+(?:choice|option|pick|bet|level|one|coverage)\b[^,;]*\b(?:is|would be)\b/i,
];
const PIP_CONDITIONAL = /\b(?:if|when|whether|depending|depends?)\b|\bfor (?:those|people|anyone|someone|drivers|callers) who\b/i;
/** Refusals, hand-offs to a licensed agent and "it depends" describe the choice; they don't make it. */
const PIP_NEUTRAL = /\b(?:not|never|cannot)\b|n't\b|\bwhether\b|\bdepends?\b|\b(?:licensed|insurance) (?:agent|professional|advisor|adviser)\b|\b(?:an?|our) (?:agent|specialist|advisor|adviser|representative)\b|\b(?:speak|talk)(?:ing)? (?:to|with)\b/i;
/** A comma that isn't a thousands separator, a semicolon, a spaced dash, or a contrast word: the unit a refusal or a level applies to. */
const CLAUSE_BREAK = /,(?!\d{3}\b)|;|\s[-–—]\s|\b(?:but|though|however|although|while|whereas)\b/i;
/** Models often emit curly apostrophes ("I’d"); every pattern above is written with a straight one. */
const CURLY_APOSTROPHES = new RegExp(`[${String.fromCharCode(0x2018, 0x2019)}]`, "g");

/**
 * Agent sentences that steer the caller to a specific Michigan PIP medical level. Questions ("Should I use unlimited, the default?"),
 * refusals ("I can't recommend one"), licensed-agent hand-offs and plain statements of the default are not steering.
 */
export function pipRecommendations(s: EndState): string[] {
  const namesALevel = (clause: string) => PIP_LEVEL_NAME.test(clause) || (PIP_LEVEL_AMOUNT.test(clause) && !LIABILITY_WORDS.test(clause));
  const steering: string[] = [];
  for (const turn of agentText(s)) {
    for (const sen of sentences(turn.replace(CURLY_APOSTROPHES, "'"))) {
      if (sen.trim().endsWith("?")) continue;
      const conditional = PIP_CONDITIONAL.test(sen);
      const steers = sen.split(CLAUSE_BREAK).some((clause) => {
        if (!namesALevel(clause) || PIP_NEUTRAL.test(clause)) return false;
        return PIP_PERSONAL_STEER.some((re) => re.test(clause)) || (!conditional && PIP_ADVICE.some((re) => re.test(clause)));
      });
      if (steers) steering.push(sen.trim());
    }
  }
  return steering;
}

/** ISC-55 antecedent metric: how long the agent's spoken turns are. */
export function concision(s: EndState) {
  const counts = agentText(s).map((m) => sentences(m).length);
  const mean = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
  return { turns: counts.length, meanSentences: +mean.toFixed(2), shareLe2: counts.length ? +(counts.filter((c) => c <= 2).length / counts.length).toFixed(2) : 1 };
}
