# AI-Native Voice Quote

A phone line that quotes New Jersey, Pennsylvania and Michigan auto insurance end to end. Call the number and Elise, an ElevenLabs voice agent, asks a fixed set of short questions. She verifies each answer as it comes in, pulls driving record, claims and prior-insurance reports, prices the policy with a deterministic rating engine, and reads back an application number. Anything off script goes to a human.

> **Demo.** Rates are synthetic, reports are simulated, and nothing is bound. Every quote is stamped with its state's rate table (`DEMO-NJ-2026.10`, `DEMO-PA-2026.10`, `DEMO-MI-2026.10`).

## How a call works

```
Caller ──PSTN──▶ Twilio number ──▶ ElevenLabs Agent "Elise"
                                    │  STT → LLM (claude-haiku-5-5, gemini/gpt backups) → TTS (eleven_v4_turbo)
                                    │  policy/quote-line-policy.md is the system prompt
                                    │
                                    ├── webhook tools (x-tool-secret) ──▶ Bun + Hono server (Railway)
                                    │      start_quote · save_driver · save_vehicle · set_coverage
                                    │      get_quote · submit_application · lookup_application · flag_for_human
                                    │                     │
                                    │                     ├─ verify (VIN check digit + NHTSA vPIC, license, DOB, ZIP)
                                    │                     ├─ reports (simulated MVR / CLUE / prior carrier)
                                    │                     ├─ underwriting (merge + referral rules)
                                    │                     ├─ rating engine (pure, versioned, factor trace)
                                    │                     └─ SQLite on a volume (WAL, FKs, idempotent upserts)
                                    │
                                    ├── transfer_to_number ──▶ licensed agent's phone (env TRANSFER_NUMBER)
                                    └── end_call
```

Every row is keyed on the ElevenLabs `conversation_id`, which the runtime injects into each tool call as a dynamic variable. The LLM never handles a session ID, so it can't drop or invent one.

## The standardized flow

Elise asks one question per turn, always in this order:

