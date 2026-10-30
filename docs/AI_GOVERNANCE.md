# AI governance

How the quote line lines up with the AI-system guidance New Jersey, Pennsylvania and Michigan regulators have issued to insurers. Those bulletins bind licensed insurers, not a demo line, so this file is a readiness record: what a carrier partner's AI program would ask about, what this line already does, and where the gaps are. It is not legal advice.

## The guidance

All three states issued bulletins whose text substantively tracks the NAIC Model Bulletin "Use of Artificial Intelligence Systems by Insurers" (adopted by the NAIC December 4, 2023). Each was read on the regulator's own site on 2026-10-15.

| State | Document | Date | Source |
|---|---|---|---|
| Pennsylvania | Insurance Department Notice 2024-04, "Use of Artificial Intelligence Systems by Insurers" (54 Pa.B. 1910) | Published April 6, 2024 | [Pennsylvania Bulletin](https://www.pacodeandbulletin.gov/Display/pabull?file=/secure/pabulletin/data/vol54/54-14/484.html); the department's [April 9, 2024 release](https://www.pa.gov/agencies/insurance/newsroom/shapiro-administration-issues-guidance-on-insurers-use-of-artificial-intelligence-ai) says it is based on the NAIC model bulletin |
| Michigan | DIFS Bulletin 2024-20-INS, "Use of Artificial Intelligence Systems by Insurers" | Issued August 7, 2024 | [DIFS PDF](https://www.michigan.gov/difs/-/media/Project/Websites/difs/Bulletins/2024/Bulletin_2024-20-INS.pdf) |
| New Jersey | DOBI Bulletin No. 25-03, "The Use of Artificial Intelligence Systems in Insurance" | February 11, 2025 | [DOBI PDF](https://nj.gov/dobi/bulletins/blt25_03.pdf) |
| (model) | NAIC Model Bulletin, Use of Artificial Intelligence Systems by Insurers | December 4, 2023 | [NAIC PDF](https://content.naic.org/sites/default/files/inline-files/2023-12-4%20Model%20Bulletin_Adopted_0.pdf) |

The Michigan and New Jersey bulletins don't name the NAIC model bulletin in their own text; they match its structure (an "AIS Program", the same four sections). Pennsylvania's notice says its guidelines are not intended to be binding.

## AI systems in this line

| System | What it does | Decides anything about the caller? |
|---|---|---|
| ElevenLabs Agents: speech recognition (`scribe_realtime`), text to speech, turn detection | Hears and speaks on the call | No |
| Conversation LLM (`claude-haiku-5-5`, backups `gemini-3.5-flash`, `gpt-5.4-mini`; see `agent/config.ts`) | Runs the conversation and calls the tools | No. It collects answers; the server validates every value |
| ElevenLabs post-call LLM evaluation (`EVALUATION_CRITERIA`) | Grades each call against policy checks | No. Monitoring only |
| Rating engine (`src/rating/`) | Prices the quote | Yes, but it is deterministic code with versioned rate tables, not an AI system |
| Underwriting rules (`src/underwriting/`) | Accepts or refers to a human | Yes, deterministic rules; a referral always goes to a licensed person |

The design choice that carries most of the weight: no AI system prices, underwrites or binds. The LLM can't change a premium, and nothing is bound on the call; a licensed specialist finalizes every application.

## Model bulletin elements, mapped

| NAIC section | Expectation | What the line does | Evidence |
|---|---|---|---|
| 1.9 | Notice to consumers that AI is in use | Every call opens, uninterruptible, with "a virtual assistant" and "this call is recorded"; the agent offers a licensed agent if asked whether it's a person | `agent/config.ts` `FIRST_MESSAGE`, `src/disclosure.ts`, `test/quality.test.ts` |
| 1.4, 3.1 | Controls on automation, proportionate to potential harm | Prices only from `get_quote`; read-back and explicit yes before submit; quote hash invalidates on any change; hand-off rules for advice, disputes, referrals | `policy/quote-line-policy.md`, `src/service.ts`, eval anti-criteria in `evals/tasks.ts` |
| 2.1, 2.2 | Written policies and documentation | Agent policy as code; the ISA as the state of record; every change in git | `policy/`, `ISA.md`, `git log` |
| 2.3 | Accountability and escalation | One accountable owner (the principal); live alerts by Telegram and phone call; transfers to a licensed person | `src/ops/alerts.ts`, `docs/RUNBOOK.md` |
| 3.2 | Data practices, bias minimization | Never asks for credit, SSN, income, occupation, education or marital status; rating factors are driving record, experience, age, vehicle, garaging and coverage | `docs/SECURITY.md`, eval `no_prohibited_questions` |
| 3.4 | Validation and testing | Unit and contract tests with golden premium snapshots per state; τ-style simulated-caller evals at pass^k; audio evals under phone-line and noise conditions | `test/`, `evals/run.ts`, `evals/audio/` |
| 1.7, 3.3 | Ongoing monitoring and drift | Per-call quality metrics (empty and unfinalized turns, re-asks, stalls, response delay) with warning thresholds; policy evaluation on every call; hourly canary | `src/ops/callMetrics.ts`, `src/server/webhooks.ts`, `scripts/canary.ts` |
| 3.5 | Protection of nonpublic information | Field encryption for DOB, phone and email; license numbers kept only as an HMAC plus last 4; digit masking in logs and the ops view | `docs/SECURITY.md`, `src/security/crypto.ts`, `src/server/transcript.ts` |
| 3.6 | Data and record retention | 30-day retention in the database and at ElevenLabs; recording consent record per call | `src/ops/retention.ts`, `quotes.consent_*` columns |
| 4.0 | Third-party AI systems and data | Vendors: ElevenLabs (speech, agent runtime, recordings), Anthropic, Google and OpenAI (LLMs), Twilio (telephony), Railway (hosting), NHTSA vPIC (vehicle data, not AI) | This file |

## Gaps a carrier would ask about

- **Unfair-discrimination testing.** The rating engine uses age, and there's no disparate-impact analysis of the rate tables or of speech-recognition accuracy across accents. The audio evals are the starting point for the second.
- **Vendor contracts.** No data-processing agreements, audit rights or regulator-cooperation terms with the vendors above (NAIC 4.2). These are standard vendor terms only.
- **Governance structure.** A one-person demo has no committee, independent review or board reporting (NAIC 1.3, 2.3). A carrier deployment would place the line inside the carrier's existing AIS Program.
- **Consumer access to information.** Callers are told AI is in use, but there's no notice explaining how it's used or how to ask for a human review after the call (NAIC 1.9).
- **Producer licensing.** Before real consumers call, the line must run under a licensed agency, with the AI limited to indicative quotes and licensed people handling advice and binding.
