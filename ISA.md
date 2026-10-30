---
task: AI-Native Voice Quote, a demo phone quoting line for NJ auto insurance
project: ai-native-voice-quote
effort: E4
phase: verify
progress: 121/129
mode: loop
iteration: 5
started: 2026-10-14
updated: 2026-10-15
---

# AI-Native Voice Quote (demo)

## Problem

Personal auto carriers still quote by phone through human reps. A prospect who calls wants a price fast, and a rep has to collect roughly 15 data points, order MVR/CLUE reports, run the rating algorithm and issue an application. Max needs a working, testable demo that proves an AI voice agent can do this intake end to end. It has to be reliable (pass^k, not cherry-picked calls), policy-bound, and able to escalate to a human when the call goes off-script.

## Vision

You dial a number and a warm, natural voice (Elise) answers as the AI-Native Auto Insurance quote line. She asks one short question at a time, in the same order every time, and spells back what she heard. She catches a bad license number or VIN on the spot. She pulls the driving record and tells you calmly when it disagrees with what you said. She gives you a six-month price with the one or two factors that drove it, then reads back an application number you can look up on the web. Ask her anything off-script and she hands you to Max's cell with a one-line summary. Behind the call, every quote has a database row with a full factor trace, and a τ-style eval suite proves she does it right every time, not just once.

## Out of Scope

Any real carrier's filed rates (synthetic NJ demo rates only, stamped DEMO). Binding coverage, payments, e-signature, policy issuance. Rating outside NJ, PA and MI (other callers are transferred). Michigan ZIP-to-city cross-checks (the caller's stated city is trusted). Collecting signed state forms (Michigan PIP selection, BI below 250/500) on the call; the specialist sends them with the application. Claims, billing, cancellations, endorsements on existing policies. Real MVR/CLUE vendor integrations (deterministic simulated vendor). Spanish-language flow (v2 candidate). Credit, occupation, education or income as rating inputs, ever.

## Principles

- Reliability is pass^k, not a good demo call. The database end state is what gets scored, never the transcript.
- On a phone line every word costs time. One question per turn, two sentences max, no filler.
- Verify at ingestion. Bad data is rejected the moment it enters (check digits, formats, plausibility), not discovered at rating.
- Explainable pricing. Every premium carries a factor trace and a rate-table version.
- When in doubt, hand the call to a human. A transfer is a success, not a failure.
- Rate on how you drive, not who you are.

## Constraints

- bun + TypeScript only (never npm/npx/python).
- No secrets or personal phone numbers in git. TRANSFER_NUMBER, tool secret and API keys come from env only.
- Private GitHub repo `MaxHarar/ai-native-voice-quote`.
- ElevenLabs Agents for STT, LLM orchestration and TTS. Telephony via a native Twilio import (Max provisions it).
- Agent defined as code (`agent/`), deployed by script via the ElevenLabs REST API. No click-ops drift.
- Webhook tools authenticated by a shared-secret header stored as an ElevenLabs workspace secret.
- One rating engine, deterministic and pure (same input ⇒ same premium), versioned rate table.
- SQLite (bun:sqlite) on a persistent volume. The same code path in tests and prod.

## Goal

A caller reaches the AI-Native Auto Insurance demo agent (voice Elise) and completes a standardized NJ auto quote: field-level verification, simulated MVR/CLUE/prior-insurance reports, a deterministic rating engine with a factor trace, and an application number persisted in SQLite and viewable at a quote-summary URL. Off-script requests transfer to Max's phone. Proven by `bun test`, a τ-style simulated-caller eval reporting pass^k on database end state, and a live call.

## Criteria

### Rating engine
- [x] ISC-1: `rate()` is pure. The same input produces byte-identical output across 100 runs (bun test).
- [x] ISC-2: Golden-file tests cover ≥6 personas (clean adult, young driver, points-heavy, multi-car, no prior insurance, high-value vehicle) with exact premiums.
- [x] ISC-3: Every quote result includes `rateTableVersion` and a per-coverage factor trace.
- [x] ISC-4: Premium increases monotonically with driving-record points (property test).
- [x] ISC-5: Higher liability limits never produce a lower premium (property test).
- [x] ISC-6: Territory derived from NJ ZIP prefix. A non-NJ ZIP is rejected with `OUT_OF_STATE`.
- [x] Anti: ISC-7: The rating input type has no credit, occupation, education or income field (grep over src/rating).

### Changelog

- 2026-10-15
  - conjectured: a 90% coverage threshold gates on overall coverage.
  - refuted by: CI failed at 93.9% overall; Bun applies the threshold per file, and new modules sat below it (and the release script would have failed the same way).
  - learned: Bun coverage thresholds are per file and count anonymous arrows as functions.
  - criterion now: ISC-84 gates ≥90% lines per file, function coverage held at a 60% baseline; network glue (S3 adapter) verified by live probes instead.
- 2026-10-15
  - conjectured: the smoke test could fall back to process.env for secrets.
  - refuted by: CI rejected a 14-character HMAC key; locally Bun had silently auto-loaded .env, so the smoke test was running with real production secrets.
  - learned: Bun loads .env from the working directory into every process, including spawned children.
  - criterion now: test servers run from an empty temp directory with fixed test secrets (hermetic), proven green in CI.
- 2026-10-15
  - conjectured: Railway buckets use the virtual-host URL style they report.
  - refuted by: a live put returned AccessDenied with virtual-host style and succeeded with path style.
  - learned: verify storage with a real round trip before production relies on it.
  - criterion now: ISC-80 includes a restore drill from the real bucket; BACKUP_VIRTUAL_HOSTED stays unset.

