#!/usr/bin/env bun
// Production release, one command:
//   1. preconditions: clean tree, on main, pushed
//   2. verify: typecheck, tests (coverage gate), black-box smoke
//   3. pre-deploy backup (off-box snapshot) — the restore point for this release
//   4. drain: wait until no live call is in progress (a volume-backed deploy briefly stops the server)
//   5. deploy agent and/or server (agent first when the server tightens a contract the old agent can't meet)
//   6. verify the new server version is live and ready; auto-rollback to the previous deployment if not
//   7. canary + eval smoke against production; a failing blocking eval is retried once, then the release is rolled
//      back automatically (previous agent config, then previous server deployment), alerted, and exits non-zero
//   8. tag the release
//
// Usage: bun scripts/release.ts [--agent-first] [--no-agent] [--skip-evals] [--skip-drain]
//        bun scripts/release.ts --rollback <railway-deployment-id>

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { alertFromEnv } from "./alert";
import { evalGate, failedTasks, previousAgentRef, type TaskResult } from "./releaseGate";
import { PROMOTE_AFTER, recordWatched, type WatchHistory } from "./watchHistory";

const { values: args } = parseArgs({
  options: {
    "agent-first": { type: "boolean", default: false },
    "no-agent": { type: "boolean", default: false },
    "skip-evals": { type: "boolean", default: false },
    "skip-drain": { type: "boolean", default: false },
    // Bootstrap only: the first release of the backup endpoint itself has nothing to call yet.
    "skip-backup": { type: "boolean", default: false },
    rollback: { type: "string" },
  },
});

const BASE = (process.env.PUBLIC_BASE_URL ?? "https://quoteline.maxharar.com").replace(/\/$/, "");
const SERVICE = "quote-line";
const ROOT = new URL("..", import.meta.url).pathname;

function step(msg: string) {
  console.log(`\n▸ ${msg}`);
}
function run(cmd: string[], opts: { quiet?: boolean } = {}): { code: number; out: string } {
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: opts.quiet ? "pipe" : "inherit", stderr: opts.quiet ? "pipe" : "inherit", env: process.env });
  return { code: p.exitCode ?? 1, out: opts.quiet ? (p.stdout?.toString() ?? "") : "" };
}
function must(cmd: string[], what: string) {
  if (run(cmd).code !== 0) fail(`${what} failed`);
}
async function fail(msg: string, alert = false): Promise<never> {
  console.error(`\n✗ RELEASE ABORTED: ${msg}`);
  if (alert) await alertFromEnv({ key: "release", severity: "warning", title: `Release problem: ${msg}` });
  process.exit(1);
}

async function railwayGql<T>(query: string): Promise<T> {
  const cfg = await Bun.file(`${process.env.HOME}/.railway/config.json`).json();
  const token = cfg.user?.accessToken ?? cfg.user?.token;
  const res = await fetch("https://backboard.railway.com/graphql/v2", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query }) });
  const j = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (j.errors?.length) throw new Error(j.errors.map((e) => e.message).join("; "));
  return j.data!;
}

function latestDeployments(): { id: string; status: string }[] {
  const { out } = run(["railway", "deployment", "list", "--service", SERVICE, "--json"], { quiet: true });
  try {
    const j = JSON.parse(out);
    return (Array.isArray(j) ? j : j.deployments ?? []).map((d: { id: string; status: string }) => ({ id: d.id, status: d.status }));
  } catch {
    return [];
  }
}

async function waitForVersion(version: string | null, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const h = (await (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) })).json()) as { version?: string };
      const ready = (await fetch(`${BASE}/ready`, { signal: AbortSignal.timeout(5000) })).status === 200;
      if (ready && (version === null || h.version === version)) return true;
    } catch {}
    const latest = latestDeployments()[0];
    if (latest && ["FAILED", "CRASHED"].includes(latest.status)) return false;
    await Bun.sleep(5000);
  }
  return false;
}

