# Runbook

Operating the AI-Native Voice Quote line in production.

## What runs where

| Piece | Where | Notes |
|---|---|---|
| Phone number | Twilio, local 609 number | Imported natively into ElevenLabs; voice webhook is ElevenLabs' inbound endpoint |
| Voice agent "Elise" | ElevenLabs Agents | Defined in `agent/`; deployed with `bun agent/deploy.ts`; `agent/deployed.json` holds the ids |
| Server | Railway project `ai-native-voice-quote`, service `quote-line` | One instance; SQLite on the `/data` volume; health check `/ready` |
| Ops console | `https://quoteline.maxharar.com/ops` | Basic auth (`OPS_USER` / `OPS_PASSWORD`); every request audited |
| Backups | S3-compatible bucket (Railway) | Nightly plus before every release; 14-day retention |
| Canary | GitHub Actions `canary` workflow, hourly | Health, readiness, agent first message, heartbeat |
| Alerts | Telegram (all) and a phone call to the on-call cell (critical) | Quiet hours 22:00–07:00 New York hold the phone call; Telegram still goes out |

## Releasing

```bash
bun scripts/release.ts                # server first, then agent
bun scripts/release.ts --agent-first  # when the server starts REQUIRING something the old agent doesn't send
```

The script refuses to run on a dirty or unpushed tree, then: typecheck, tests with the coverage gate, real-server smoke, a pre-deploy backup, a drain wait (no call in progress), deploy, verification that the new version is live and ready (automatic rollback to the previous deployment if not), the canary, a 4-task eval smoke (plus non-blocking watched tasks), and a git tag `release-<timestamp>-<sha>`.

A blocking eval that fails is re-run once, alone: release 936ef62's failure (2026-10-20) was a flake whose `start_quote` never reached the server, and it passed 2/2 on rerun. If it fails again, or the canary fails, the script rolls back by itself: it redeploys the previous agent config (the commit recorded as `git_sha` in `agent/deployed.json`, else the latest release tag) from a throwaway git worktree, then rolls the server back to the previous Railway deployment, sends a `release` alert, and exits non-zero. Agent first, because the contract test only proves the old agent works against the new server. Before this, 936ef62 printed the rollback command and left the new build live and untagged.

Order matters when a contract changes. **Expand, then contract:** the receiving side must accept the new shape before the sending side starts using it. The old server ignores unknown fields (zod strips them), so a new agent parameter can ship agent-first; a new required server field must wait until the agent sends it.

## Rolling back

```bash
bun scripts/release.ts --rollback <railway-deployment-id>   # server
git checkout <previous-release-tag> -- agent policy && bun agent/deploy.ts && git checkout HEAD -- agent policy   # agent
```

Deployment ids: `railway deployment list --service quote-line`. The release script rolls back by itself when the canary or a blocking eval fails after deploy. Use these commands only when its alert says `rollback INCOMPLETE`.

## Testing notes

- **Bun in-process body bug.** After ~9k `app.request()` calls in one `bun test` process (Bun 1.3.x with `hono/body-limit`), every request body arrives empty ("undefined is not a function") for the rest of the process, so unrelated test files fail too. A real socket is not affected. `test/model.test.ts` uses a real `Bun.serve` socket by default (`MODEL_INPROCESS=1` to opt out) and caches its price baselines. If many suites suddenly fail on empty or invalid bodies, suspect the request count first: raising `MODEL_RUNS` in-process is the usual trigger.
- **One clock.** `created_at` on quotes, call bindings, resume codes and applications is stamped from the service's injected `now()`, so pinned-clock tests are deterministic (`test/clock.test.ts`). Backdate rows with `UPDATE ... created_at` only when a test is about the window itself.

## Alerts and first moves