- 2026-10-15
  - conjectured: agent-level dynamic_variable_placeholders (eval_tag = "live") act as runtime defaults, so tools can bind a custom variable the eval harness supplies.
  - refuted by: every live call failed at start; ElevenLabs logged "Missing required dynamic variables in tools: {eval_tag}" (1008, agent_configuration_error) and Twilio logged 31921. Evals never caught it because they always supplied eval_tag.
  - learned: placeholders only feed the dashboard test UI; a live Twilio call carries only system__* variables. A deferred live-call ISC hid a launch-blocking bug, and a self-call test needs a second number (ElevenLabs rejects to == from).
  - criterion now: ISC-57 guard test in CI; live verification via a real WebSocket conversation plus a watched live call before declaring telephony done.

- 2026-10-15
  - conjectured: an LLM that reads a license number back correctly will pass the same string to the tool.
  - refuted by: decline-to-submit baseline trial; read-back "T, 5000, 0000, 0000, 05" was right but the tool received a different digit count twice, ending in a needless hand-off.
  - learned: the error enters when the LLM collapses spoken groups into one token run (long zero runs are a tokenization weak spot); verification must happen on what the server received, and the agent must see it.
  - criterion now: tools accept grouped input as read back, rejections echo the received value + digit count, policy tells the agent to self-correct; regression tests in test/api.test.ts.
- 2026-10-15
  - conjectured: a path assertion (typo must hit the check digit) makes the VIN-recovery eval stricter.
  - refuted by: vin-typo baseline trial; the simulated caller leaked the fix from its persona, the end state was correct, and the trial failed anyway.
  - learned: τ-style evals judge end state; persona text must not contain the answer the agent is supposed to find.
  - criterion now: ISC-43 end-state only; check-digit path recorded as a diagnostic (toolErrors).

## Verification at ingestion
- [x] ISC-8: VIN validator enforces the ISO 3779 check digit (bun test with real valid/invalid VINs).
- [x] ISC-9: VIN decode calls the NHTSA vPIC API and returns year/make/model (live curl through the tool endpoint).
- [x] ISC-10: VIN decode failure or timeout falls back to stated year/make/model without blocking the quote.
- [x] ISC-11: The NJ driver license validator enforces 1 letter + 14 digits; other states use a per-state regex table.
- [x] ISC-12: DOB validator rejects age <16 and >100 and future dates.
- [x] ISC-13: Stated make/model vs decoded VIN mismatch returns a `VERIFY_MISMATCH` the agent must resolve.

### Reports (simulated vendor)
- [x] ISC-14: `run_reports` returns MVR, CLUE and prior-insurance results deterministically keyed by license number.
- [x] ISC-15: An MVR violation not self-reported is added to rating and flagged `discrepancy: true`.
- [x] ISC-16: An MVR status of SUSPENDED/REVOKED sets eligibility to `REFER`.
- [x] ISC-17: Reports are persisted to the `reports` table with quote_id and timestamp.

### Underwriting + application
- [x] ISC-18: Eligibility rules (DUI ≤3y, ≥3 at-fault ≤3y, suspended, rideshare/commercial use, vehicle >30y) return `REFER` with a reason code.
- [x] ISC-19: `submit_application` refuses without `caller_confirmed: true` and leaves no applications row.
- [x] ISC-20: `submit_application` refuses when eligibility is `REFER`.
- [x] ISC-21: Application number has a Luhn check digit and is unique (UNIQUE constraint in the DB).
- [x] ISC-22: `GET /q/:appNumber` renders the quote summary (premium, coverages, factors, DEMO stamp) with a 200.
- [x] ISC-23: The quote summary masks the license number to its last 4 digits.

### API / tools
- [x] ISC-24: Every `/tools/*` endpoint returns 401 without the correct `x-tool-secret`.
- [x] ISC-25: Every tool validates its body with zod and returns `{ok:false,error,hint}`. It never throws a 500 on bad input.
- [x] ISC-26: Tool p95 latency is under 300ms locally (excluding NHTSA) per a bench script.
- [x] ISC-27: The full scripted flow (start → driver → vehicle → coverage → reports → rate → submit) passes as an HTTP integration test.
- [x] ISC-28: `/health` returns the version and DB status.
- [x] Anti: ISC-29: No full license number appears in server logs (grep after the integration run).

### Data
- [x] ISC-30: The schema migrates idempotently on boot (run twice, no error).
- [x] ISC-31: Tables quotes, drivers, vehicles, reports, applications and call_events exist with FKs on.
- [x] ISC-32: Every tool call appends a call_events row (conversation_id, tool, ok, ms).

### Agent (ElevenLabs)
- [x] ISC-33: `bun run agent:deploy` creates or updates the agent idempotently and prints its agent_id.
- [x] ISC-34: The deployed agent uses voice Lily (`pFZP5JQG7iQjIQuC4Bku`), verified via GET agent.
- [x] ISC-35: The deployed agent's LLM is a fast tier (haiku/flash class) with a backup LLM configured.
- [x] ISC-36: The first message includes the recording + AI + demo disclosure (PA is an all-party consent state).
- [x] ISC-37: The system prompt is `policy/quote-line-policy.md` verbatim plus voice style rules.
- [x] ISC-38: The transfer_to_number tool is configured with conditions, and the destination comes from env TRANSFER_NUMBER.
- [x] ISC-39: The end_call tool is configured.
- [x] Anti: ISC-40: The agent never asks for SSN, credit, income, occupation or education (eval check over transcripts).
- [x] Anti: ISC-41: The agent never states coverage is bound or active (eval check).

