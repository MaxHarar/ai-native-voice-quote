# Security and privacy

How the quote line protects caller data. In a real carrier deployment, the data collected here is nonpublic personal information under the Gramm-Leach-Bliley Act, so this document is organized around the FTC Safeguards Rule's expectations: know what you hold, limit who can reach it, encrypt it, log access, keep it only as long as needed, and monitor.

## What we hold

| Data | Where | Protection | Retention |
|---|---|---|---|
| Name (caller, drivers) | SQLite `quotes`, `drivers`, `applications` | Access-controlled ops console | 30 days |
| Date of birth | SQLite `drivers.dob` | **AES-256-GCM field encryption** | 30 days |
| Caller phone number | SQLite `quotes.caller_phone`, `calls.caller_phone` | **AES-256-GCM field encryption** | 30 days |
| Email (optional) | SQLite `applications.email` | **AES-256-GCM field encryption** | 30 days |
| Driver license number | Never stored | Used once to order reports, then kept only as an **HMAC** plus the last 4 digits | n/a |
| Driving record, claims, prior insurance | SQLite `reports` (simulated vendor in this demo) | Access-controlled | 30 days |
| VIN decode cache (VIN to year, make, model; no caller link) | SQLite `vin_cache` | Access-controlled | 30 days |
| Call outcomes and evaluation results | SQLite `calls` | No transcripts stored (`exclude_transcript` at the source) | 30 days |
| Transcripts and audio | ElevenLabs (processor) | Fetched on demand into the gated ops view; never copied into our database | ElevenLabs agent setting: 30 days |
| Snapshots | Backup bucket | Gzipped database (PII fields already encrypted) | 14 days, so a purged row can survive in a backup for up to 14 more days |
| Logs | Railway | Tool name, outcome and latency only; digit runs masked in error messages | Railway's log retention |

We deliberately never ask for or store Social Security numbers, credit, income, occupation, education, marital status, or gender. Rating uses driving record, experience, vehicle, garaging and coverage. An eval anti-criterion fails any trial in which the agent asks for those fields.

## Data flow

```
Caller ──PSTN──▶ Twilio ──▶ ElevenLabs (speech-to-text, LLM, text-to-speech; recording disclosed in the first message)
                               │  HTTPS + x-tool-secret
                               ▼
                           quote-line server (Railway, single instance) ──▶ SQLite on encrypted-at-rest fields
                               │                                         └──▶ nightly snapshot → backup bucket
                               ▼
                           ops console (Basic auth, audited)  ◀── ElevenLabs post-call webhook (HMAC-signed)
```

## Controls

- **In transit.** TLS everywhere (Let's Encrypt on `quoteline.maxharar.com`, HSTS). Tool calls carry a shared secret stored as an ElevenLabs workspace secret; comparison is constant-time; a second secret is accepted during rotation.
- **At rest.** Field-level AES-256-GCM with per-value IVs and authenticated tags. A key id in every ciphertext supports rotation without downtime. License numbers are one-way HMACs.
- **Access.** The ops console and quote summaries require Basic auth over TLS, fail closed when unconfigured, and throttle credential guessing (20 failures per IP per 15 minutes, then 429). Admin endpoints use a separate secret with the same throttle. Every request to them is written to an append-only access log, shown in the console.
- **Webhook integrity.** ElevenLabs webhooks are verified with HMAC-SHA256 over the timestamped body; signatures older than 30 minutes are rejected; processing is idempotent by conversation id.
- **Abuse limits.** 32 KB request bodies (5 MB for webhooks); 300 tool calls per conversation per 10 minutes. Limits are per conversation because ElevenLabs shares egress IPs across customers.
- **Fail-fast configuration.** In production the process refuses to start without its secrets and encryption key.
- **Retention.** Automated purge (30 days live, 7 days test), shipped in dry-run mode first.
- **Monitoring.** Hourly external canary, server-side dead-man's switch for the canary itself, alerts on failed or unconnected live calls, policy-check failures and tool-error spikes.
- **Secure development.** Every push runs typecheck, unit/contract/integration tests with a coverage gate, a real-server smoke test, a dependency audit and a secret/phone-number scan. Releases go through a script that backs up first and rolls back automatically.
- **Consent and disclosure.** The first message discloses recording and that Elise is a virtual assistant, and cannot be interrupted (Pennsylvania is an all-party-consent state). An eval anti-criterion checks this on every trial.

## Threats considered

| Threat | Mitigation |
|---|---|
| Someone calls the tool endpoints directly | Shared secret, constant-time comparison, rate limits, input validation on every field |
| Forged or replayed webhooks | HMAC verification, timestamp tolerance, idempotent upserts |
| Brute-forcing the ops console | Per-IP failure throttle, audit log, TLS only |
| Caller prompt-injects the agent | The server validates everything; tools can only write the caller's own quote; nothing exposes other callers' data; policy forbids revealing instructions |
| Caller ID spoofing (returning-caller resume) | Resuming a saved quote requires the caller's date of birth; codes are single-use, bound to the call, and expire in 30 minutes. Lockout: 3 date-of-birth misses per calling number within 30 days (a verified resume resets that count), and 3 per saved quote over its lifetime, whichever comes first; a locked number is treated as a new caller and ops sees `resume_locked` in the call-start log. Nothing is revealed before verification |
| The agent promises coverage or asks prohibited questions | Policy, eval anti-criteria on every trial, ElevenLabs post-call evaluation with alerts on live calls |
| PII in logs | Logs carry no request bodies; error messages are digit-masked |
| Vulnerable dependencies | `bun audit` in CI; two runtime dependencies (hono, zod) |

## Known gaps and accepted risks (demo scope)

- **No SSO or MFA on the ops console.** Basic auth over TLS with throttling and auditing. For a real deployment, put the host behind Cloudflare Access or similar.
- **Single instance.** No high availability; a deploy briefly stops the server (the release script waits for calls to end first). A failure leaves Elise answering but unable to quote; she offers a human.
- **Keys in environment variables.** No KMS or HSM; Railway variables are the secret store.
- **Container runs as root.** Railway volumes mount root-owned; dropping privileges is a follow-up.
- **Processors.** Twilio and ElevenLabs see call audio and transcripts. A real carrier needs data processing agreements and to set their retention to policy.
- **Synthetic rates and simulated reports.** No real MVR/CLUE vendor or filed rates; those integrations carry their own FCRA permissible-purpose and adverse-action obligations.