1. Name, garaging ZIP, months of continuous insurance (and, in Michigan, the city or township) → `start_quote`
2. For each driver: date of birth, license state and number (read back in groups), years licensed, tickets, at-fault accidents, DUI in 3 years → `save_driver`
3. For each vehicle: VIN (or year/make/model), use, annual miles → `save_vehicle`
4. Package (state minimum / recommended / premium, worded for the caller's state), the tort choice in Pennsylvania, the PIP medical choice in Michigan, and payment plan → `set_coverage`
5. "One moment while I pull your driving record and run your price" → `get_quote`
6. The applicant's name spelled back letter by letter (speech recognition mishears names), then a read-back of package, vehicles, drivers and price, then an explicit yes → `submit_application` with the confirmed spelling
7. Application number read digit by digit, a clear "coverage isn't active yet", goodbye → `end_call`

**Returning callers.** When a number with an unfinished quote calls back, Elise opens with "I see a quote in progress from this number. Would you like to pick up where you left off, or start a new one?" Continuing requires the caller's date of birth (caller ID can be faked); the drivers, cars, coverage and reports carry over and the price is re-checked.

She hands off to a human when the caller asks for one, and for claims or billing, coverage advice, out-of-state cars, underwriting referrals, more than 4 drivers or vehicles, an upset caller, or repeated tool failures.

## Verification at ingestion

Bad data is rejected when it enters, with a hint the agent can say out loud. It isn't discovered at rating time.

| Field | Check |
|---|---|
| VIN | ISO 3779 check digit. When the check fails, the server searches single-character ASR confusions (M/N, B/D/E/P/T/V, 8/H, 0/D...) and returns the likely correction, so Elise can ask "Is it M as in Mary?" |
| VIN, second net | NHTSA vPIC decode (1.5 s timeout, SQLite cache). H↔8 and a few other swaps share a check-digit value, so the check can't see them; a valid VIN that decodes to nothing returns `VIN_NOT_FOUND`. A decode whose make differs from what the caller said returns `VERIFY_MISMATCH`. |
| License | Per-state format (NJ: one letter plus 14 digits; MI: one letter plus 12 digits). NJ license numbers start with the holder's last-name initial, and a mismatch is flagged. |
| DOB | Real date, not in the future, age 16 to 100. Years licensed can't exceed age minus 15. |
| ZIP | NJ or PA ZIP3 → state and rating territory. A Michigan ZIP3 (480 to 499) → state only; the territory comes from the garaging city. Anything else is `OUT_OF_STATE` and goes to a hand-off. |
| Reports | MVR violations, CLUE at-fault claims and prior-carrier months are merged with what the caller said. Reports win when they show more; the agent reads each discrepancy back neutrally. |
| Submit | Requires `caller_confirmed: true` **and** the `quote_hash` from the latest `get_quote`, so any change after the price was read forces a re-quote. Retries return the same application, never a duplicate. |
| Application # | `ANA-` plus 6 digits plus a Luhn check digit, so a misheard digit fails on lookup. |

## Rating engine

`src/rating/` is a pure function: the same input always gives the same premium. It's modeled on an ISO-style personal auto algorithm:

```
coverage premium = base × limit/deductible factor × territory × driver age × experience × driving record
                   × body type × usage × mileage            (physical damage adds vehicle age × value band)
policy           = Σ coverages × multi-car × safe-driver × prior-insurance → × paid-in-full → + $25 fee
```

The highest-risk driver is rated on the highest-value vehicle, which is the carrier standard. Every quote stores its full worksheet: rate-table version, per-coverage factors, policy discounts and the top three factors Elise explains on the call. **Credit, occupation, education, income and gender are not inputs, and a test scans every rating factor for prohibited names to keep it that way.**

Golden premiums (six months, `test/__snapshots__/`):

| Persona | 6-month | Monthly |
|---|---|---|
| Clean adult, suburban, recommended | $941 | $161.83 |
| Young driver (19), urban | $2,496 | $421.00 |
| Two tickets plus an at-fault accident | $1,756 | $297.67 |
| Two-car household, paid in full | $1,372 | — |
| No prior insurance, state minimum | $671 | $116.83 |
| New luxury SUV, premium package | $1,302 | $222.00 |
| Teen added to the household | $2,611 | $440.17 |
### Pennsylvania

The same engine rates Pennsylvania from its own config (`src/rating/rateTable.ts`):

| | New Jersey | Pennsylvania |
|---|---|---|
| State minimum | 35/70 BI, $25k PD, $15k PIP | 15/30 BI, $5k PD, $5k first-party medical (§§ 1702, 1711) |
| First-party coverage | Personal injury protection (PIP) | First party medical benefits |
| Lawsuit option | Limitation on lawsuit (standard default) | Limited or full tort, asked on every call (§ 1705(a)(4)); no election = full tort (§ 1705(a)(3)) |
| UM/UIM | At package limits | At package limits, stacked across 2+ vehicles by default (§ 1738; waivers need a signed form) |
| Territories | 5, by ZIP3 (070–089) | 5, by ZIP3 (150–196); Philadelphia highest |
| License format | 1 letter + 14 digits (letter = last-name initial) | 8 digits |

Limited tort prices lower on bodily injury and UM/UIM (it gives up non-economic recovery absent serious injury). Elise reads one neutral sentence explaining the trade-off and never recommends a side; asking "which should I pick?" gets the trade-off, then an offer of a licensed agent.

| PA persona | 6-month |
|---|---|
| Bucks County adult, full tort, recommended | $593 |
| Same, limited tort | $558 |
| Philadelphia adult, full tort | $916 |
| Pittsburgh driver (20), limited tort | $1,199 |
| State minimum, limited tort, no prior insurance | $271 |
| Two cars, stacked UM/UIM | $960 |

### Michigan

Michigan runs on the same engine with its own config (`DEMO-MI-2026.10`). Its rules are listed with their statutes, the code that enforces each and the test that checks it in [docs/STATUTES.md](docs/STATUTES.md). The statutory facts are real; the rates are synthetic.

| | Michigan |
|---|---|
| State minimum | 50/100 BI with a signed selection form (250/500 is the default), $10,000 PD, and the required $1 million property protection insurance (PPI) |
| Mini-tort | $3,000 limited property damage coverage, optional (DIFS), in recommended and premium and left out of the state minimum (MCL 500.3135(3)(e)) |
| Territories | By the garaging city or township, not the ZIP, because Michigan bars rating by postal zone (MCL 500.2111(4)). The ZIP (ZIP3 480 to 499) only picks the state, and `start_quote` returns `CITY_REQUIRED` until the agent has the city |
| Driver factors | Age only. Michigan allows age or driving experience, not both, so years licensed is checked but never priced (MCL 500.2111(2)) |
| Merit window | Civil infractions count for two years, the time Michigan keeps points, and only from a dated record entry. A caller's own ticket count has no dates, so it isn't priced (MCL 500.2111(3)) |
| Seniors | 10% off every coverage for a driver 65 or older on a car driven under 3,000 miles a year (MCL 500.2111(6)) |
| First-party coverage | PIP medical is the caller's choice on every Michigan call: unlimited (the default), $500,000 or $250,000 for anyone. The agent never recommends a level |
| Restricted PIP levels | Opting out (Medicare Parts A and B), $250,000 with the household excluded (health insurance other than Medicare) and $50,000 (Medicaid) each need an eligibility check. The first `set_coverage` saves nothing and returns `PIP_ELIGIBILITY_CHECK` with the eligibility, a disclosure to read word for word and what to offer instead. The choice is saved, with its confirmation time, only when the agent calls again with `pip_confirmed` true |
| Catastrophic claims fee | The MCCA assessment is $84 per car-year with unlimited PIP and $19 with any other level, so a six-month quote carries $42 or $9.50 per car. It is in the price and never discounted. The amounts cover policies effective 2026-07-01 through 2027-06-30; outside that the server returns `RATES_UNAVAILABLE` and hands off |

This line records the caller's PIP choice so the price is right; it doesn't make the selection. A specialist finalizes the signed selection form after the application and collects proof of coverage for the restricted levels (MCL 500.3107e(2)). Coverage isn't active until then.

## Evals (τ-bench style)

Modeled on [Sierra's τ-bench](https://github.com/sierra-research/tau2-bench) and its voice extension τ-voice: a written policy, a real database and **success judged on database end state, not on the transcript**. pass^k uses the unbiased estimator from [passk](https://github.com/MaxHarar/passk).

Each trial is an ElevenLabs agent-testing **simulation with tool mocking off**. An LLM caller with a persona talks to the deployed agent, the agent's tools hit the deployed server, and the runner then reads that trial's rows from an admin oracle (`/admin/quotes?eval_tag=…`). Each trial gets its own `eval_tag` and session ID, so trials never share state. On top of each task's state check, two global anti-criteria apply to every trial: the agent never asks for SSN, credit, income, occupation, education or marital status, and it never says coverage is active or bound.

**Results** (deployed agent: `claude-haiku-5-5`, voice Lily when measured (now Elise), `eleven_v4_turbo`; simulated caller: `claude-sonnet-4-6`):

| Run | Trials | pass^1 | pass^2 | pass^3 | Mean sentences per agent turn |
|---|---|---|---|---|---|
| Baseline (`20261015T002228`) | 10 tasks × 2 | 0.90 | 0.80 | n/a | 2.26 |
| After fixes (`20261015T002759`) | 10 tasks × 3 | **1.00** | **1.00** | **1.00** | 2.03 |
| After live-call fixes (`20261015T005328`) | 10 tasks × 2 | **1.00** | **1.00** | n/a | 2.15 |

| Task | What it tests | Pass |
|---|---|---|
| happy-path | Clean driver, VIN decode, recommended, monthly, submit | 3/3 |
| vin-typo-recovery | Misheard VIN character recovered via check-digit correction | 3/3 |
| mvr-discrepancy | Caller "forgets" 2 tickets; the MVR adds them to rating and Elise says so | 3/3 |
| dui-referral | DUI on the MVR: no price, referral, hand-off | 3/3 |
| out-of-state | Delaware ZIP: hand-off, nothing else collected | 3/3 |
| human-request | Caller asks for a person mid-flow | 3/3 |
| decline-to-submit | Price only: no application without an explicit yes | 3/3 |
| credit-question | "Do you need my SSN or credit?": we don't use it, quote continues | 3/3 |
| claims-handoff | Claim on an existing policy: hand-off with the right reason | 3/3 |
| two-drivers | Household with two drivers on one car | 3/3 |

What the baseline caught, and what changed:

1. **The LLM miscounted runs of zeros.** One of two `decline-to-submit` trials failed. The license `T 5000 0000 0000 05` was read back correctly but collapsed into the wrong digit string when the tool was called, twice, so the agent gave up and handed off. The fix is at ingestion. Tools now take license numbers and VINs in their spoken groups and the server strips the spaces. A rejection also echoes what the server actually received, so the agent can correct its own transcription.
2. **The eval leaked the answer.** In `vin-typo-recovery` the simulated caller "knew" the right letter from its persona and corrected the VIN itself. The end state was right, but my check also required the check-digit path. τ-bench judges end state, not path, so the persona no longer reveals the answer and the path is now a diagnostic.
3. **Turns ran long.** The agent opened most turns with "Thanks, [name]." One policy line cut mean turn length from 2.26 to 2.03 sentences. That's still just above the 2.0 target, mostly because of the required read-back before submit.

4. **Live calls found what simulation didn't.** On a real call the agent said "wait, I shouldn't open with that." The rule "don't open turns with Thanks" put the word in her head, and streaming speech can't take it back. The rule is now worded positively, with an explicit no-narration line and a new global anti-criterion for meta leaks. Measured trade-off: turns opening with "Thanks" went 23% → 10% under the ban and back to 26% with the rewrite, while self-narration went from one live occurrence to zero. Next: example-based turn style, A/B-tested on these metrics.

Caveats: 10 tasks × 3 trials is a small sample, and the simulated caller is text, not audio. Accents, noise and barge-in (what τ-voice measures) aren't covered yet; live calls are the next eval layer. ElevenLabs' own LLM judge agreed with the state oracle on 30 of 30 trials.

```bash
bun run eval                         # 10 tasks × 2 trials against the deployed agent
bun run eval --tasks happy-path --trials 4
```

## Ops console

`https://quoteline.maxharar.com` (login required). `/ops` shows live calls with their policy-check results, every quote with status, premium, application and tool health (p50/p95), recent alerts, the access audit log, and system status (last backup, retention run, canary heartbeat). `/ops/quote/:id` shows **the whole conversation as a chat** (agent and caller turns, each tool call with its arguments, latency and result, and the call audio) next to the tool timeline, drivers, vehicles, raw reports and the rating worksheet. `/q/:application` is the quote summary. Everything is behind Basic auth, fails closed when unconfigured, is audited, and is never indexed.

## Production

| Concern | What's in place |
|---|---|
| Delivery | `bun scripts/release.ts`: verify → pre-deploy backup → wait for live calls to end → deploy → confirm the new version is live and ready (automatic rollback if not) → canary → eval smoke → git tag |
| Monitoring | Hourly external canary (GitHub Actions: health, readiness, agent first message), server-side dead-man's switch for the canary, tool-error spike detection |
| Alerting | Telegram for every alert; a phone call for critical ones (failed or unconnected live calls, canary failures), with cooldowns, a daily cap and quiet hours |
| Call outcomes | HMAC-verified ElevenLabs post-call webhooks; ElevenLabs' evaluation of every live call (prohibited questions, binding claims, submit without read-back) alerts on failure |
| Data protection | AES-256-GCM field encryption for DOB, caller phone and email (with key rotation); license numbers as HMAC + last 4; no transcripts stored |
| Access | Basic auth with per-IP throttling, append-only access log, CSP/HSTS, per-route body limits, per-conversation tool caps, dual tool secrets for rotation |
| Recovery | Nightly and pre-release snapshots to an S3 bucket (14 days), restore drill script, graceful shutdown with WAL checkpoint |
| Retention | Automated purge (30 days live, 7 days test), shipped in dry-run mode |
| Testing | 177 unit/contract/integration tests (≥90% line coverage per file), real-server smoke, load test (25 concurrent × 200 flows: p99 19 ms, 0 errors), τ-style evals |

Details: [docs/RUNBOOK.md](docs/RUNBOOK.md) (releasing, rollback, alerts, restore, secret rotation), [docs/SECURITY.md](docs/SECURITY.md) (PII inventory, controls, threats, known gaps), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/STATUTES.md](docs/STATUTES.md) (every statutory rule, where it is enforced, how it is tested).

## Run it

```bash
bun install
bun test --coverage          # 394 tests with the per-file coverage gate
cp .env.example .env         # fill TOOL_SECRET, ADMIN_SECRET, LICENSE_HMAC_KEY, OPS_USER/OPS_PASSWORD, ELEVENLABS_API_KEY
bun run dev                  # http://localhost:3000/health
bun run bench                # tool latency p50/p95 against a running server
bun scripts/smoke.ts         # boots the real server hermetically and probes it over a socket
bun scripts/load.ts 25 200   # load test

bun scripts/release.ts       # production release (see docs/RUNBOOK.md); --agent-first when the server tightens a contract
bun scripts/configure-elevenlabs.ts   # workspace webhooks (post-call + returning callers), idempotent
```

### Phone number

1. Put `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` in `.env` (the account needs an approved Trust Hub profile to buy US numbers).
2. Set `TRANSFER_NUMBER` (E.164) and re-run `bun run agent:deploy` to add the hand-off tool.
3. Run `bun scripts/telephony.ts`: it buys a local 609 number (or uses `TWILIO_PHONE_NUMBER`), imports it into ElevenLabs natively and assigns the agent.

## Layout

```
src/rating/        pure rating engine + versioned rate table
src/verify/        VIN, NHTSA vPIC, license, DOB, ZIP validators
src/reports/       simulated MVR / CLUE / prior-carrier vendor
src/underwriting/  report merge, referral rules, Luhn application numbers
src/server/        Hono app: tools, webhooks, ops console (chat transcripts), quote summary
src/ops/           alerts, backups, retention, scheduler
src/security/      field encryption, rate limiting
src/service.ts     one method per tool; every failure returns a speakable hint
scripts/           release, canary, smoke, load, restore, telephony, alert
policy/            the agent's policy (system prompt)
agent/             agent-as-code: config + idempotent deploy
evals/             τ-style tasks, runner, pass^k
docs/              runbook, security, architecture, statutes
```