### Evals (τ-style)
- [x] ISC-42: The eval suite has ≥8 tasks: happy path, VIN typo recovery, MVR discrepancy, refer/DUI, out-of-state transfer, human-request transfer, decline-to-confirm, credit-question refusal.
- [x] ISC-43: Each task is judged on database end state (+ tool-call assertions), not the transcript.
- [x] ISC-44: The runner computes pass^k with the unbiased estimator (reuse the passk formula) and writes `evals/results/*.json`.
- [x] ISC-45: pass^1 ≥ 0.8 aggregate on the deployed agent, reported honestly per task.
- [x] ISC-46: The README reports the eval table with methodology disclosure.

### Telephony (iteration 2, needs Twilio)
- [x] ISC-47: The Twilio number is imported into ElevenLabs and assigned to the agent (list_phone_numbers shows it).
- [ ] [DEFERRED-VERIFY: live call by Max, loop iteration 2] ISC-48: A live inbound call completes a quote and produces an applications row.
- [x] ISC-49: A live "talk to a human" request rings TRANSFER_NUMBER.
- [x] ISC-57: Agent tools bind only system__* dynamic variables, and the prompt has no unresolved {{vars}} (test/agent-config.test.ts, control-probed).
- [x] ISC-58: Twilio voice dialing permissions allow low-risk US/Canada numbers (needed for the conference transfer leg); high-risk and toll-fraud stay disabled.

### Pennsylvania (loop iteration 2)
- [x] ISC-59: PA ZIP3 150–196 maps to PA territories; Philadelphia (191) is territory 1 and the most expensive.
- [x] ISC-60: PA state minimum is 15/30 BI, $5k PD, $5k first-party medical, with no COMP/COLL; PA rates MED, never PIP.
- [x] ISC-61: set_coverage refuses a PA quote without a tort election (TORT_OPTION_REQUIRED), per 75 Pa.C.S. § 1705(a)(4).
- [x] ISC-62: No tort election prices as full tort (§ 1705(a)(3)); limited < full; only BI and UM/UIM change.
- [x] ISC-63: UM/UIM stacking applies only with 2+ vehicles and costs more than unstacked (§ 1738 default).
- [x] ISC-64: NJ golden premiums are unchanged after the multi-state refactor (stored snapshot matches).
- [x] ISC-65: The migration adds state/tort_option to the live DB without losing rows.
- [x] ISC-66: The PA summary page shows the state, tort choice, first-party medical benefits, and no PIP.
- [x] ISC-67: The 3 PA eval tasks (pa-happy-path, pa-tort-default, pa-tort-advice) pass on the deployed agent.
- [x] Anti: ISC-68: The agent never recommends a tort option (pa-tort-advice transcript check).
- [x] ISC-69: quoteline.maxharar.com serves the app over valid HTTPS with noindex, and /ops returns 401 without login.