| Alert | Meaning | First moves |
|---|---|---|
| `canary` (critical) | The public URL, readiness, or the agent's first message failed twice | Open `/health` and `/ready`; check Railway deploy status; open a WebSocket probe (`bun scripts/canary.ts`); check ElevenLabs agent config |
| `call_failed` (critical) | A live call ended with status `failed` | Open the call in `/ops`; the error is ElevenLabs' (e.g. a missing dynamic variable or bad tool schema). Roll back the agent if a release just shipped |
| `initiation_failure` (critical; warning if busy/no-answer) | A call never connected | Twilio console → Monitor → Alerts; check voice geo permissions; check the number is still assigned to the agent |
| `policy:*` (warning) | ElevenLabs' post-call evaluation flagged a live call (prohibited question, binding claim, submit without read-back) | Read the transcript in `/ops`; add an eval task that reproduces it before fixing the policy |
| `tool_errors` (critical) | 5+ internal/timeout/rate-limit tool errors in 15 minutes | Railway logs (`railway logs --service quote-line`), `/ready`, disk on the volume |
| `canary_silent` (warning) | The server hasn't heard from the canary in 3 hours | GitHub disables scheduled workflows after 60 days without repo activity: re-enable it in the Actions tab |
| `backup_failed` (warning) | The nightly snapshot failed | Check bucket credentials in Railway variables; run `POST /admin/backup` by hand |
| `release` (warning; critical if the rollback was incomplete) | A release aborted after deploying and rolled itself back | Read the alert detail. `rollback INCOMPLETE` names the failed step: finish it with the commands under Rolling back |

## Incidents seen so far (and their guards)

| Incident | Root cause | Guard now in place |
|---|---|---|
| Every live call hung up instantly | A tool bound a custom dynamic variable that phone calls never carry | `test/agent-config.test.ts` fails CI if a tool binds anything but `system__*` |
| Transfers would have failed | New Twilio account had US outbound dialing disabled | Documented below; canary + `initiation_failure` alerts |
| Root URL downloaded a file | Headers set after the handler stripped the content type | Real-server smoke asserts content types on every route |
| Agent narrated its own instruction on air | A negative instruction primed the word it banned | Global eval anti-criterion for meta leaks |
| Names misheard ("Harar" → "Ferrar") | Speech recognition | Letter-by-letter spell-back before every application; confirmed spelling is the name of record |

## Restore

Drill (safe, any time):

```bash
bun scripts/restore.ts            # newest snapshot → restored.sqlite, verified
bun scripts/restore.ts backups/quotes-<timestamp>.sqlite.gz
```

Production restore (data loss or corruption):

1. Run the drill to get a verified `restored.sqlite`.
2. Stop traffic: `railway down --service quote-line` (calls still reach Elise, but tools fail and she offers a human).
3. Replace `/data/quotes.sqlite` on the volume with the restored file (Railway volume file manager or `railway ssh`), and delete any `-wal`/`-shm` files next to it.
4. Redeploy: `bun scripts/release.ts --skip-drain`.
5. Verify `/ready`, open `/ops`, run the canary.

## Rotating secrets

| Secret | Procedure |
|---|---|
| `TOOL_SECRET` | Set `TOOL_SECRET_PREVIOUS` = old and `TOOL_SECRET` = new in Railway; deploy the server; run `bun agent/deploy.ts` (updates the ElevenLabs workspace secret); then remove `TOOL_SECRET_PREVIOUS` |
| `ELEVENLABS_WEBHOOK_SECRET` | Create a new workspace webhook in ElevenLabs; set the old value as `ELEVENLABS_WEBHOOK_SECRET_PREVIOUS` and the new as `ELEVENLABS_WEBHOOK_SECRET`; deploy; point ConvAI settings at the new webhook; remove the previous value after a day |
| `DATA_ENCRYPTION_KEY` | Set `DATA_ENCRYPTION_KEY_PREVIOUS` = old, `DATA_ENCRYPTION_KEY` = new; deploy. New writes use the new key; old rows still decrypt. Keep the previous key until every row has been rewritten or purged by retention (30 days) |
| `OPS_PASSWORD`, `ADMIN_SECRET`, `CANARY_SECRET` | Change in Railway (and GitHub Actions secrets for `CANARY_SECRET`); deploy |
| Twilio auth token / API key | Rotate in the Twilio console; update Railway variables, local `.env`, and GitHub Actions secrets |

## Retention

`RETENTION_MODE` starts as `dry-run`: the job logs what it would delete every 6 hours (visible in `/ops` → System and in Railway logs). After reviewing a few runs, set `RETENTION_MODE=enforce`. Windows: 30 days for live data, 7 days for eval/canary data. Backups hold snapshots for 14 more days.

## Telephony settings that must stay on

- Twilio → Voice → Geo permissions: **United States/Canada low-risk numbers enabled** (the transfer to a licensed agent is an outbound leg). High-risk and toll-fraud stay off.
- Twilio Trust Hub primary customer profile: approved (required to own US numbers).
- The number's voice webhook: `https://api.elevenlabs.io/twilio/inbound_call` (set by the ElevenLabs import; re-run `bun scripts/telephony.ts` to repair).

## Returning callers

