# Architecture

## Components

| Component | Tech | Responsibility |
|---|---|---|
| Telephony | Twilio (local 609 number) | PSTN in; conference leg out for transfers to a licensed agent |
| Voice agent | ElevenLabs Agents: `claude-haiku-5-5` (Gemini/GPT backups), voice Elise on `eleven_v4_turbo` | Conversation, speech in and out, tool calling under `policy/quote-line-policy.md` |
| Quote server | Bun + Hono on Railway, SQLite (WAL) on a volume | Tool endpoints, verification, rating, underwriting, applications, ops console, webhooks, scheduled jobs |
| Backups | S3-compatible bucket | Nightly and pre-release snapshots |
| Monitoring | GitHub Actions canary, server scheduler, Telegram, Twilio voice alerts | Outside-in checks and paging |

## A call, end to end

```
caller dials ─▶ Twilio ─▶ ElevenLabs answers with the disclosure (uninterruptible)
  ├─ start_quote(name, ZIP, prior months, garaging city in MI) ─▶ state from the ZIP; territory from the ZIP (NJ, PA) or from the garaging city (MI, CITY_REQUIRED without it); packages sentence for that state
  ├─ save_driver(...) ─▶ DOB/license/years validated; simulated MVR/CLUE/prior pulled with the raw license, then only HMAC + last 4 kept
  ├─ save_vehicle(...) ─▶ VIN check digit (+ correction search) and NHTSA decode with a 1.5 s timeout and cache
  ├─ set_coverage(package, plan, tort for PA, PIP medical for MI) ─▶ PA refuses without a tort election; MI refuses without a PIP choice and holds opt out, household exclusion and $50,000 until eligibility is confirmed
  ├─ get_quote ─▶ merge reports with what the caller said, underwriting referral rules, pure rating engine, quote_hash; MI adds its catastrophic claims assessment and refuses to price outside the assessment period
  ├─ submit_application(quote_hash, confirmed yes, spelled-back name) ─▶ Luhn-checked ANA-####### number; in MI the close names the PIP selection form to sign
  ├─ flag_for_human + transfer_to_number ─▶ conference to the licensed agent's phone
  └─ end_call
after the call ─▶ ElevenLabs post-call webhook (HMAC) ─▶ calls table, alerts on failures or policy checks
```

Every tool call is keyed on `system__conversation_id`, injected by ElevenLabs rather than authored by the LLM. Tools bind only `system__*` variables, because a phone call carries nothing else and a missing variable stops the call from starting. All writes are idempotent upserts, so ElevenLabs retries and LLM double-calls never duplicate data.

## Three states

New Jersey and Pennsylvania find the territory from the ZIP. Michigan cannot: MCL 500.2111(4) bars rating by postal zone, so the ZIP only places the car in the state and the territory comes from the garaging city or township the caller names.

| | New Jersey | Pennsylvania | Michigan |
|---|---|---|---|
| State from | ZIP3 070 to 089 | ZIP3 150 to 196 | ZIP3 480 to 499 |
| Territory from | ZIP3 table | ZIP3 table | Garaging city or township (`territoryForMunicipality`); a name not on the list rates in the standard territory |
| Asked before pricing | Nothing extra | Tort choice | PIP medical choice |
| Extra charge in the price | None | None | MCCA catastrophic claims assessment |
| Rate table | `DEMO-NJ-2026.10` | `DEMO-PA-2026.10` | `DEMO-MI-2026.10` |

### Michigan PIP: the eligibility two-step

```
set_coverage(pip_medical = unlimited | 500k | 250k) ─▶ saved
set_coverage(pip_medical = opt_out | 250k_excluded | 50k), no pip_confirmed
  └─▶ nothing saved; PIP_ELIGIBILITY_CHECK {eligibility, disclosure, if_not_eligible}
agent confirms eligibility with the caller, reads the disclosure word for word, gets a yes
set_coverage(same level, pip_confirmed = true) ─▶ saved: quotes.pip_medical + quotes.pip_confirmed_at (UTC)
```

The server holds the sentences (`PIP_RESTRICTED` in `src/service.ts`), so the agent never writes its own disclosure. It cannot hear the call, so the transcript and audio in the ops console are the evidence that the question was asked and the disclosure read. The line records the choice for pricing; a specialist finalizes the selection form.

### Where the law lives in the code

| Layer | File | What it decides |
|---|---|---|
| Rate table | `src/rating/rateTable.ts` | What each state allows and charges: packages and limits, territories, PIP levels, assessment amounts and period, merit window, the qualified health coverage deductible cap |
| Engine | `src/rating/engine.ts` | How factors combine, and which a state drops (Michigan drops experience) |
| Underwriting | `src/underwriting/merge.ts` | Which record entries count, including the merit window |
| Service | `src/service.ts` | What a tool refuses to save or price: the tort election, the PIP choice, the eligibility confirmation, the assessment period |
| Agent policy | `policy/quote-line-policy.md` | What the agent says and never says |

[STATUTES.md](STATUTES.md) lists each rule with its citation, the code that enforces it and the test that checks it.

## Data model

| Table | Holds |
|---|---|
| `quotes` | One row per conversation: state, territory, garaging city and PIP election with its confirmation time (MI), coverage, tort, status, price, rating worksheet |
| `drivers`, `vehicles`, `reports` | The quote's inputs (DOB encrypted; license as HMAC + last 4) |
| `applications` | Issued application numbers with the confirmed applicant name |
| `call_events` | Every tool call: tool, outcome, latency (no PII) |
| `calls` | Post-call webhook outcomes: status, duration, termination, evaluation results |
| `alerts`, `access_log`, `meta` | Alert history (cooldowns), audit trail, job state |

## Rating

`src/rating/` is a pure function over a per-state config (`StateConfig` in `rateTable.ts`): coverages and how each is rated, base rates, territories (ZIP3 tables for NJ and PA, a municipality table for MI), packages, PA's tort and stacking factors, and MI's PIP levels, catastrophic claims assessment, merit window, age-only rating and senior low-mileage factor. Adding a state is a new config plus tests. Rules that differ in kind are optional config fields the engine reads (`municipalityRating`, `experienceFactor`, `seniorLowMileage`, `merit`, `pipMedical`, `mcca`, `qhcMaxDeductible`), so a state without them rates exactly as before. The NJ and PA golden snapshots check that adding Michigan changed no NJ or PA number.

## Design decisions

The project ISA (`ISA.md`, `## Decisions`) records each decision and the evidence behind it: SQLite on one instance (latency, one code path) instead of Postgres, server-side session keys, quote-hash confirmation, grouped spoken IDs, transcripts fetched on demand instead of stored, dry-run-first retention, expand-then-contract deploy ordering.