async function rollback(deploymentId: string) {
  step(`rolling back to deployment ${deploymentId}`);
  await railwayGql(`mutation { deploymentRollback(id: "${deploymentId}") }`);
  const ok = await waitForVersion(null, 6 * 60_000);
  console.log(ok ? "rollback is serving and ready" : "rollback did not become ready in time — check Railway now");
  return ok;
}

if (args.rollback) {
  const ok = await rollback(args.rollback);
  await alertFromEnv({ key: "release", severity: ok ? "warning" : "critical", title: ok ? "Manual rollback completed" : "Manual rollback did not become ready" });
  process.exit(ok ? 0 : 1);
}

// 1. Preconditions
step("preconditions");
if (run(["git", "status", "--porcelain"], { quiet: true }).out.trim()) await fail("working tree has uncommitted changes");
if (run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { quiet: true }).out.trim() !== "main") await fail("not on main");
run(["git", "fetch", "-q", "origin", "main"], { quiet: true });
const sha = run(["git", "rev-parse", "--short", "HEAD"], { quiet: true }).out.trim();
if (run(["git", "rev-parse", "HEAD"], { quiet: true }).out.trim() !== run(["git", "rev-parse", "origin/main"], { quiet: true }).out.trim()) await fail("HEAD is not pushed to origin/main");
console.log(`releasing ${sha}`);

// 2. Verify
step("verify: typecheck, tests with coverage gate, black-box smoke");
must(["bunx", "tsc", "--noEmit", "-p", "."], "typecheck");
must(["bun", "test", "--coverage"], "tests");
must(["bun", "scripts/smoke.ts"], "smoke");

// 3. Pre-deploy backup
step("pre-deploy backup");
if (args["skip-backup"]) console.log("skipped (--skip-backup): only safe when this release makes additive schema changes");
else {
  const res = await fetch(`${BASE}/admin/backup`, { method: "POST", headers: { "x-admin-secret": process.env.ADMIN_SECRET ?? "" } }).catch(() => null);
  const body = res ? ((await res.json().catch(() => ({}))) as { key?: string; integrity?: string; quotes?: number }) : {};
  if (!res || res.status !== 200 || body.integrity !== "ok") await fail(`pre-deploy backup failed (HTTP ${res?.status ?? "no response"})`);
  console.log(`snapshot ${body.key} (${body.quotes} quotes, integrity ok)`);
}