When someone calls from a number that has an unfinished quote (priced or in progress, not applied, last 30 days), ElevenLabs' call-start webhook (`POST /webhooks/elevenlabs/initiation`) returns a welcome-back first message and a prompt section holding a single-use resume code. Elise asks whether to continue or start over; continuing requires the caller's date of birth (caller ID can be faked), with three attempts and a 30-minute code lifetime. Nothing about the saved quote is revealed before verification.

- **Kill switch:** `RETURNING_CALLERS=0 bun agent/deploy.ts && RETURNING_CALLERS=0 bun scripts/configure-elevenlabs.ts` turns the feature off at both the agent and the workspace.
- **Fail-safe:** the endpoint answers 200 with the agent's defaults on any error, malformed body, or unknown caller. What ElevenLabs does if the endpoint is unreachable is undocumented, so if the server is down for long, flip the kill switch.
- **Configure or repair:** `bun scripts/configure-elevenlabs.ts` (idempotent; needs `INITIATION_SECRET` and `ELEVENLABS_WEBHOOK_ID` in `.env`).

## Michigan

### MCCA amounts expire 2027-06-30

Every Michigan price includes the Michigan Catastrophic Claims Association (MCCA) assessment, read from `MI.mcca` in `src/rating/rateTable.ts`: $84 per car-year with unlimited PIP and $19 with any other PIP option, for policies effective 2026-07-01 through 2027-06-30. After 2027-06-30 the server will not price Michigan: `get_quote` returns `RATES_UNAVAILABLE` and the agent hands the caller to a licensed agent with reason `other`. Nothing alerts on it, because the `tool_errors` alert counts only `INTERNAL`, `TIMEOUT` and `RATE_LIMITED`. Put the date on a calendar.

Before July 1, 2027:

1. Get the MCCA's new assessment notice for policies effective from 2027-07-01 (the current amounts came from the MCCA notice distributed through AAIS).
2. In `src/rating/rateTable.ts`, update `MI.mcca`: `unlimited`, `other`, `from` and `through`. Bump `MI.rateTableVersion` so each quote shows which table priced it.
3. Review `MI.qhcMaxDeductible` alongside the MCCA amounts every July 1. It is the highest annual deductible that still counts as qualified health coverage ($6,579 through 2027-06-30; the statute base is $6,000, indexed each July 1, and DIFS publishes the figure). The agent's opt-out and household-exclusion eligibility sentences read it from config.
4. Update what pins the old numbers: `test/mi-rating.test.ts` and `test/mi-service.test.ts` (the $42 and $9.50 six-month amounts, the period edges and the 6,579 sentence) and the MCCA and QHC rows in `docs/STATUTES.md`.
5. Run `bunx tsc --noEmit -p .` and `bun test --coverage`, then `bun scripts/release.ts`.

The config holds one period, so a new period takes effect the moment it ships. A Michigan quote dated before the new `from` is refused, and so is one dated after the old `through` until the new config is live. The check compares the UTC calendar date, so `through: "2027-06-30"` ends at 7:59 PM New York time on June 30. Expect a short gap whichever way you time the release, and pick the moment with the fewest live calls. If a gap is not acceptable, change `mcca` to a list of periods first.

### Seeing a quote's PIP election

Open the quote from `/ops` (`/ops/quote/:id`). Under the header, a **PIP medical** line shows the election. For an opt out, a household exclusion or the $50,000 level it adds "eligibility and disclosure confirmed" with the UTC time the choice was saved (`quotes.pip_confirmed_at`), or "time not recorded" in a warning color if that is missing. The header also shows the garaging city and territory. `/q/:application` shows the same election on the customer summary.

The evidence that the question was asked and the disclosure read is further down the page:

- **Conversation** (live calls). Each `set_coverage` call appears with the arguments the agent sent (`pip_medical=opt_out, pip_confirmed=true`), and the transcript above it shows what was said.
- **Tool timeline.** A restricted choice shows two `set_coverage` rows: the first with `PIP_ELIGIBILITY_CHECK`, the second `ok`.

The stored values are `quotes.pip_medical`, `quotes.pip_confirmed_at` (set only for opt out, household exclusion and $50,000) and `quotes.garaging_city`. A resumed quote keeps all three.

### Releasing the Michigan change

The server now requires `garaging_city` for Michigan ZIPs and a PIP medical choice for Michigan quotes, and the previous agent cannot send either. Release with `bun scripts/release.ts --agent-first`. Until the server ships, Michigan callers are handed off as out of state.