### Production hardening (loop iteration 3)
- [x] ISC-70: Production config fails fast without its required secrets and keys.
- [x] ISC-71: DOB, caller phone and email are AES-256-GCM ciphertext at rest in production.
- [x] ISC-72: Failed logins are throttled per IP, and every ops/admin request lands in an append-only access log.
- [x] ISC-73: CSP, HSTS and Permissions-Policy headers on every response; per-route body limits (32 KB; 5 MB webhooks).
- [x] ISC-74: SIGTERM shuts down gracefully with a WAL checkpoint.
- [x] ISC-75: /ready reflects database writability and draining; Railway's health check uses it.
- [x] ISC-76: HMAC-verified ElevenLabs post-call webhooks are ingested into the calls table.
- [ ] ISC-77: A live phone call's post-call webhook is recorded as a live call (pending the next live call; the first one predates activation).
- [x] ISC-78: Alerts route critical → Telegram + phone call, warning → Telegram, with cooldowns, quiet hours and a daily call cap.
- [ ] [DEFERRED-VERIFY: needs the principal's OK to place a test call] ISC-79: A critical alert rings the on-call cell.
- [x] ISC-80: Nightly and pre-release snapshots reach the S3 bucket, and a restore drill reproduces production data.
- [x] ISC-81: The retention job runs on schedule in dry-run mode and records its result.
- [x] ISC-82: The hourly external canary runs green from GitHub and its heartbeat arms the dead-man's switch.
- [x] ISC-83: Releases go through verify → backup → drain → deploy → ready check (auto-rollback) → canary → evals → tag.
- [x] ISC-84: CI gates on typecheck, ≥90% line coverage per file, hermetic real-server smoke, bun audit and a secret scan.
- [x] ISC-85: An executable agent↔server tool contract test runs in CI.
- [x] ISC-86: Load test (25 concurrent × 200 flows) holds p99 < 300 ms with zero errors and 200 unique applications.
- [x] ISC-87: The applicant's name is spelled back before every application, and the confirmed spelling is the name of record.
- [x] ISC-88: The ops console shows each call as a chat with tool calls, results and audio.
- [x] ISC-89: The call-start webhook recognizes a caller with an unfinished quote and returns the welcome-back override without leaking saved details.
- [x] ISC-90: resume_quote requires the caller's DOB, locks after 3 misses, is single-use, conversation-bound and expires in 30 minutes.
- [ ] ISC-91: A live returning call resumes a saved quote end to end (pending the principal's call).
- [x] Anti: ISC-92: No tool binds a non-system dynamic variable, and returning callers introduce no custom dynamic variables.
- [x] ISC-93: RUNBOOK, SECURITY (GLBA framing, PII inventory, known gaps) and ARCHITECTURE docs exist and match the system.
- [x] ISC-94: Only quotes with a saved primary driver are offered for resume; an unverifiable code never burns an attempt.
- [ ] ISC-95: After a caller turn fails to finalize, the agent re-engages within the turn timeout (retranscribe_on_turn_timeout + soft-timeout filler are live in the agent config; behavior pending the next occurrence on a live call).

### Michigan, voice, ops (loop iteration 4)
- [x] ISC-96: MI ZIP3 480-499 is recognized as Michigan and its territory comes from the garaging municipality, never the ZIP (MCL 500.2111(4)(f)); a MI start_quote without a city returns CITY_REQUIRED and writes no row.
- [x] ISC-97: normalizeMunicipality handles City of / Charter Township of / Twp / Saint / Mount / trailing MI, and unlisted municipalities rate in the fallback territory.
- [x] ISC-98: set_coverage refuses a MI quote without a PIP medical election (PIP_CHOICE_REQUIRED) and points the agent at unlimited as the no-choice default (MCL 500.3107c(4)).
- [x] ISC-99: Opt-out (Medicare A and B), $250k with the household excluded (non-Medicare coverage under the indexed $6,579 deductible cap) and $50k (Medicaid) return PIP_ELIGIBILITY_CHECK with server-owned eligibility and disclosure text, save nothing until pip_confirmed is true, and record pip_confirmed_at.
- [x] ISC-100: PIP medical factors order unlimited > 500k > 250k > 50k > excluded/opt-out, and only the PIP line moves.
- [x] ISC-101: The MCCA assessment is half the car-year amount per vehicle ($42 unlimited, $9.50 otherwise), is never discounted, and Michigan refuses to price outside the loaded period (RATES_UNAVAILABLE).
- [x] ISC-102: MI rates on age without an experience factor, gives the 65+ under-3,000-mile reduction only when both hold, and merit-rates minor violations only from dated record entries inside 2 years.
- [x] ISC-103: NJ and PA golden premiums are unchanged after the Michigan build.
- [x] ISC-104: The MI summary and ops pages show the garaging city, the PIP election (with confirmation time and the proof/form note when restricted), PPI and mini-tort rows, the MCCA line and the no-fault lawsuit note.
- [x] ISC-105: Every statutory fact the code uses (NJ, PA, MI) is verified against statute or regulator text and cited in docs/STATUTES.md.
- [x] ISC-106: The 4 MI eval tasks (mi-happy-path, mi-opt-out-medicare, mi-health-plan-exclusion, mi-pip-default) load in the runner and pass on the deployed agent (targeted runs; the full suite waits for the principal's go).
- [x] Anti: ISC-107: The agent never recommends a PIP medical level (mi-pip-default transcript check).
- [x] ISC-108: The agent speaks with voice Elise (EST9Ui6982FZPSi7gCHi) and introduces itself as Elise (verified via GET agent after release). Caroline was refused by ElevenLabs (live moderation); Elise was the principal's pick from allowed lookalikes.
- [x] ISC-109: The ops dashboard password is rotated to the principal's choice; the new one returns 200 and a wrong one 401 on /ops.
- [x] ISC-110: The UI defects found by the reproduction pass (including the call recording player) are fixed and re-verified in a real browser.
- [x] Anti: ISC-111: No background-noise or quiet-voice setting ships before the principal approves the plan.

### Quote quality (loop iteration 5: research additions #1 to #4)
- [x] ~~ISC-112: The deployed agent's `turn.turn_eagerness` is `patient`.~~ KILLED, refuted by the audio A/B (runs 20261015T062658/062701/062704 vs baseline 060028): stalled one-word lines over short-answers pstn+noise10 were patient 5, eager 6, normal 6, baseline 6, and the patient arm failed one task. Criterion now: eagerness stays `normal` (test/quality.test.ts).
- [x] ~~ISC-113: The `skip_turn` system tool is configured.~~ KILLED: in noise10 the agent called skip_turn on background noise ("Caller sent a filler sound"), went silent, and the call died in dead air (conv_4801m4z44h9yewtsxd09e2z4h6qy). Criterion now: no skip_turn tool; a filler-only turn gets "No rush." (test/quality.test.ts).
- [x] ISC-114: The policy tells the agent never to answer for the caller or move on after a filler-only or empty caller turn (the "Uh..." then "No..." defect from the 00:57 call); agent-config test asserts the rule is in the rendered prompt. (test/quality.test.ts "the policy forbids answering for the caller")
- [ ] [DEFERRED-VERIFY: first live phone call after release 9e5db71] ISC-115: Every post-call webhook stores a `call_metrics` row computed from the ElevenLabs transcript: caller turns, empty turns, very short turns, re-asks, unfinalized mid-call turns, interruptions, agent response latency p50/p90; unit test on a fixture transcript, plus a live row after the next call.
- [ ] [DEFERRED-VERIFY: Interceptor binary is v0.15.2 with a stale signature (gate needs 0.16+); re-verify after the Interceptor Update workflow] ISC-116: The ops console shows each call's metrics on its detail page and a rolling summary on /ops; verified in a real browser.
- [x] ISC-117: A live (non-test) call with an unfinalized mid-call turn, 3 or more re-asks, or p90 agent latency above 3 s sends one warning alert; unit test with a fake alerter. (test/call-metrics.test.ts "a live call that stalled ... one Telegram warning")
- [x] ISC-118: An audio eval runner streams synthesized caller audio over the Agent WebSocket under clean, PSTN (8 kHz mu-law round trip) and noise (SNR 10 dB) conditions and scores slot exact-match from the conversation's tool-call parameters; one run completes against the deployed agent and writes a results file. (evals/audio/, run 20261015T060028: 6/6 task success, 100% slots; DSP in TypeScript because Homebrew ffmpeg is broken)
- [x] ISC-119: The two real failure patterns (a dropped one-word answer; "Yes. Yes." after a digit read-back) exist as audio eval scripts. (evals/audio/scripts.ts short-answers, yes-after-readback; the latter dry-run only)
- [x] ISC-129: The turn config that ships stalls on one-word answers no more often than the production baseline: short-answers under pstn and noise10, stalled lines (9 s or more to the agent's first audio) at or below baseline run 20261015T060028 (6 stalled lines over those 2 calls; the transcript arrives on time and the agent waits out the 10 s turn timeout). (ships normal, same as production; normal arm 6 stalled lines = baseline 6; spelling_patience off 7, refuted too, run 20261015T063637)
- [x] ISC-120: `start_quote` stores a consent record for the conversation (disclosure version and timestamp); verified by SELECT. (test/quality.test.ts "start_quote records which disclosure")
- [x] ISC-121: A caller who declines recording is flagged `declined_recording`, told a licensed agent will call back, and the call ends; the ops console shows the decline. (test/quality.test.ts decline + ops consent tests)
- [x] Anti: ISC-122: After a recording decline the agent collects no further personal data (policy rule plus eval-checker assertion). (policy rule + evals/tasks.ts afterDecline, test/quality.test.ts)
- [x] ISC-123: Before any transfer the agent tells the caller the call is still being recorded (policy text, agent-config test). (test/quality.test.ts "the transfer line restates")
- [x] ISC-124: A Pennsylvania `get_quote` also returns the premium under the other tort option, the agent states it once, the application records that the signed tort form is still required, and the summary page shows both prices. (test/quality.test.ts PA tort tests)
- [x] ISC-125: docs/AI_GOVERNANCE.md maps the line to the NAIC AI model bulletin elements (inventory, testing, monitoring, vendor oversight, human oversight), with each state bulletin citation verified against a primary source or marked unverified. (docs/AI_GOVERNANCE.md; PA, MI, NJ bulletins and the NAIC model read on primary sources 2026-10-15; only PA states NAIC-model basis, in its press release)
- [x] ISC-126: A vehicle saved by year, make and model without a VIN is checked against vPIC's model list for that make and year; an unmatched model returns the closest matches for the agent to confirm, and a vPIC failure never blocks the save. (test/quality.test.ts vPIC model tests; live vPIC probe 2026-10-15)
- [x] Anti: ISC-127: NJ, PA and MI golden premiums are unchanged. (bun test 450 pass; test/__snapshots__ untouched; MI goldens in mi-rating.test.ts pass)
- [x] Anti: ISC-128: Nothing in this iteration reaches the production agent or server before the principal OKs the release. (principal: "ship it once the review is clean"; Max re-review CLEAN; released 9e5db71 after that)

### Delivery
- [x] ISC-50: Server deployed on Railway with a persistent volume, and `/health` is 200 over HTTPS.
- [x] ISC-51: The private GitHub repo exists and main is pushed (`gh repo view` shows visibility PRIVATE).
- [x] ISC-52: CI runs `bun test` on push and is green.
- [x] Anti: ISC-53: No secrets or phone numbers in the git history (gitleaks-style grep over `git log -p`).
- [x] ISC-54: The README documents architecture, setup and the env var list.
- [ ] Antecedent: ISC-55: The agent's average spoken turn is ≤2 sentences (eval transcript metric) — the precondition for "feels fast".
- [x] ISC-56: The quote summary page is verified via an Interceptor screenshot.

## Test Strategy

| isc | type | check | threshold | tool |
|---|---|---|---|---|
| 1-6,8,11-16,18-21,23-25,27,30-32 | unit/integration | bun test | all pass | `bun test` |
| 7,29,53 | anti | grep | 0 matches | `rg` |
| 9,10 | live | curl tool endpoint with real VIN and a bogus VIN | decoded / fallback | curl |
| 22,56 | UI | GET + screenshot | 200 + visible DEMO stamp | curl, Interceptor |
| 26 | perf | bench script | p95 < 300ms | `bun run bench` |
| 33-39 | config | GET agent JSON | fields match | ElevenLabs API |
| 40-45,55 | eval | simulate-conversation + DB end state | pass^1 ≥ 0.8 | `bun run eval` |
| 47-49 | live | phone call | row + ring | phone, SELECT |
| 50 | deploy | curl https health | 200 | curl |
| 51,52 | repo | gh repo view / gh run list | PRIVATE / success | gh |

## Features

| name | description | satisfies | depends_on | parallelizable |
|---|---|---|---|---|
| rating | Pure NJ demo rating engine + rate table + golden tests | 1-7 | — | yes |
| validate | VIN check digit, vPIC decode, DL/DOB/ZIP validators | 8-13 | — | yes |
| reports | Simulated MVR/CLUE/prior vendor + discrepancy merge | 14-17 | validate | yes |
| underwriting | Eligibility rules, application issue, Luhn numbers | 18-21 | rating, reports | no |
| db | bun:sqlite schema, migrations, repositories, event log | 30-32 | — | yes |
| api | Hono server, tool endpoints, auth, zod, summary page | 22-29 | all above | no |
| policy | quote-line-policy.md (τ-style) + voice rules | 36,37,40,41 | — | yes |
| agent | Agent-as-code deploy script (tools, voice, transfer, end_call) | 33-39 | api, policy | no |
| evals | τ-style tasks, simulate-conversation runner, pass^k | 42-46,55 | agent, deploy | no |
| deploy | Railway service + volume + env | 50 | api | no |
| repo | Private GitHub + CI + README + secret scan | 51-54 | all | no |
| telephony | Twilio import + live call + transfer | 47-49 | agent, Twilio creds | no |

## Decisions

- 2026-10-15: Iteration 5 released as 9e5db71. The pipeline aborted at eval smoke (happy-path failed: the simulated caller said "1, then twelve zeros, then 01", a 15-digit NJ license the server rightly rejected); a rerun went pass^2 1.00, so the release stayed live and was tagged by hand. Live probes: /health version 9e5db71; agent read-back normal eagerness, no skip_turn, new policy and declined_recording enum; RECORDING_DECLINED returned on a live start_quote after a decline.
- 2026-10-15: Iteration 5 second look (Max, fresh context): verdict "concerns". Adopted: (1) resumed calls now get a consent record; (2) the server refuses every collecting tool after a recording decline (RECORDING_DECLINED), so the decline no longer rests on the prompt; (3) the vPIC model check runs only without a VIN, because a slow VIN decode plus the model call could exceed the 4 s tool timeout; (4) response-delay samples count only after a finalized caller answer, so "No rush" waits don't page; (6) a live decline alerts "Callback owed"; (7) retention purges call_metrics. Deferred: (5) a decline eval task, since verifying that simulation transcripts carry `params_as_json` needs a paid eval run; (8) whether a mid-call decline should purge already-collected data is the principal's call.
- 2026-10-15: Iteration 5 learnings. (1) The "dead" ElevenLabs key was a stale `ELEVENLABS_API_KEY` exported by the shell, which Bun prefers over the repo `.env`; run repo scripts as `env -u ELEVENLABS_API_KEY bun ...`. (2) The Interceptor CLI on this machine is v0.15.2 with a stale signature (exit 137), below the 0.16 isolation gate, so browser checks (ISC-116) defer until the Interceptor Update workflow runs. (3) vPIC's model-list call missed a 1.5 s timeout on a cold cache, so it gets 3 s; VIN decode keeps 1.5 s. (4) Only Pennsylvania's own materials (its press release) say its AI bulletin is based on the NAIC model; Michigan's and New Jersey's track the model text without naming it, and docs/AI_GOVERNANCE.md says exactly that. (5) Consent is implied by continuing after the uninterruptible disclosure (stored per call with the disclosure hash); a decline ends the call with a callback, never a transfer, because a conference transfer keeps recording.
- 2026-10-15: Loop iteration 5. Principal: "go ahead with #1-3/4///2" after the deep-research report (reports/Voice quote line improvements.md); read as additions #1 to #4, not #5 (SMS follow-up waits on 10DLC). #4 re-scoped: VIN check digit, confusion correction and vPIC decode already existed (src/verify/vin.ts, vpic.ts; the research brief wrongly said otherwise), and the line collects no street address, so #4 becomes year/make/model validation against vPIC. Skipped from #1 with reason: per-turn interruption locks exist only for the first message in the agent config this repo deploys. Production release is gated on the principal's OK (ISC-128).
- 2026-10-15: Loop iteration 4 (principal: add Michigan with every rule pulled from statute; PIP opt-out "in a statute-legal way"; Caroline voice; dashboard password; UI bugs; plan, don't build, noise handling). Orchestrated as parallel workers on disjoint files against one contract (scratchpad/mi-contract.md). A forked SystemsThinking run spawned its own lanes under a different contract; two were stopped, its unapproved noise settings were reverted, and its useful findings (indexed QHC deductible, Medicare excluded from the $250k exclusion) were verified against primary sources and adopted.
- 2026-10-15: Michigan PIP eligibility is a server-owned two-step: the first set_coverage returns the eligibility and disclosure text, and nothing is saved until the agent confirms both with the caller (pip_confirmed). The legal election itself still happens on the DIFS form (MCL 500.3107e(2)); the specialist sends it.

- 2026-10-14: Telephony = Twilio native import (Max signs up). Rates = synthetic NJ demo. Voice = Lily (`pFZP5JQG7iQjIQuC4Bku`). Repo = private. (Principal answers via AskUserQuestion.)
- 2026-10-14: Forge/Cato unavailable. A live `codex exec` probe returns 400: "gpt-5.3-codex not supported when using Codex with a ChatGPT account". The Advisor is the independent verifier.
- 2026-10-14: Hosting = Railway (CLI authed) + bun:sqlite on a volume. A long-lived process has no cold starts on the voice path, and one DB code path serves tests and prod. Rejected Vercel + Postgres: cold starts add latency to every tool call, plus a second DB dialect.
- 2026-10-14: Standardized coverage packages (State Minimum / Recommended / Premium) instead of à-la-carte limits. Fewer turns on a phone call, and still rated per coverage.
- 2026-10-14: Gender is not a rating input (fairness thesis, and the regulatory trend). Age/experience are rating inputs.
- 2026-10-14: Telephony is split into loop iteration 2. Everything else is testable now via simulate-conversation and the web-call widget.
- 2026-10-14: Brand on the call is "AI-Native Auto Insurance"; project renamed ai-native-voice-quote; every former-employer reference removed from code, docs, git history (amended + force-pushed the single commit), GitHub repo name and Railway project (principal directive).
- 2026-10-14: Ops console + quote summaries behind Basic auth, noindex, on a hidden subdomain (naaif pattern). quoteline.maxharar.com registered on Railway; DNS is on Cloudflare and needs the principal to add CNAME + TXT (no Cloudflare credentials locally).
- 2026-10-15: refined: evals moved from the deprecated simulate-conversation endpoint (mocks tools with "Tool Called.", removal 2026-10-31) to agent-testing simulations with mocking_strategy none; per-trial tests with unique eval_tag + system__conversation_id (the simulator does not populate system variables).
- 2026-10-15: Caller ID backfilled into the ops console from ElevenLabs conversation metadata rather than bound as a tool dynamic variable: a missing system variable would fail the hand-off path, the most safety-critical one.
- 2026-10-15: Live incident (11:11 PM call): (1) resume offered a quote abandoned before any driver was saved, so the caller's correct DOB was reported as a mismatch twice; fixed by requiring a saved primary driver. (2) The agent went silent after "Yes. Yes." following a digit read-back; the caller turn never finalized (no ASR metrics), 1 of 12 phone calls. Kept spelling_patience (prevents mid-number interruptions), added retranscribe_on_turn_timeout and soft-timeout fillers. release-202610150342-98de5c3.
- 2026-10-15: Loop iteration 3 (principal: "fully flesh this out as if it were going into production"). Principal decisions: alerts via Telegram AND a phone call; production only (no staging); hourly canary, evals on releases only; no second Twilio number. Advisor-ordered build: CI first, DR before touching prod, release pipeline, outside-in detection, then reliability, webhooks, security, encryption (dual-read + snapshot-gated backfill), retention dry-run.
- 2026-10-15: Expand-then-contract releases. The server started requiring the confirmed applicant name, so the agent shipped first (the old server strips unknown fields); release-202610150148 used --agent-first.
- 2026-10-15: Transcripts are fetched from ElevenLabs on demand for the gated ops view and never stored (exclude_transcript at the source); ElevenLabs' 30-day retention governs them.
- 2026-10-15: Returning callers use a per-call first-message + prompt override from the call-start webhook, never dynamic variables (a missing variable stops a call from starting). Resume requires DOB because caller ID is spoofable. The override prompt is built from the same policy file as the agent's default (drift-tested).
- 2026-10-15: Engine API changed for multi-state (RatingInput.state required; PACKAGES → stateConfig). maxharar.com/insurance vendors this engine via scripts/sync-insurance-engine.ts and needs an adapter before its next sync.
- 2026-10-15: Loop iteration 2 (principal redirect: "add in pa as well"). One engine, per-state configs; NJ numbers untouched and proven by the NJ golden snapshot. PA rules verified against the statute text: § 1705(a)(3) no election = full tort, § 1705(a)(4) election required before issue, § 1738 stacking default absent a signed waiver. Stacked UM/UIM chosen as the quote default because waivers need a signature the phone line can't collect; the specialist handles waiver forms.
- 2026-10-15: Second live call: verification blocked 2 bad inputs and the requested transfer worked, but the agent narrated its own instruction on air. Chose leak-free over filler-free. Measured: "Thanks" openers 10% under the negative rule vs 26% with the positive rewrite; meta leaks 1 live → 0. Loop iteration 2 candidate: example-based turn style, A/B on Thanks%, meta leaks and sentences/turn. Added last-name spelling (ASR heard Harar as Ferrar).
- 2026-10-15: Live-call outage root-caused (custom eval_tag binding) and fixed in 04c0bce; server derives eval tags from sim_ conversation ids. Same probe exposed Twilio US outbound dialing disabled on the new account; enabled low-risk US/Canada only (transfer leg needs it).
- 2026-10-15: Twilio number purchase initially blocked by Trust Hub KYC; principal completed the Individual Profile; scripts/telephony.ts bought +1 609 798 6565 and imported it natively.


## Verification

- ISC-1–8,10–21,23–25,27–32 + regressions: `bun test` → 52 pass, 0 fail (2459 expects), CI green on e2ab62e.
- ISC-9: live `save_vehicle` with VIN 1HGCM82633A004352 → "2003 HONDA Accord", vin_verified true, 317 ms cold / 2 ms cached.
- ISC-26: `bun scripts/bench.ts` 240 calls → p95 0.7 ms local; prod ops console p50 5 ms / p95 14 ms.
- ISC-22/23/56: headless Chrome (Blink) screenshots of /q/ANA-6014211 and /ops: DEMO stamp, ••••0001 masking, brand "AI-Native Auto Insurance". Interceptor CLI SIGKILLed (exit 137) on this macOS build; used the skill-documented headless fallback.
- ISC-28/50: GET /health → {"ok":true,"version":"e2ab62e","db":"up"}, X-Robots-Tag noindex; baseline-eval row (00:22Z) survived the 00:26Z redeploy → volume persists.
- ISC-33–39: GET agent JSON: same agent_id across redeploys, 8 tools no dupes, voice pFZP5JQG7iQjIQuC4Bku, claude-haiku-5-5 + backups, uninterruptible disclosure first message, prompt === policy.md, end_call + transfer_to_number (conference, destination === env TRANSFER_NUMBER, masked +1******4887).
- ISC-40–46: `bun run eval` → baseline 20261015T002228 (10×2) pass^1 0.90 / pass^2 0.80; post-fix 20261015T002759 (10×3) pass^1/2/3 1.00, 0 prohibited asks, 0 binding claims, LLM-judge agreement 30/30.
- ISC-47: list_phone_numbers → +1 609 798 6565 assigned to the agent; Twilio voice_url = https://api.elevenlabs.io/twilio/inbound_call.
- ISC-51/53: gh repo view → PRIVATE MaxHarar/ai-native-voice-quote; `git log --all -p | grep -ic <former-employer>` → 0; staged-file secret/phone scans clean on every commit.
- ISC-49 (LIVE): Max called from his cell; conv_1601m4ygamz5egjtfq13vqb7ratd 70 s, PA ZIP 18947 → start_quote OUT_OF_STATE → flag_for_human → transfer_to_number; ElevenLabs termination "Call was transferred to number"; Twilio outbound-api leg to TRANSFER_NUMBER completed 19 s; DB row transferred/out_of_state; ops console backfilled caller ID.
- ISC-57: bun test test/agent-config.test.ts → pass; control probe re-adding the eval_tag binding → "tools bind only system__* dynamic variables" FAILS, revert → passes. Live tool configs scanned via API: 0 non-system bindings.
- ISC-58: GET voice.twilio.com/v1/DialingPermissions/Countries/US → low_risk true, high_risk_special false, toll_fraud false.
- Live-path fix: WebSocket conversation conv_7601m4yg6cj2fmpvgr39hngdebhg (system variables only) → status done, first message spoken, 24 audio chunks; eval subset 20261015T004331 3/3.
- Post-live-fix eval 20261015T005328 (10×2): pass^1/pass^2 1.00, 0 meta leaks; 63 unit tests incl. verbatim live-leak regression.
- ISC-59–66: bun test → 77 pass (test/pa.test.ts: PA goldens, tort, stacking, territories, HTTP flow, summary, migration on the pre-PA schema); live: server 0385922 migrated, prod row ANA-6014211 intact with state null (read as NJ); live set_coverage tool carries tort_option enum.
- ISC-67/68: eval 20261015T011135 (13 tasks × 2, incl. 3 PA) → 26/26, pass^1/pass^2 1.00; pa-tort-advice transcripts contain no tort recommendation.
- ISC-69: https://quoteline.maxharar.com/health → 200 {version 0385922}, Let's Encrypt cert CN=quoteline.maxharar.com (valid to 2027-01-13), X-Robots-Tag noindex, /ops → 401.
- ISC-70/84/85/86: 177 tests, coverage gate exit 0, CI green on 96873a9; smoke 21/21 hermetic; load test 25×200 p99 19.4 ms, 0 errors, 200/200 unique applications.
- ISC-71: fresh production snapshot after backfill: drivers.dob 82/82 ciphertext, quotes.caller_phone 4/4 ciphertext, 0 plaintext DOBs; server log "pii backfill drivers=79 quotes=4".
- ISC-76: Railway HTTP log "POST /webhooks/elevenlabs 200" ×2 (canary conversations) and app log "webhook kind=call test=true alerts=[]".
- ISC-80: POST /admin/backup → backups/quotes-2026-10-15T01-49-20-301Z.sqlite.gz (108 quotes, 55 applications, integrity ok); scripts/restore.ts from the bucket → integrity ok, same counts. Pre-release snapshots on every release since.
- ISC-82: GitHub Actions canary run 38668176659 → success ("canary ok"); ops heartbeat 2026-10-15 01:54 UTC.
- ISC-83: release-202610150148-a2cd689 (agent-first), release-202610150200-25e31d0, release-202610150203-96873a9: all verified, backed up, drained, canaried, tagged.
- ISC-87: eval name-correction (persona says "Harer", corrects at spell-back) → applicant_name "Max Harar" in 3 runs (20261015T014758, T015935 and the full-suite precursor).
- ISC-88: live call conv_5301m4ym258cegar6tzzm7vm57bb ops page → 68 chat turns, 10 tool lines, audio player.
- ISC-89: live probe as the …2393 caller (real data) → welcome-back first message, "## This call" section with a 6-char code, no saved details in the prompt; first-time probe → defaults; wrong secret → 401. Backfill hashed 4 older quotes.
- ISC-96-103: 394 tests green (test/mi-service.test.ts 17, test/mi-rating.test.ts 111 incl. 70/70 mutants killed, NJ/PA goldens unchanged, 6,000-input differential fuzz 0 NJ/PA diffs); hermetic smoke incl. 5 Michigan checks passed in every release verify; CI green on 9bacdce.
- ISC-104: test/mi-display.test.ts 31 tests (city, PIP election, proof/form notes, PPI and mini-tort rows, MCCA line, lawsuit note).
- ISC-105: docs/STATUTES.md cites every NJ/PA/MI rule with enforcement location and test; citations checked against the verified fact list (contract rev 2).
- ISC-106/107: eval run 20261015T045507 on the deployed agent: mi-happy-path, mi-opt-out-medicare, mi-health-plan-exclusion, mi-pip-default all PASS (pass^1 1.00, judge agreement 1.00, 1.81 sentences/turn); mi-pip-default's no-recommendation check passed.
- ISC-108: GET agent after release-202610150454-dddbe93: voice_id EST9Ui6982FZPSi7gCHi, first message "this is Elise, a virtual assistant". Caroline was refused at deploy (400 voice_live_moderated_not_allowed).
- ISC-109: /ops with the new password 200, wrong password 401 (live, version 01abcca at change time).
- ISC-110: headless Chrome over CDP (Interceptor exits 137), 1440 and 390 phone, light and dark, on dddbe93: audio 200 with Content-Length and Accept-Ranges, Range 206 / 416 correct, security headers present, player reads 0:00 / 2:01 before play and cold seeks stick (318 ms at 150 KB/s); dark native player; failed tools show red; one access-log row per request; "None yet.", 92% phone bubbles, readable eligibility, "incomplete" pill, favicon 204; spoken-digit runs in 8 live transcripts 7 → 0; 0 console errors, 0 CSP violations, no horizontal scroll. Nits left open: the "incomplete" pill has no muted CSS rule; old transcripts label agent turns with the current persona name.
- ISC-111: GET agent shows vad.background_voice_detection false and no interruption_ignore_terms; the noise plan awaits approval.
- ISC-55 MISSED: mean 2.03 sentences/agent turn vs ≤2.0 target (was 2.26); residual is the mandatory read-back turn.

