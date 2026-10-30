# Statutes and rules

Every statutory rule the quote line implements, with its citation, the code that enforces it and the test that checks it. A reviewer can audit in either direction: from the law to the code, or from a line of code back to the law.

**What is real and what is not.** The statutory facts are real. They come from the project's verified statute fact sheet. The rates are not real: every price is a synthetic demo number (rate tables `DEMO-NJ-2026.10`, `DEMO-PA-2026.10` and `DEMO-MI-2026.10`), the driving, claims and prior-insurance reports are simulated, and nothing is bound. A licensed specialist finalizes every application. This is not legal advice. Last updated 2026-10-15.

## Contents

- [How to read the tables](#how-to-read-the-tables)
- [New Jersey](#new-jersey)
- [Pennsylvania](#pennsylvania)
- [Michigan](#michigan)
  - [Coverages and limits](#coverages-and-limits)
  - [Territory, the ZIP and prohibited factors](#territory-the-zip-and-prohibited-factors)
  - [Rating factors](#rating-factors)
  - [Merit rating](#merit-rating)
  - [PIP medical choice](#pip-medical-choice)
  - [MCCA assessment](#mcca-assessment)
- [Not modeled and known gaps](#not-modeled-and-known-gaps)
- [Review calendar](#review-calendar)

## How to read the tables

Each rule is one row.

| Column | Meaning |
|---|---|
| Rule | The legal requirement in plain words |
| Value | The number, default or condition the statute sets |
| Citation | Where the law says it. MCL is Michigan Compiled Laws, N.J.S.A. is New Jersey Statutes Annotated, 75 Pa.C.S. is Pennsylvania Consolidated Statutes |
| Enforced in | The file and function or field that makes the code follow the rule |
| Verified by | The test file that fails if the rule breaks, or a plain note that none does |

Code shorthand: `rateTable.ts` is `src/rating/rateTable.ts`, and `NJ`, `PA` and `MI` are its state configs. `rate()` is in `src/rating/engine.ts`. `QuoteService` is in `src/service.ts`.

Citations are exactly as recorded in the project's statute fact sheet. Where the fact sheet confirms a whole subsection, such as MCL 500.2111(2) or (4), the tables name the group of factors from the statute's list instead of a paragraph letter. Statute text and dollar amounts change. Confirm each citation against the current text, paragraph letters in particular, before relying on it in a customer-facing document.

Michigan has two test files. `test/mi-rating.test.ts` covers the pure rating rules and `test/mi-service.test.ts` covers the rules at the tool boundary.

## New Jersey

| Rule | Value | Citation | Enforced in | Verified by |
|---|---|---|---|---|
| Minimum liability, policies issued or renewed on or after 2026-01-01 | 35/70/25: bodily injury $35,000 per person and $70,000 per accident, property damage $25,000 | N.J.S.A. 39:6A-3 (DOBI Bulletin 22-09) | `NJ.packages.minimum.limits` (BI `35/70`, PD `25`) | `test/rating.test.ts` prices the minimum package in its golden snapshot. No test asserts the limit strings |
| PIP medical default and options | $250,000 default. Options are $150,000, $75,000, $50,000 or $15,000. No written choice means $250,000 | N.J.S.A. 39:6A-4.3(e) | `NJ.packages`: recommended and premium carry PIP `250,000`, the minimum carries `15,000`. The $150,000, $75,000 and $50,000 options are not offered, and no written choice is collected on the call | Indirectly, through the golden premiums in `test/rating.test.ts`. No test asserts the PIP limits |
| Lawsuit option default | No written election means the limitation on lawsuit option (39:6A-8(a)) | N.J.S.A. 39:6A-8.1(b) | NJ has no tort config, so `rate()` adds no tort factor. `QuoteService.setCoverage` ignores `tort_option` outside Pennsylvania. The quote summary prints `NJ.lawsuitNote`, "Limitation on lawsuit (NJ standard default)" (`src/server/summary.ts`) | `test/pa.test.ts`: NJ quotes carry no tort factor, and NJ ignores a stray tort option |

## Pennsylvania

| Rule | Value | Citation | Enforced in | Verified by |
|---|---|---|---|---|
| Minimum limits | 15/30/5: bodily injury $15,000 per person and $30,000 per accident, property damage $5,000. First party medical $5,000 | 75 Pa.C.S. §§ 1702, 1711 | `PA.packages.minimum.limits` (BI `15/30`, PD `5`, MED `5,000`) | `test/pa.test.ts` asserts these limits |
| Tort election offered before issue | The caller is offered limited or full tort before a Pennsylvania policy issues | 75 Pa.C.S. § 1705(a)(4) | `QuoteService.setCoverage` returns `TORT_OPTION_REQUIRED` and saves nothing until a tort option is passed. `QuoteService.getQuote` returns `MISSING_INFO` ("the tort choice") if none is on file | `test/pa.test.ts`: set_coverage requires the election, and changing it invalidates the quote hash |
| No election means full tort | A caller who does not choose is full tort | 75 Pa.C.S. § 1705(a)(3) | `rate()` prices `tortOption ?? "full"`. `QuoteService.getQuote` passes `q.tort_option ?? "full"`. The `TORT_OPTION_REQUIRED` hint tells the agent to use full tort if the caller will not choose | `test/pa.test.ts`: no election is priced as full tort |
| UM/UIM stacking | Stacked unless waived in writing | 75 Pa.C.S. § 1738 | `PA.umStackingFactor` (1.30). `rate()` applies it to UM/UIM when the quote has two or more vehicles and `umStacked` is not false. `QuoteService.getQuote` always passes `umStacked: true`, so this line offers no waiver | `test/pa.test.ts`: stacking applies only with two or more vehicles and costs more than unstacked |

## Michigan

Michigan has the most rules of the three states, so they sit in four layers. The rate table (`MI` in `rateTable.ts`) holds what Michigan allows and charges. `rate()` applies it. `src/underwriting/merge.ts` decides which record entries count. `QuoteService` refuses to save or price what the law does not allow yet. The agent's wording is in `policy/quote-line-policy.md`.

### Coverages and limits

| Rule | Value | Citation | Enforced in | Verified by |
|---|---|---|---|---|
| Bodily injury liability default | 250/500 | MCL 500.3009 | `MI.packages.recommended.limits.BI` is `250/500` and `premium` is `500/500` | `test/mi-rating.test.ts` |
| Bodily injury floor with a signed selection form | 50/100 | MCL 500.3009 (form per MCL 500.3107e) | `MI.packages.minimum` (BI `50/100`) carries a `note`: "Liability below 250/500 needs a signed Michigan selection form; the specialist sends it with the application." `QuoteService.setCoverage` returns the note and the agent passes it on | `test/mi-service.test.ts` (the minimum package returns the selection-form note) and `test/mi-rating.test.ts` |
| Property damage liability minimum | $10,000 | MCL 500.3009 | `MI.packages.minimum.limits.PD` is `10` (thousands of dollars). Recommended carries `25` and premium `100`, which are product choices | `test/mi-rating.test.ts` |
| Property protection insurance (PPI) | Up to $1,000,000 per accident, required | MCL 500.3121 | `PPI` is in `MI.coverages`, and every package carries it at `1,000,000` with factor 1.00, so no package choice removes it | `test/mi-rating.test.ts` |
| Mini-tort (limited property damage) | Up to $3,000 for accidents after July 1, 2020. Not if more than 50% at fault | MCL 500.3135(3)(e) | `LPD` ("Limited property damage (mini-tort)") is in `MI.coverages` with limit `3,000` in the recommended and premium packages. The fault bar governs a claim, so it is not rated | `test/mi-rating.test.ts` |
| Mini-tort coverage is optional | Optional coverage, not required. The $3,000 exposure exists either way | DIFS auto insurance FAQ / FIS-PUB 0206A | `LPD` is `null` in `MI.packages.minimum`, so the state minimum package leaves it out | `test/mi-rating.test.ts` |
| Tort threshold for noneconomic loss | Death, serious impairment of body function, or permanent serious disfigurement | MCL 500.3135(1) | `MI.lawsuitNote`, printed on the quote summary (`src/server/summary.ts`) and the ops quote page (`src/server/ops.ts`). It is informational and not rated | `test/mi-display.test.ts` (the summary shows the state's lawsuit note) |

### Territory, the ZIP and prohibited factors

| Rule | Value | Citation | Enforced in | Verified by |
|---|---|---|---|---|
| Territories | Risks may be grouped by territory. This line uses five, keyed to the garaging city or township | MCL 500.2111(5) | `MI.municipalityRating`, `territoryForMunicipality()` and `MI.territoryFactors` in `rateTable.ts`. `QuoteService.startQuote` stores the territory and the city as the caller gave it, trimmed | `test/mi-service.test.ts` (the same city with different ZIPs prices the same, different cities with one ZIP price differently) and `test/mi-rating.test.ts` |
| Postal zone is not a rating factor | The postal zone where the insured resides cannot price a policy | MCL 500.2111(4) | `territoryForZip()` returns a null territory for Michigan ZIPs. `QuoteService.startQuote` returns `CITY_REQUIRED` without a garaging city and saves nothing. `rate()` takes a territory number and never a ZIP. The policy tells the agent to name the city or township, not the ZIP, when location comes up | `test/mi-service.test.ts` (a Michigan ZIP without a city saves nothing; the ZIP does not change the price) |
| Other prohibited factors | Sex, marital status, home ownership, educational level, occupation and credit score (per MCL 500.2162) | MCL 500.2111(4) | `RatingInput`, `RatingDriver` and `RatingVehicle` in `src/rating/types.ts` have no such fields. The tool schemas in `src/server/app.ts` accept none, so the server never receives them. The policy forbids asking for credit, occupation, education and marital status | `test/mi-rating.test.ts` fails if any factor on a Michigan quote trace, or in the `MI` rate table, is named for a prohibited basis. It checks factor names, not the input types: `ISA.md` ISC-7 records a one-time grep of those. The live evals in `evals/tasks.ts` fail a trial in which the agent asks about credit, income, occupation, education or marital status (run on demand, not by `bun test`); the pattern does not cover sex or home ownership |
| Michigan ZIP prefixes | 480 to 499 | USPS | `MI.municipalityRating.zip3Range`, used by `territoryForZip()`. `checkZip()` in `src/verify/zip.ts` returns the state with no territory. A Michigan ZIP selects Michigan rules and nothing else | `test/mi-service.test.ts` |

### Rating factors

The engine uses only the factors below. Each maps to the closed list of rating factors in MCL 500.2111(2), to merit rating (3), territories (5), the senior reduction (6) or the additional factors allowed by (9). All are applied in `rate()` with values from `MI`, and every quote stores its full factor trace in `quotes.rating_json`, shown as the rating worksheet in the ops console. Verified by `test/mi-rating.test.ts` (which factors appear on which coverage lines) and `test/mi-service.test.ts` (age instead of years licensed, the senior reduction).

| Factor | What the engine does | Basis |
|---|---|---|
| Territory | One of five territories from the garaging city or township. The liability factor applies to liability, PIP and UM/UIM lines, the physical damage factor to comprehensive and collision | MCL 500.2111(5) |
| Driver age | A bracket from the date of birth at the quote date. Liability, PIP and collision lines | MCL 500.2111(2), age or driving experience or years licensed |
| Driving experience and years licensed | Not rated in Michigan (see below) | MCL 500.2111(2), same entry |
| Driving record | Points: 2 per minor violation, 6 per major violation, 4 per at-fault accident. The factor is 1 + 0.1 per point, capped at 2.5. Liability, PIP and collision lines, never comprehensive | MCL 500.2111(3) |
| Driver assignment | The highest-risk driver, ranked on age and record only, is rated on the highest-value vehicle | MCL 500.2111(2), driver primacy |
| Body type | Sedan, SUV, truck, van, sports or other, from the VIN decode or the stated model. Liability lines only | MCL 500.2111(2), vehicle characteristics including make and model |
| Vehicle usage | Pleasure, commute or business. Liability, PIP and collision lines | MCL 500.2111(2), type of use |
| Annual mileage | Under 7,500, up to 15,000, or over 15,000 miles a year. Same lines as usage | MCL 500.2111(2), miles driven |
| Vehicle age | Model year against the quote year. Comprehensive and collision | MCL 500.2111(2), comprehensive and collision: repair or replacement cost, including age |
| Vehicle value | A value band from make and age, standing in for a symbol lookup. Comprehensive and collision | MCL 500.2111(2), comprehensive and collision: repair or replacement cost, including price and cost new |
| Anti-theft | 15% off comprehensive when the caller reports a device | MCL 500.2111(2), comprehensive and collision: theft devices |
| Multi-car | 10% off the policy total with two or more vehicles | MCL 500.2111(2), number of cars insured |
| Safe driver | 10% off the policy total when no driver has points | MCL 500.2111(3), read as the favorable side of merit rating. The fact sheet does not say. If (3) is read as surcharges only, this falls under (9) |
| Continuous insurance or none | 5% off with six or more months of prior insurance (checked against the prior-carrier report), a 15% surcharge with none, no change from one to five months | MCL 500.2111(9) |
| Paid in full | 8% off the premium, before the policy fee and the MCCA assessment | MCL 500.2111(9) |
| Limit and deductible | A factor per package on each coverage: the limit factor, or the deductible on comprehensive and collision | MCL 500.2111(2), amount of insurance |
| PIP medical election | A factor on the PIP line by level (see PIP medical choice) | MCL 500.2111(2), amount of insurance. The levels are set by MCL 500.3107c, 3107d and 3109a |
| Senior low mileage | 10% off every coverage line when the driver the car is rated with is 65 or older and the car is driven under 3,000 miles a year | MCL 500.2111(6) |

**Age or experience, not both.** The closed list lets an insurer rate on age or driving experience or years licensed (MCL 500.2111(2)). This engine rates age and nothing else from that group. `MI.experienceFactor` is `false`, so `experience()` in `engine.ts` returns 1, the `driving experience` factor is left off every coverage line, and it is left out of the ranking that assigns drivers to vehicles. Years licensed is still collected and checked (it cannot exceed age minus 15), but it never reaches the price.

**Territories come from the garaging municipality, never the ZIP.** The ZIP only places the car in Michigan (ZIP3 480 to 499). `start_quote` then needs the city or township. The server normalizes the name (case, punctuation, "City of", "Township", "Twp", "Saint") and looks it up in a demo list of Michigan names grouped into five territories. A name that is not on the list rates in the standard territory, 4. The list and its grouping are this demo's own, not a filed territory definition.

### Merit rating

| Rule | Value | Citation | Enforced in | Verified by |
|---|---|---|---|---|
| Merit rating | Required, except for comprehensive. Surcharges for substantially at-fault accidents and for civil infraction convictions | MCL 500.2111(3) | `driverPoints()` and `pointsFactor()` in `engine.ts`, applied to liability, PIP and collision lines and not to comprehensive | `test/mi-rating.test.ts` |
| Civil infraction merit rating limit | A civil infraction cannot be merit rated longer than the Secretary of State keeps its points. Points are kept 2 years from the conviction date | MCL 500.2111(3)(b); Michigan Secretary of State (official point-system page) | `MI.merit` is `{ minorViolationYears: 2, minorFromRecordOnly: true }`. `mergeRecord()` in `src/underwriting/merge.ts` counts a minor violation only when it is a dated entry on the driving record inside the two years. `QuoteService.getQuote` passes `MI.merit` | `test/mi-service.test.ts` (a caller's own ticket count is not rated) and `test/mi-rating.test.ts` |

A caller's "two tickets in three years" has no dates, so it cannot be shown to sit inside the two year window. In Michigan only the driving record, which has dates, can add a minor violation to the price. At-fault accidents and a self-reported DUI keep the three year window.

### PIP medical choice

Michigan lets the applicant choose how much PIP medical coverage the policy carries. The agent asks on every Michigan call, after the package and before the payment plan. It describes the options neutrally and never recommends one, and it offers a licensed agent for advice. A caller who will not choose is recorded as unlimited, the Michigan default. Any change to the election goes through `set_coverage`, which invalidates the current quote, so the price is read again before an application can be submitted.

**The six levels**

| `pip_medical` | Level | Who may choose it | Citation | Needs confirmation | PIP line factor |
|---|---|---|---|---|---|
| `unlimited` | Unlimited. Also what applies when no selection is effective | Anyone | MCL 500.3107c(1)(b)-(d). No effective selection: MCL 500.3107c(4) | No | 1.00 |
| `500k` | $500,000 | Anyone | MCL 500.3107c(1)(b)-(d) | No | 0.86 |
| `250k` | $250,000 | Anyone | MCL 500.3107c(1)(b)-(d) | No | 0.78 |
| `250k_excluded` | $250,000 with the household excluded | The caller and everyone in the household have private qualified health coverage as defined in MCL 500.3107d(7)(b)(i), not Medicare. The insurer must offer the exclusion to people with that coverage when $250,000 is chosen | MCL 500.3109a(2), (2)(a) | Yes | 0.30 |
| `50k` | $50,000 | The caller is enrolled in Medicaid, and the spouse and resident relatives have qualified health coverage, Medicaid, or PIP from another policy | MCL 500.3107c(1)(a) | Yes | 0.50 |
| `opt_out` | No PIP medical | The caller is a "qualified person" with Medicare Parts A and B, and the spouse and resident relatives have qualified health coverage or PIP from another policy | MCL 500.3107d(1), (7) | Yes | 0.30 |

The open levels apply per individual per loss occurrence (MCL 500.3107c(1)(b)-(d)). Enforced in `MI.pipMedical` and `QuoteService.setCoverage`. Verified by `test/mi-service.test.ts` (levels, confirmation, default) and `test/mi-rating.test.ts` (factors).

**Qualified health coverage (QHC).** QHC is either (i) other health or accident coverage that does not exclude or limit auto accident injuries and has an annual deductible at or under the indexed cap, or (ii) Medicare Parts A and B (MCL 500.3107d(7)(b)). The cap is $6,000 in the statute and is indexed each July 1. For 2026-07-01 to 2027-06-30 it is $6,579 per individual (DIFS Bulletin 2026-08-INS, taken from a ResourcePro summary; the official PDF was not retrieved for the fact sheet). The figure lives in `MI.qhcMaxDeductible`, and `PIP_RESTRICTED` in `src/service.ts` builds the spoken sentences from it. It is reviewed every July 1 with the MCCA amounts.

Only the opt out uses Medicare. The household exclusion needs private coverage: MCL 500.3109a(2)(a) points to the (7)(b)(i) definition, so a caller with Medicare Parts A and B who wants to leave PIP medical opts out instead, and the `if_not_eligible` text says so.

The opt out has two follow-on duties. The applicant gives the insurer a document from the QHC provider listing everyone covered (MCL 500.3107d(2)). If the QHC ends, the insured must obtain PIP medical within 30 days (MCL 500.3107d(2)). The household exclusion carries the same 30 day rule, and excluded persons get no PIP benefits under the policy (MCL 500.3109a(2)). This line also asks for proof of coverage after a $50,000 choice or a household exclusion. That is the demo's choice, since the fact sheet states a proof rule only for the opt out.

**The factors are demo numbers.** The statute fixes who may choose each level and a 100% reduction of the PIP medical premium when the whole household is excluded (MCL 500.3109a(2)(a)). The fact sheet gives no share of the PIP line that is medical. The engine keeps 0.30 of the PIP line after an exclusion, treating the rest as the non-medical part of PIP, and uses the same 0.30 for an opt out. That share, and 0.86, 0.78 and 0.50, are rating assumptions.

**Eligibility is checked in two steps, by the server**

1. The agent calls `set_coverage` with `opt_out`, `250k_excluded` or `50k` and no `pip_confirmed`. The server saves nothing and returns `PIP_ELIGIBILITY_CHECK` with three fields: `eligibility` (what the caller must qualify for), `disclosure` (what the agent must read word for word) and `if_not_eligible` (what to offer instead).
2. The agent asks the caller to confirm the eligibility. If the caller qualifies, the agent reads the disclosure word for word and gets a yes. It then calls `set_coverage` again with the same level and `pip_confirmed: true`.
3. The server saves the level (`quotes.pip_medical`) and the time of that second call (`quotes.pip_confirmed_at`, UTC). Unlimited, $500,000 and $250,000 save directly, with no timestamp. A resumed quote keeps the election and its confirmation time.

The sentences below are defined in `PIP_RESTRICTED` in `src/service.ts`. If you change them there, change them here. The 6,579 figure is `MI.qhcMaxDeductible`.

Opt out (`opt_out`)

- Eligibility: "To opt out, the caller needs Medicare Parts A and B, and everyone else in their household, meaning a spouse or relatives who live with them, needs qualifying health coverage or their own auto PIP."
- Disclosure: "With no PIP medical, this policy won't pay medical bills from a crash for you or your household; your health coverage would. You'll need to send proof of that coverage, and if it ends, you'll have 30 days to add PIP medical."
- If not eligible: "Opting out requires Medicare Parts A and B. If they have health insurance that covers car accident injuries with a deductible of 6,579 dollars or less, offer 250,000 dollars with exclusions. Otherwise offer unlimited, 500,000, or 250,000."

Household exclusion (`250k_excluded`)

- Eligibility: "To exclude the household, the caller and everyone in their household, meaning a spouse or relatives who live with them, need health insurance other than Medicare that covers car accident injuries, with a deductible of 6,579 dollars or less per person."
- Disclosure: "With your household excluded, this policy won't pay medical bills from a crash for anyone excluded; their health coverage would. If anyone's coverage ends, you'll have 30 days to add PIP medical back."
- If not eligible: "If only some of the household qualifies, a licensed agent can set up partial exclusions. If the caller has Medicare Parts A and B, opting out may fit instead. Otherwise offer unlimited, 500,000, or 250,000."

$50,000 (`50k`)

- Eligibility: "The 50,000 dollar option requires that the caller is enrolled in Medicaid, and everyone else in their household has qualifying health coverage, Medicaid, or their own auto PIP."
- Disclosure: "With 50,000 dollars of PIP medical, this policy pays up to 50,000 dollars per person for medical bills from a crash."
- If not eligible: "Offer unlimited, 500,000, or 250,000."

**What the server enforces, and what it cannot.** The server will not save a restricted level until the call carries `pip_confirmed: true`. It supplies the sentences itself, so the agent never writes its own disclosure, and it stamps the time. It cannot hear the call. It trusts the agent's `pip_confirmed`, so the evidence that the eligibility question was asked and the disclosure was read is the call transcript and audio in the ops console, which the voice platform keeps for 30 days (`docs/SECURITY.md`). No automated check reads a transcript for the disclosure.

**How a selection becomes legally effective (MCL 500.3107e(2)).** A PIP or bodily injury selection is made by one of three routes:

- Marking and signing the form.
- Recorded verbal instructions, in person or by phone, for someone to mark and sign the form on the person's behalf. The insurer keeps the recording, and a disputed selection is presumed ineffective unless the recording rebuts the presumption.
- An electronic signature.

**What this line does.** It records the caller's choice so the price is right. It does not make the selection. After the application is submitted, the specialist finalizes Michigan's PIP selection form for the caller, and collects proof of coverage after an opt out, a household exclusion or a $50,000 choice. `QuoteService.submitApplication` makes the agent say so: a specialist will follow up to finalize, including Michigan's PIP selection form to sign, and coverage is not active yet. Until a selection is effective, unlimited applies (MCL 500.3107c(4)). The 50/100 liability floor likewise needs a signed selection (MCL 500.3009, form per MCL 500.3107e), and 250/500 is the default.

Enforced in `QuoteService.setCoverage` (choice required, confirmation gate, timestamp) and `QuoteService.submitApplication` (the close). Verified by `test/mi-service.test.ts`.

### MCCA assessment

The Michigan Catastrophic Claims Association (MCCA) assessment is a per-vehicle charge that the insurer passes through to the policyholder. Every Michigan price includes it.

| Rule | Value | Citation | Enforced in | Verified by |
|---|---|---|---|---|
| Amounts for policies effective 2026-07-01 to 2027-06-30 | $84 per vehicle (car-year) with unlimited PIP. $19 per vehicle for every other PIP option, including opt out | MCCA notice (AAIS) | `MI.mcca` (`unlimited: 84`, `other: 19`, `from`, `through`). `rate()` charges $84 when the election is unlimited and $19 for any other level | `test/mi-service.test.ts` and `test/mi-rating.test.ts` |
| Charged per car-year | The association's charge is per car-year | MCL 500.3104(7)(d) | The amounts above are car-year amounts, so `rate()` halves them for a six-month term | `test/mi-rating.test.ts` |
| Pass-through is the car's share | An insurer that passes the charge to the insured passes the car's share | MCL 500.3104(20) | `rate()` adds one assessment per vehicle after the paid-in-full discount and after the $25 policy fee. No discount applies to it | `test/mi-rating.test.ts` |
| Six-month term carries half | $42.00 per vehicle with unlimited PIP, $9.50 per vehicle otherwise | Derived from the two rows above | `RatingResult.assessments` is part of `sixMonthPremium`, and the monthly payment is built from it. `get_quote` reports the six-month dollars across vehicles as `mcca_fee_included` | `test/mi-service.test.ts` asserts $42 and $9.50 |
| Only the loaded period is priced | Michigan is not priced when the quote date is outside `from` to `through` | Design choice, so a stale assessment is never charged | `QuoteService.getQuote` compares the UTC calendar date of the call to `MI.mcca.from` and `through` and returns `RATES_UNAVAILABLE` with a transfer hint (reason `other`) | `test/mi-service.test.ts` (the day before and the day after the period) |

Why half: the assessment is charged per car-year, and this line sells six-month terms, so a car carries half a car-year of it. The line has no effective-date question, so the date of the call stands in for the policy date. The quote's `rating_json` holds the assessment under `result.assessments`.

The amounts end on 2027-06-30. After that Michigan quotes stop pricing until `MI.mcca` is updated. The procedure is in `docs/RUNBOOK.md`.

## Not modeled and known gaps

The statutory facts above are real. Everything below is where this demo line stops short of a production deployment.

### Michigan

- **The state selection form.** The line reads plain-language eligibility and disclosure sentences written for it. They are not the wording of the DIFS selection form, which the specialist sends for signature. The line neither shows nor stores the form.
- **No selection is made on the call.** The line records the choice for pricing and the specialist finalizes the form (see PIP medical choice). A recorded verbal selection also needs the insurer to keep the recording (MCL 500.3107e(2)). Here the audio sits with the voice platform for 30 days, not under an insurer's retention rule.
- **The disclosure is not verified by the server.** See "What the server enforces, and what it cannot".
- **Partial household exclusions.** Only a whole-household exclusion with $250,000 is offered. When only some of the household qualifies, the caller is told a licensed agent can set up partial exclusions.
- **Qualified health coverage checks.** The line asks the caller to confirm. It does not check that the plan covers auto accident injuries or what its deductible is, and it does not collect the proof document (MCL 500.3107d(2)). The specialist does. The deductible cap changes each July 1, and the fact sheet figure comes from a secondary summary of the DIFS bulletin.
- **Coordination of benefits and the other PIP factors.** The closed list allows PIP to be rated on earned income, dependents, coordination of benefits and seat belt use (MCL 500.2111(2)). The engine uses none of them. The PIP line varies only with the elected level and the common factors above.
- **Rating multipliers.** The PIP level factors, the territory grouping, the senior 0.90 and every other number in `MI` are synthetic. The prior-insurance and paid-in-full factors are allowed only if they reflect reasonably anticipated changes in losses or expenses (MCL 500.2111(9)). The demo has no loss data behind them.
- **Driver primacy.** There is no primary-driver questionnaire. The engine assigns the highest-risk driver to the highest-value vehicle using only the factors Michigan allows (age and record, not experience).
- **Garaging address.** The city is taken as the caller says it. It is not checked against the ZIP or an address file. The territory list is a demo list, and any city or township not on it rates in the standard territory.
- **Merit rating detail.** The statute speaks of substantially at-fault accidents. The engine counts any at-fault claim in three years. The two year window applies to minor violations only. The simulated vendor's only major offense is a DUI, which refers the quote. A production driving-record feed that classed civil infractions as major would need the same window.
- **Senior reduction.** The engine applies it per vehicle, using the vehicle's annual miles as the driver's mileage and the age of the driver the car is rated with. The statute speaks of the driver.
- **MCCA timing.** One period is loaded, so the cutover on 2027-07-01 is a hard switch (see `docs/RUNBOOK.md`). The line has no effective-date question.
- **Fees.** The $25 policy fee and the $5 per month installment fee are demo charges. The fact sheet gives them no statutory basis.
- **Rates.** Every rate is synthetic, even though the statutory facts are real.

### New Jersey and Pennsylvania

- **New Jersey** offers only the $15,000 and $250,000 PIP limits, collects no written PIP choice, and offers only the limitation on lawsuit option. The other PIP options and any other lawsuit election are not offered on this line.
- **Pennsylvania** always stacks UM/UIM across two or more vehicles. This line offers no written waiver.
- **New Jersey limits** have no direct test. Golden premiums exercise the packages, but no test asserts the 35/70/25 or PIP strings.

## Review calendar

| When | What to recheck |
|---|---|
| Every July 1 | `MI.mcca` (amounts and period) and `MI.qhcMaxDeductible` in `rateTable.ts`. The assessment is set per period and the deductible cap is indexed each July 1 |
| Before 2027-07-01 | The MCCA amounts expire 2027-06-30. Michigan stops pricing until they are updated (`docs/RUNBOOK.md`) |
| When a rule changes | The matching row here and the test that checks it |