// 4. Drain
if (!args["skip-drain"]) {
  step("drain: waiting for in-progress calls to end");
  const agentId = process.env.ELEVENLABS_AGENT_ID ?? (await Bun.file(`${ROOT}agent/deployed.json`).json()).agent_id;
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversations?agent_id=${agentId}&page_size=30`, { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "" } }).catch(() => null);
    const list = res ? (((await res.json()) as { conversations?: { status: string }[] }).conversations ?? []) : [];
    const live = list.filter((c) => c.status === "in-progress" || c.status === "initiated").length;
    if (live === 0) break;
    if (Date.now() > deadline) await fail(`${live} call(s) still in progress after 10 minutes (use --skip-drain to force)`);
    console.log(`  ${live} call(s) in progress; waiting…`);
    await Bun.sleep(15_000);
  }
  console.log("no calls in progress");
}

// 5–6. Deploy
// What an automatic rollback restores, captured BEFORE anything deploys (incident: release 936ef62, 2026-10-20, failed a
// blocking eval after deploying and only printed the rollback command, leaving the new build live and untagged).
const deployedPath = `${ROOT}agent/deployed.json`;
const priorDeployed = (await Bun.file(deployedPath).json().catch(() => null)) as { git_sha?: string } | null;
const lastTag = run(["git", "describe", "--tags", "--abbrev=0", "--match", "release-*", "HEAD"], { quiet: true }).out.trim() || null;
const previousAgent = previousAgentRef(priorDeployed, lastTag);
console.log(`agent rollback target: ${previousAgent ? `${previousAgent.ref} (from ${previousAgent.source})` : "UNKNOWN (an agent rollback would need a manual redeploy)"}`);
let agentDeployed = false;
const deployAgent = () => {
  must(["bun", "agent/deploy.ts"], "agent deploy");
  agentDeployed = true;
};

// Redeploys the previous agent config. agent/deploy.ts is idempotent and builds everything (tools, prompt, voice) from
// agent/config.ts + policy/ at the checked-out commit, so running it from a throwaway git worktree at the previous commit
// restores what was live without touching this checkout. Returns a problem description, or null on success.
function redeployPreviousAgent(): string | null {
  if (!previousAgent) return "previous agent config unknown; redeploy it by hand with bun agent/deploy.ts from the last good commit";
  const commit = run(["git", "rev-parse", "--verify", `${previousAgent.ref}^{commit}`], { quiet: true }).out.trim();
  if (!commit) return `previous agent commit ${previousAgent.ref} is not in this clone`;
  const dir = `${tmpdir()}/quote-line-agent-rollback-${Date.now()}`;
  if (run(["git", "worktree", "add", "--detach", dir, commit], { quiet: true }).code !== 0) return `could not check out ${commit} for the agent rollback`;
  try {
    step(`redeploying the previous agent config from ${commit.slice(0, 7)}`);
    const p = Bun.spawnSync(["bun", "agent/deploy.ts"], { cwd: dir, stdout: "inherit", stderr: "inherit", env: process.env });
    if (p.exitCode !== 0) return `agent redeploy from ${commit.slice(0, 7)} failed`;
    // Keep this checkout's record truthful so the next release's rollback target is the agent that is actually live.
    // Deploys from commits before git_sha existed don't write it, so stamp it here.
    const record = JSON.parse(readFileSync(`${dir}/agent/deployed.json`, "utf8")) as { git_sha?: string };
    writeFileSync(deployedPath, JSON.stringify({ ...record, git_sha: record.git_sha ?? commit }, null, 2) + "\n");
    return null;
  } finally {
    run(["git", "worktree", "remove", "--force", dir], { quiet: true });
  }
}

// Agent first, then server: the contract test guarantees the previous agent works against the NEW server (that is how
// every server-first release runs), but nothing guarantees the new agent works against the OLD server.
async function rollbackRelease(reason: string): Promise<never> {
  console.error(`\n✗ ${reason}: rolling back automatically`);
  const problems: string[] = [];
  if (agentDeployed) {
    const p = redeployPreviousAgent();
    if (p) problems.push(p);
  }
  if (!previous) problems.push("no previous server deployment known; roll the server back in Railway by hand");
  else if (!(await rollback(previous.id))) problems.push(`server rollback to ${previous.id} did not become ready`);
  const outcome = problems.length
    ? `rollback INCOMPLETE: ${problems.join("; ")}`
    : `rolled back to deployment ${previous!.id}${agentDeployed ? ` and agent config ${previousAgent!.ref}` : ""}`;
  await alertFromEnv({ key: "release", severity: problems.length ? "critical" : "warning", title: `Release ${sha} rolled back: ${reason}`, detail: outcome });
  console.error(`\n✗ RELEASE ABORTED: ${reason}; ${outcome}`);
  process.exit(1);
}
if (args["agent-first"] && !args["no-agent"]) {
  step("agent deploy (first)");
  deployAgent();
}

step("server deploy");
const previous = latestDeployments().find((d) => d.status === "SUCCESS");
must(["railway", "variables", "--service", SERVICE, "--skip-deploys", "--set", `APP_VERSION=${sha}`], "set APP_VERSION");
must(["railway", "up", "--service", SERVICE, "--detach"], "railway up");
if (!(await waitForVersion(sha, 8 * 60_000))) {
  if (previous) await rollback(previous.id);
  await fail(`new version ${sha} did not become ready; rolled back to ${previous?.id ?? "nothing"}`, true);
}
console.log(`server ${sha} is live and ready`);

if (!args["agent-first"] && !args["no-agent"]) {
  step("agent deploy");
  deployAgent();
}

// 7. Production checks
step("canary");
if (run(["bun", "scripts/canary.ts"]).code !== 0) await rollbackRelease(`canary failed after deploying ${sha}`);

let watchedFailed: string[] = [];
if (!args["skip-evals"]) {
  // Gate design: the 4 long-stable tasks block at pass^1 = 1.0, exactly as before. price-objection and
  // license-callback are new and still depend on LLM behavior we haven't measured over enough runs, so a
  // single flaky trial on either must not roll back a good release. They run in the same single pass (no
  // extra credits for a second run) and a failure is reported loudly but does NOT block. Promote a task
  // into BLOCKING once it has passed on several consecutive releases.
  const BLOCKING = ["happy-path", "pa-happy-path", "human-request", "name-correction"];
  // tort-switch-requested (added 2026-10-20) covers the caller-requested tort switch 936ef62's policy re-reads the
  // trade-off for; it watches until it has a pass history like the others.
  const WATCHED = ["price-objection", "license-callback", "tort-switch-requested"];
  step(`eval smoke (${BLOCKING.length} blocking + ${WATCHED.length} watched tasks × 1)`);
  const evalPass = async (ids: string[]) => {
    must(["bun", "evals/run.ts", "--tasks", ids.join(","), "--trials", "1"], "eval run");
    const file = run(["sh", "-c", "ls -t evals/results/*.json | head -1"], { quiet: true }).out.trim();
    return { file, tasks: ((await Bun.file(`${ROOT}${file}`).json()) as { tasks: TaskResult[] }).tasks };
  };
  const { file: latest, tasks: firstResults } = await evalPass([...BLOCKING, ...WATCHED]);
  const failed = (ids: string[]) => failedTasks(firstResults, ids);
  // Watched failures used to be one console line in a long log: alert on them, keep a per-task pass history, repeat the
  // warning on the final line, and say when a task has earned promotion to BLOCKING (review 2026-10-16).
  const historyPath = `${ROOT}evals/results/watch-history.json`;
  const historyFile = Bun.file(historyPath);
  const prior = (await historyFile.exists()) ? ((await historyFile.json()) as WatchHistory) : {};
  const watched = recordWatched(prior, Object.fromEntries(WATCHED.map((id) => [id, !failed([id]).length])), new Date().toISOString(), sha);
  await Bun.write(historyPath, JSON.stringify(watched.history, null, 2) + "\n");
  watchedFailed = watched.failed;
  if (watchedFailed.length) {
    console.error(`\n!!! WATCHED EVAL FAILED (non-blocking): ${watchedFailed.join(", ")}; investigate before the next release; see ${latest}\n`);
    await alertFromEnv({ key: "release-watched-evals", severity: "warning", title: `Watched eval failed after releasing ${sha}: ${watchedFailed.join(", ")}`, detail: `See ${latest}` });
  }
  for (const id of watched.promote) console.log(`  ↑ ${id} passed ${PROMOTE_AFTER} releases in a row: consider promoting it to BLOCKING in scripts/release.ts`);
  let gate = evalGate(BLOCKING, firstResults);
  if (gate.action === "retry") {
    // One retry of ONLY the failing blocking tasks: 936ef62's failing trial never reached the server (start_quote was
    // never called) and passed 2/2 on rerun. A genuine regression fails again and rolls back.
    step(`blocking eval failed (${gate.failing.join(", ")}; see ${latest}); retrying just those once`);
    const retry = await evalPass(gate.failing);
    gate = evalGate(BLOCKING, firstResults, retry.tasks);
    if (gate.action === "rollback") await rollbackRelease(`blocking eval failed twice: ${gate.failing.join(", ")} (see ${latest} and ${retry.file})`);
    console.log(`  retry passed (${retry.file}); the first failure was a flake`);
  }
}

// 8. Tag
step("tag");
const tag = `release-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${sha}`;
must(["git", "tag", tag], "git tag");
must(["git", "push", "-q", "origin", tag], "push tag");
console.log(`\n✓ released ${sha} as ${tag}${watchedFailed.length ? ` (WARNING: watched eval failed: ${watchedFailed.join(", ")})` : ""}`);
